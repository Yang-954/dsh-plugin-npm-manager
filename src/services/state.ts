/**
 * Shared plugin state — scanner + registry + config + cache + 项目目录
 *
 * 工具 #1~#4 + 路由都共用这一个 state(避免重复创建 RegistryClient)
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative } from 'node:path'
import {
  scanPackages, normalizeScope, projectTitleOf, discoverNodeProjects, globalNodeModulesCandidates,
  type ProjectRef, type Scope,
} from './scanner.js'
import { RegistryClient, parseVersion, type ChangelogSection, type PackageMeta } from './registry.js'
import { DiskCache } from './disk-cache.js'
import { WRITABLE_SETTING_KEYS, CONFIG_KEYS, Config, readConfigValue } from '../config.js'

/** 带项目归属的包元数据（仅 system 范围填充 project/projectPath） */
export interface ScopedPackageMeta extends PackageMeta {
  project?: string
  projectPath?: string
}

/** 一个已知项目（发现到的 Node 项目 + 当前 cwd） */
export interface ProjectInfo {
  id: string
  title: string
  path: string
  /** 是否 dsh 进程当前工作目录 */
  isCurrent: boolean
  /** 目录当前是否存在 */
  exists: boolean
  /** 所属 DSH 工作区标题（cwd 自身没有则为 undefined） */
  workspace?: string
}

export interface PackageListResult {
  packages: ScopedPackageMeta[]
  totalCount: number
  outdatedCount: number
  scope: string
  /** system 范围实际扫描的项目数 */
  projectCount?: number
  packageNames: string[]
  /** 本次结果是否来自缓存（false = 刚刚真实扫描过） */
  cached?: boolean
  /** 这份数据实际扫描完成的时间戳（缓存命中时是原始扫描时间） */
  scannedAt?: number
  /** 解析失败（404/超时/限流）的包数 —— 数据不完整时如实报出去 */
  failedCount?: number
}

/** 一次扫描结果的缓存条目 */
interface ListCacheEntry {
  at: number
  result: PackageListResult
}

/**
 * 流式扫描事件（NDJSON / SSE 逐条推给前端）。
 *
 * 为什么要流式：全系统一次要解析 200+ 个包的 registry 元数据，耗时几十秒。
 * 等全部完成再返回会让界面长时间空着，用户以为宕机。分批推送可以让
 * 「识别到几个就先列几个」。
 */
export type StreamEvent =
  | { type: 'meta'; scope: string; total: number; projectCount?: number; cached: boolean }
  | { type: 'pkg'; package: ScopedPackageMeta }
  | { type: 'done'; totalCount: number; outdatedCount: number; projectCount?: number; cached: boolean; scannedAt: number }
  | { type: 'error'; error: string }

/**
 * registry 元数据解析的并发上限。
 *
 * ⚠️ 不能用 `Promise.all` 分批 —— 那样每批都要等**最慢**的那个成员，
 * 实测 9 个包一批会让首个结果等到 7 秒，等于没有渐进效果。
 * 这里改成"谁先解析完谁先入队"，配合并发上限控制压力。
 *
 * 取值的依据：本机实测吞吐随并发**次线性**增长（代理是瓶颈），
 * 且同一并发值重复测量差异极大（24 并发两次分别 3.8s / 40s）。
 * 这个环境下测不出稳定最优值，所以取一个折中的保守值：
 * 比 12 明显快，又不会对 registry 造成过大压力。
 * 真正的加速来自缓存（二次访问瞬时），而不是这个数字。
 */
const RESOLVE_CONCURRENCY = 16

export interface PackageDetailResult extends PackageMeta {
  changelog: ChangelogSection[]
}

export interface StateOptions {
  cwd: string
}

/** 归一化路径用于去重比较（Windows 大小写不敏感 + 去尾斜杠） */
function pathKey(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

export class State {
  config: any
  cwd: string
  registryClient: RegistryClient
  cacheInvalidatedAt: number
  /** DSH 工作区提供者 —— 由 apply 通过 ctx.inject(['workspaceRegistry']) 注入；缺失时降级为只有 cwd */
  private workspaceProvider: (() => ProjectRef[]) | null = null
  /** 磁盘缓存（registry 元数据跨进程存活）；未启用时为 null */
  diskCache: DiskCache | null
  /** 最近一次 workspaceProvider 抛出的错误（诊断用） */
  private workspaceError: string | null = null
  /** 诊断探针 */
  private serviceProbe: (() => string) | null = null
  private injectProbe: (() => { control: boolean; workspace: boolean }) | null = null
  /** settings 作用域（由 installSettingsPanel 注入）；null = 只读 */
  private settingsScope: any = null
  /**
   * settings 文档的当前 revision（0.2.1 乐观并发用）。
   *
   * `describe()` 返回它；`update(ns, patch, revision)` 要求传回。传错会抛
   * `SETTINGS_CONFLICT`，从而避免两个标签页互相覆盖。
   */
  settingsRevision: number | undefined = undefined
  /** listProjects() 的缓存（发现过程要遍历目录树） */
  private projectCache: { at: number; list: ProjectInfo[] } | null = null
  /**
   * listPackages() 的结果缓存，键为 `scope\0projectPath`。
   *
   * 目的：切换范围/项目/筛选时**不重新扫描**（全系统一次要扫 220 个包、
   * 每个都查 registry，实测要几十秒）。只在首次进入某个组合时扫一次，
   * 直到显式「刷新缓存」或 TTL 到期。
   */
  private listCache = new Map<string, ListCacheEntry>()
  /** 上次看到的配置值快照（用于检测 0.2.1 volatile 引用的原地更新） */
  private lastConfigSnapshot: Record<string, any> = {}
  /**
   * 缓存代数。
   *
   * 每次 {@link invalidate}（刷新按钮 / 配置变更）就 +1。扫描开始时记下当时的代数，
   * 结束前比对：不一致说明「扫描期间有人清了缓存」，这份结果不能再写回
   * （否则旧数据会被盖上新的 scannedAt 混进缓存）。
   */
  private cacheGeneration = 0

  constructor(config: any, opts: StateOptions) {
    this.config = config
    this.cwd = opts.cwd
    // 磁盘缓存：让 registry 元数据在 dsh 重启后依然可用
    // （否则每次重启的首次「全系统」扫描都要重新拉 200+ 个包，实测约 31 秒）
    const disk = this.createDiskCache()
    this.diskCache = disk
    this.registryClient = new RegistryClient({
      cacheTtlMs: this.cfg('registryCacheTtlMs'),
      githubToken: this.cfg('githubToken'),
      diskCache: disk,
      diskTtlMs: this.cfg('diskCacheTtlMs'),
      requestTimeoutMs: this.cfg('requestTimeoutMs'),
    })
    this.cacheInvalidatedAt = Date.now()
    this.lastConfigSnapshot = this.configValues()
  }

  /**
   * 读一项配置的**当前值**。
   *
   * ⚠️ 0.2.1 里标了 `.volatile()` 的字段是 `{ get() }` 引用，不是普通值。
   * 全类统一走这里，不要写 `this.config.x` —— 那拿到的是引用对象，
   * 会让 `scope === 'system'` 之类的比较全部失效（且不报错，最阴的一种）。
   */
  private cfg<T = any>(key: string): T {
    return readConfigValue<T>(this.config?.[key])
  }

  /**
   * 按当前 config 造一块磁盘缓存。
   *
   * 构造失败（目录不可建等）一律降级为 null（纯内存缓存），
   * 绝不让缓存问题影响插件主流程。
   */
  private createDiskCache(): DiskCache | null {
    if (this.cfg('diskCache') === false) return null
    try {
      const dir = this.cfg('diskCacheDir')
      return new DiskCache({
        dir: typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : undefined,
      })
    } catch {
      return null
    }
  }

  /**
   * 注入 DSH 工作区列表（服务缺失时不调用 → 自动降级）。
   *
   * 传 `null` 表示撤销（热重载时 effect 清理会调它）—— 不撤销的话
   * 旧闭包会一直指向已销毁的 sctx，重载后「全系统」范围会静默变空。
   */
  setWorkspaceProvider(fn: (() => ProjectRef[]) | null): void {
    this.workspaceProvider = fn
    this.projectCache = null // 换了提供者，作废已缓存的项目列表
  }

  /** 是否已拿到 workspaceRegistry（诊断用） */
  hasWorkspaceProvider(): boolean {
    return this.workspaceProvider !== null
  }

  /** 诊断探针：调用时直接看宿主 ctx 上有没有 workspaceRegistry */
  setServiceProbe(fn: () => string): void {
    this.serviceProbe = fn
  }

  /** 诊断探针：两个 inject 回调是否触发过 */
  setInjectProbe(fn: () => { control: boolean; workspace: boolean }): void {
    this.injectProbe = fn
  }

  /**
   * 注入 settings 作用域（由 installSettingsPanel 提供）。
   * 没有它时面板只能读配置、不能写。
   */
  setSettingsScope(scope: any): void {
    this.settingsScope = scope
  }

  /** 配置是否可在面板里编辑（诊断用） */
  get settingsWritable(): boolean {
    return this.settingsScope !== null
  }

  /**
   * 应用一组配置改动（0.2.1 契约）。
   *
   * - 只接受 {@link WRITABLE_SETTING_KEYS} 白名单内的 key（凭据类字段永远不可写）
   * - 值先由 schema 校验（{@link Config} 上的 min/max 是**服务端**约束，
   *   不只是前端渲染提示 —— 0.1.5 时代这里没有范围校验，能写进 0）
   * - 再走 `settings.update(ns, patch, revision)`：0.2.1 用 revision 做乐观并发，
   *   过期 revision 抛 `SETTINGS_CONFLICT`，避免两个标签页互相覆盖
   *
   * 写入成功后 volatile 引用会被 loader 原地更新，下次 {@link cfg} 读到的就是新值；
   * {@link syncConfig} 负责据此作废缓存（热生效，不重启）。
   */
  async applySettingsPatch(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    if (this.settingsScope === null) {
      return { ok: false, error: '设置作用域不可用（插件未完全加载或宿主无 settings 服务）' }
    }
    const clean: Record<string, unknown> = {}
    const rejected: string[] = []
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!WRITABLE_SETTING_KEYS.has(k)) { rejected.push(k); continue }
      clean[k] = v
    }
    if (rejected.length > 0) return { ok: false, error: `不接受的配置项：${rejected.join('、')}` }
    if (Object.keys(clean).length === 0) return { ok: false, error: '没有要修改的配置项' }

    // 先按 schema 校验范围：0.2.1 的 update 只校验类型/枚举，数字范围要靠 schema 自己带
    try {
      Config({ ...this.configValues(), ...clean })
    } catch (e: any) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) }
    }

    try {
      await this.settingsScope.update(clean)
      // update 只改引用；这里立刻同步一次，让缓存作废不等下一次请求
      this.syncConfig()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) }
    }
  }

  /** 当前配置的值快照（解引用后；用于比较与下发，**不要**拿它当长期配置） */
  configValues(): Record<string, any> {
    const out: Record<string, any> = {}
    for (const key of CONFIG_KEYS) out[key] = this.cfg(key)
    return out
  }

  /**
   * 检测 volatile 引用是否被改了，并按影响面作废缓存。
   *
   * 0.2.1 删掉了 `scope.watch`，改配置时 loader 直接把新值写进 volatile 引用
   * （`updateVolatile`），**不重启插件**。所以这里在每次读取前对比一次快照：
   * 变了就按影响面失效 —— 改「扫描深度」不该清 registry 缓存（否则要重拉 60 秒）。
   */
  syncConfig(): boolean {
    const prev = this.lastConfigSnapshot
    const next = this.configValues()
    let changed = false
    for (const key of CONFIG_KEYS) {
      if (prev[key] !== next[key]) { changed = true; break }
    }
    if (!changed) return false
    this.lastConfigSnapshot = next

    // 结果缓存与项目发现缓存**总是**作废 —— 它们直接依赖配置
    this.cacheGeneration++
    this.cacheInvalidatedAt = Date.now()
    this.projectCache = null
    this.listCache.clear()

    const diskAffecting = ['diskCache', 'diskCacheDir', 'diskCacheTtlMs']
    const diskChanged = diskAffecting.some((k) => prev[k] !== next[k])
    const registryAffecting = ['registryCacheTtlMs', ...diskAffecting]
    const registryChanged = registryAffecting.some((k) => prev[k] !== next[k])

    // 先热重建磁盘缓存（内部会 flush 旧的那块），再决定要不要清 registry 内存缓存
    if (diskChanged) this.rebuildDiskCache()

    if (registryChanged) {
      try {
        this.registryClient.clearCache()
      } catch {
        /* ignore */
      }
    }
    return true
  }

  /**
   * 兼容旧调用点（settings 面板装好后会先调一次）。
   * 现在没有 `watch` 了，等价于「强制同步一次」。
   */
  updateConfig(_next?: any): void {
    this.syncConfig()
  }

  /** 诊断快照 */
  probeSnapshot(): { serviceType: string | null; inject: { control: boolean; workspace: boolean } | null } {
    let serviceType: string | null = null
    let inject: { control: boolean; workspace: boolean } | null = null
    try { serviceType = this.serviceProbe ? this.serviceProbe() : null } catch { serviceType = null }
    try { inject = this.injectProbe ? this.injectProbe() : null } catch { inject = null }
    return { serviceType, inject }
  }

  /** 最近一次 workspaceProvider 抛出的错误（诊断用；正常为 null） */
  get lastWorkspaceError(): string | null {
    return this.workspaceError
  }

  /**
   * 按当前 config 重建磁盘缓存并换给 registry 客户端。
   *
   * 换之前**先把旧块 flush** —— 它可能还有 debounce 里没落盘的条目。
   * 刻意**不删旧目录**：用户可能只是临时切一下，切回来还能用。
   */
  private rebuildDiskCache(): void {
    const old = this.diskCache
    if (old !== null) {
      try { old.flush() } catch { /* ignore */ }
    }
    const next = this.createDiskCache()
    this.diskCache = next
    try {
      this.registryClient.setDiskCache(next, this.cfg<number>('diskCacheTtlMs'))
    } catch {
      /* ignore */
    }
  }

  /**
   * 清空全部缓存。
   *
   * ⚠️ 三处都要清：结果缓存、项目发现缓存、registry 元数据缓存。
   * 只清前两个的话「刷新缓存」按钮是假的 —— registry 那边 TTL 没到就仍返回旧值。
   */
  invalidate(): void {
    this.cacheInvalidatedAt = Date.now()
    // 代数 +1：在途扫描结束时会发现代数变了，从而放弃写回缓存
    this.cacheGeneration++
    this.projectCache = null
    this.listCache.clear()
    try {
      this.registryClient.clearCache()
    } catch {
      /* ignore */
    }
  }

  /** 当前结果缓存条目数（诊断/测试用） */
  listCacheSize(): number {
    return this.listCache.size
  }

  /**
   * 插件卸载/重载时调用：把磁盘缓存落盘。
   * 不落盘会丢掉最后一批写入（debounce 还没到点就退出了）。
   */
  dispose(): void {
    try {
      this.registryClient.flushDiskCache()
    } catch {
      /* 落盘失败不影响卸载 */
    }
  }

  /** 结果缓存的有效期；配置为 0 或负数时用默认 30 分钟 */
  private listCacheTtlMs(): number {
    const v = this.cfg<number>('listCacheTtlMs')
    return typeof v === 'number' && v > 0 ? v : 1_800_000
  }

  /**
   * 所有已知项目。
   *
   * 当前 cwd 永远排第一；其后是**每个 DSH 工作区里发现到的 Node 项目**。
   *
   * ⚠️ 不是直接用工作区根目录 —— 工作区往往是"容器目录"（如 `web插件`、
   * `day05`），根下没有 package.json，真正的项目在子目录里。只列工作区根
   * 会让「全系统」几乎扫不到东西。
   *
   * 结果按 `cacheInvalidatedAt` 缓存（发现过程要遍历目录树）。
   */
  listProjects(): ProjectInfo[] {
    if (this.projectCache !== null && this.projectCache.at >= this.cacheInvalidatedAt) {
      return this.projectCache.list
    }

    const out: ProjectInfo[] = []
    const seen = new Set<string>()

    const push = (path: string, title: string, isCurrent: boolean, workspace?: string) => {
      if (!path) return
      const key = pathKey(path)
      if (seen.has(key)) return
      seen.add(key)
      const info: ProjectInfo = {
        id: isCurrent ? 'current' : path,
        title: title || projectTitleOf(path),
        path,
        isCurrent,
        exists: existsSync(path),
      }
      if (workspace !== undefined) info.workspace = workspace
      out.push(info)
    }

    push(this.cwd, projectTitleOf(this.cwd), true)

    let workspaces: ProjectRef[] = []
    try {
      workspaces = this.workspaceProvider?.() ?? []
      this.workspaceError = null
    } catch (e: any) {
      // ⚠️ 不要静默吞掉 —— 之前就是这样导致"全系统只剩当前项目"却毫无线索。
      //    记录原因并暴露到 /settings 供诊断；行为上仍降级为只有 cwd。
      this.workspaceError = (e && e.message) ? e.message : String(e)
      workspaces = []
    }

    for (const w of workspaces) {
      if (!w.path) continue
      const found = discoverNodeProjects(w.path, { maxDepth: this.cfg<number>('projectScanDepth') ?? 3 })
      for (const dir of found) {
        const rel = relative(w.path, dir).replace(/\\/g, '/')
        const title = rel === '' ? (w.title || projectTitleOf(dir)) : `${w.title || projectTitleOf(w.path)}/${rel}`
        push(dir, title, false, w.title || projectTitleOf(w.path))
      }
    }

    this.projectCache = { at: Date.now(), list: out }
    return out
  }

  /** 解析单个已安装包的元数据，并补上项目归属 */
  private async resolveOne(p: { name: string; currentVersion: string; project?: string; projectPath?: string }): Promise<ScopedPackageMeta | null> {
    try {
      const meta = await this.registryClient.getPackageMeta(p.name, p.currentVersion)
      if (!meta) return null
      const scoped: ScopedPackageMeta = { ...meta }
      if (p.project !== undefined) scoped.project = p.project
      if (p.projectPath !== undefined) scoped.projectPath = p.projectPath
      return scoped
    } catch {
      return null
    }
  }

  /** 计算某个 scope 要扫的项目列表（仅 system 范围非空） */
  private projectsFor(scope: Scope): ProjectRef[] | undefined {
    if (scope !== 'system') return undefined
    return this.listProjects()
      .filter((p) => p.exists)
      .map((p) => ({ id: p.id, title: p.title, path: p.path }))
  }

  /** 归一化显式 project 参数 */
  /**
   * 归一化显式 project 参数。
   *
   * ⚠️ 旧版只 `trim()` 就放行 —— `?project=C:\任意目录` 能读任意目录的 package.json，
   * 而且 `system` 范围下这个参数其实被忽略，却仍然参与缓存键，导致同一份系统数据
   * 被不同字符串反复全量重扫、缓存键无界增长。
   *
   * 现在的约束：
   * - 只接受**绝对路径**（相对路径在不同 cwd 下含义不同，缓存键会互相污染）
   * - 必须是已存在的目录，且目录下有 `package.json`（否则扫出来必然是空，属于误用）
   * - `system` 范围直接丢弃该参数（它本来就按「所有已知项目」扫）
   */
  private explicitProject(projectPath: string | undefined, scope: Scope): string | undefined {
    if (scope === 'system') return undefined
    if (typeof projectPath !== 'string') return undefined
    const raw = projectPath.trim()
    if (raw === '') return undefined
    if (!isAbsolute(raw)) return undefined
    const normalized = normalize(raw)
    try {
      if (!existsSync(normalized) || !statSync(normalized).isDirectory()) return undefined
      if (!existsSync(join(normalized, 'package.json'))) return undefined
    } catch {
      return undefined
    }
    return normalized
  }

  /** 缓存键 */
  private keyOf(scope: Scope, explicit?: string): string {
    return scope + '\u0000' + (explicit ?? '')
  }

  /** 取缓存命中（未过期时） */
  private cacheHit(key: string): PackageListResult | null {
    const hit = this.listCache.get(key)
    if (hit === undefined) return null
    if (Date.now() - hit.at >= this.listCacheTtlMs()) return null
    return hit.result
  }

  /** 写入结果缓存 */
  private cachePut(key: string, result: PackageListResult, at: number): void {
    this.listCache.set(key, { at, result })
  }

  /**
   * 流式列出包 —— 「识别到几个就先推几个」。
   *
   * 分三阶段推事件：
   *   meta → 立刻告诉前端"这次要扫多少"，前端可显示 0/N 进度
   *   pkg  → 每解析好一批就推一批（RESOLVE_BATCH 个并发）
   *   done → 收尾统计，同时把结果写进缓存
   *
   * 缓存命中时把缓存内容一次性推完（前端几乎瞬时看到完整列表）。
   */
  async *streamPackages(scope?: string, projectPath?: string): AsyncGenerator<StreamEvent> {
    this.syncConfig()
    const effectiveScope: Scope = normalizeScope(scope ?? this.cfg<string>('scope'))
    const explicit = this.explicitProject(projectPath, effectiveScope)
    const key = this.keyOf(effectiveScope, explicit)

    // ── 缓存命中：直接吐出来 ──
    const hit = this.cacheHit(key)
    if (hit !== null) {
      yield { type: 'meta', scope: effectiveScope, total: hit.totalCount, projectCount: hit.projectCount, cached: true }
      for (const p of hit.packages) yield { type: 'pkg', package: p }
      yield {
        type: 'done',
        totalCount: hit.totalCount,
        outdatedCount: hit.outdatedCount,
        projectCount: hit.projectCount,
        cached: true,
        scannedAt: hit.scannedAt ?? Date.now(),
      }
      return
    }

    const projects = this.projectsFor(effectiveScope)
    const installed = scanPackages(effectiveScope, true, {
      cwd: this.cwd,
      projectPath: explicit,
      projects,
    })

    // 先告诉前端总量 —— 这样进度条一开始就有分母，不会显得"卡住"
    yield { type: 'meta', scope: effectiveScope, total: installed.length, projectCount: projects?.length, cached: false }

    const packages: ScopedPackageMeta[] = []
    // 记下扫描开始时的缓存代数：结束前若有人刷新缓存，这份结果就不写回
    const generation = this.cacheGeneration

    // ── 完成即推送：N 个 worker 并发解析，谁先完成谁先进队 ──
    // （用 Promise.all 分批会让每批都等最慢的那个，首个结果可能等到好几秒）
    const queue: ScopedPackageMeta[] = []
    let cursor = 0
    let settled = 0
    let wake: (() => void) | null = null
    const kick = () => { if (wake !== null) { const w = wake; wake = null; w() } }

    const worker = async (): Promise<void> => {
      while (cursor < installed.length) {
        // 缓存被清了（用户点了刷新）→ 立刻停止打网络，别再白烧请求
        if (generation !== this.cacheGeneration) { settled = installed.length; kick(); return }
        const p = installed[cursor++]
        const m = await this.resolveOne(p)
        settled++
        if (m !== null) queue.push(m)
        kick()
      }
    }

    const workerCount = Math.min(RESOLVE_CONCURRENCY, installed.length)
    const workers = Array.from({ length: workerCount }, () => worker())

    try {
      while (settled < installed.length || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        const item = queue.shift() as ScopedPackageMeta
        packages.push(item)
        yield { type: 'pkg', package: item }
      }
      await Promise.all(workers)
    } finally {
      // ⚠️ 不管 stream 是走完还是提前断开（连接关掉），都要尝试把已解析的写盘。
      //    注意：这里只能拿到 worker 已提交到 queue 的部分 —— 流异常时也可能不全，
      //    但比完全丢好得多。
      try { this.diskCache?.flush() } catch { /* ignore */ }
    }

    const scannedAt = Date.now()
    const failed = installed.length - packages.length
    const result: PackageListResult = {
      packages,
      totalCount: packages.length,
      outdatedCount: packages.filter((p) => p.isOutdated).length,
      scope: effectiveScope,
      packageNames: [...new Set(packages.map((p) => p.name))],
      cached: false,
      scannedAt,
    }
    // 失败项如实报出去（旧版静默丢弃，进度条分母对不上却毫无提示）
    if (failed > 0) result.failedCount = failed
    if (projects !== undefined) result.projectCount = projects.length
    // 只有代数没变（期间没被刷新）才写回缓存
    if (generation === this.cacheGeneration) this.cachePut(key, result, scannedAt)
    // ⚠️ 显式落盘 —— debounce 期间 stream 持续触发 set，timer 一直被推迟，
    //    可能直到 stream 结束都不会自动 flush。这里强制 flush 保证全部 220 个包
    //    都写到磁盘；下一进程冷启动就能拿到。
    try { this.diskCache?.flush() } catch { /* ignore */ }

    yield {
      type: 'done',
      totalCount: result.totalCount,
      outdatedCount: result.outdatedCount,
      projectCount: result.projectCount,
      cached: false,
      scannedAt,
    }
  }

  /**
   * 列出包(工具 #1 + 路由 GET /packages 共用)。
   *
   * 缓存优先：同一 `(scope, projectPath)` 组合在 TTL 内直接返回上次结果，
   * 不重新扫盘、不重新查 registry。切范围/切项目因此是瞬时的。
   * 需要真正刷新时调用 {@link invalidate}（「刷新缓存」按钮 / 配置变更）。
   */
  async listPackages(scope?: string, projectPath?: string): Promise<PackageListResult> {
    this.syncConfig()
    const effectiveScope: Scope = normalizeScope(scope ?? this.cfg<string>('scope'))
    const explicit = this.explicitProject(projectPath, effectiveScope)
    const key = this.keyOf(effectiveScope, explicit)

    const hit = this.cacheHit(key)
    if (hit !== null) {
      // 只翻 cached 标记，scannedAt 保持原始扫描时间
      return { ...hit, cached: true }
    }

    const projects = this.projectsFor(effectiveScope)
    const installed = scanPackages(effectiveScope, true, {
      cwd: this.cwd,
      projectPath: explicit,
      projects,
    })

    // ⚠️ 并发上限：旧版这里 `Promise.all(installed.map(...))` 会一次打 220~300 个
    // registry 请求（流式路径反而是 16 并发），既容易被限流也让首个结果等到最慢的那个。
    // 现在复用同一个 RESOLVE_CONCURRENCY 池。
    const generation = this.cacheGeneration
    const results = await this.resolveAll(installed, generation)

    const packages = results.filter((m): m is ScopedPackageMeta => m !== null)
    const failed = installed.length - packages.length
    const scannedAt = Date.now()

    const result: PackageListResult = {
      packages,
      totalCount: packages.length,
      outdatedCount: packages.filter((p) => p.isOutdated).length,
      scope: effectiveScope,
      packageNames: [...new Set(packages.map((p) => p.name))],
      cached: false,
      scannedAt,
    }
    // 失败项不再是「静默消失」：把数量报出去，前端/工具能看出数据不完整
    if (failed > 0) result.failedCount = failed
    if (projects !== undefined) result.projectCount = projects.length

    // ⚠️ 失效竞态：扫描期间用户点了「刷新缓存」的话，这份数据已经是旧的，
    // 不能再写回缓存并盖上新的 scannedAt（旧版就是这么把旧数据「洗白」的）。
    if (generation === this.cacheGeneration) this.cachePut(key, result, scannedAt)
    return result
  }

  /**
   * 用固定并发池解析全部包。
   *
   * @param generation 扫描开始时的缓存代数；与当前不一致时提前放弃剩余工作
   */
  private async resolveAll(
    installed: Array<{ name: string; currentVersion: string; project?: string; projectPath?: string }>,
    generation: number,
  ): Promise<Array<ScopedPackageMeta | null>> {
    const out: Array<ScopedPackageMeta | null> = new Array(installed.length).fill(null)
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < installed.length) {
        if (generation !== this.cacheGeneration) return // 已失效，别再打网络
        const index = cursor++
        out[index] = await this.resolveOne(installed[index])
      }
    }
    const workers = Array.from(
      { length: Math.min(RESOLVE_CONCURRENCY, Math.max(1, installed.length)) },
      () => worker(),
    )
    await Promise.all(workers)
    return out
  }

  /** 单包详情(工具 #2 + 路由 GET /packages/:name 共用) */
  async getPackageDetail(name: string, currentVersion: string): Promise<PackageDetailResult | null> {
    const meta = await this.registryClient.getPackageMeta(name, currentVersion)
    if (!meta) return null
    let changelog: ChangelogSection[] = []
    if (this.cfg('enableChangelog')) {
      // 仓库地址从 meta 传入 —— 完整 packument 刻意不缓存，这里不能再拉一次
      try {
        changelog = await this.registryClient.getChangelog(name, meta.repository)
      } catch {
        /* changelog 拉不到不影响详情本身 */
      }
    }
    return { ...meta, changelog }
  }

  /**
   * 推断某个包在本机的已装版本。
   *
   * 优先级：项目 `node_modules/<pkg>/package.json` → 项目 `package.json` 里的声明
   * （剥掉 range 前缀）→ 全局 `node_modules` → 都没有则返回 `undefined`。
   *
   * 存在意义：`npm_get_package_info` 的 `currentVersion` 是可选的，旧版声称
   * 「自动从 node_modules 推断」但实际 default 成 `'0.0.0'` —— 于是任何包都
   * 显示成「过期」，用户会被误导。
   */
  async inferInstalledVersion(name: string): Promise<string | undefined> {
    const clean = String(name ?? '').trim()
    if (clean === '') return undefined

    // 1) 本项目 node_modules 里的真实版本
    try {
      const installed = join(this.cwd, 'node_modules', clean, 'package.json')
      if (existsSync(installed)) {
        const pkg = JSON.parse(readFileSync(installed, 'utf8')) as { version?: string }
        if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
      }
    } catch {
      /* 读不到就继续往下试 */
    }

    // 2) 本项目 package.json 的声明（`^18.2.0` → `18.2.0`）
    try {
      const declared = join(this.cwd, 'package.json')
      if (existsSync(declared)) {
        const pkg = JSON.parse(readFileSync(declared, 'utf8')) as Record<string, any>
        for (const sec of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          const v = pkg?.[sec]?.[clean]
          if (typeof v === 'string' && v.trim() !== '') {
            const parsed = parseVersion(v)
            if (parsed !== null) return parsed.join('.')
            return undefined // workspace:* / file: 这类不可比，不假装知道版本
          }
        }
      }
    } catch {
      /* ignore */
    }

    // 3) 全局 node_modules
    try {
      for (const candidate of globalNodeModulesCandidates()) {
        const installed = join(candidate, clean, 'package.json')
        if (existsSync(installed)) {
          const pkg = JSON.parse(readFileSync(installed, 'utf8')) as { version?: string }
          if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
        }
      }
    } catch {
      /* ignore */
    }

    return undefined
  }
}
