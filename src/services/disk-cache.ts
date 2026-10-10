/**
 * 磁盘缓存 —— 让 registry 元数据在 dsh 重启后依然可用
 *
 * 为什么需要：内存缓存在进程退出后全丢，每次重启 dsh 的首次「全系统」扫描
 * 都要重新拉 200+ 个包的 registry 元数据（本机实测约 31 秒）。
 * 落盘后首次扫描也能接近瞬时。
 *
 * ## 存储位置：`~/.dsh/npm-manager/cache/registry.json`
 *
 * 「DSH_HOME 下按插件名建目录」是既有约定，本机实测：
 *   - `~/.dsh/dsh-mcp-skill-panel/` → `state.json`（**持久配置**）+ `catalog.json`（可重建快照）
 *   - `~/.dsh/task-board/`         → `ledger-v2.json` / `scheduler-v2.json`（**纯持久状态**）
 * 即：约定成立，且已有"可重建快照"的先例。
 *
 * ⚠️ 但这里**特意多套一层 `cache/` 子目录**，而不是直接放 `~/.dsh/npm-manager/registry-cache.json`：
 *    `dsh-mcp-skill-panel` 把易失快照与持久配置混在同一层，用户若想"清掉缓存"
 *    很容易连配置一起删。用子目录把"这个目录整个可以删"做成结构性的、不用读文档就懂。
 *    将来若加持久配置（如 settings.json），它放在插件目录顶层，与 `cache/` 界限清晰。
 *
 * 可用 `DSH_HOME` 覆盖根目录；`config.diskCacheDir` 可整体覆盖。
 *
 * ## 设计要点
 *   - **任何失败都降级为"没有缓存"**，绝不因为缓存问题影响插件主流程
 *   - 写盘用「临时文件 + rename」的原子写法，避免半截文件
 *   - 落盘延迟合并（debounce），避免 200 次写入
 *   - 条目数上限 + 过期即丢，防止文件无限增长
 *   - 文件里带 `note` 字段，明示"可安全删除"
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface CacheEntry {
  value: unknown
  expiresAt: number
}

export interface DiskCacheOptions {
  /** 插件数据根目录；省略时按 DSH_HOME 推导。缓存实际落在它下面的 `cache/` */
  dir?: string
  /** 落盘延迟（毫秒），合并连续写入 */
  flushDelayMs?: number
  /** 最多保留多少条目（超出时丢最早过期的） */
  maxEntries?: number
  /** 文件体积上限（字节）；超过则整体丢弃重建 */
  maxBytes?: number
}

/** 写进缓存文件的说明字段 —— 让人打开文件就知道它能删 */
const FILE_NOTE = 'disposable cache; safe to delete (npm-manager will rebuild it)'

/** 算 value 序列化后的字节数，失败返回 0（让调用方按"小"处理） */
function safeByteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return 0 }
}

/** 解析 DSH_HOME（与 dshmarket 的 home-paths 规则一致：支持 `~/` 前缀） */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home = safeHomedir()): string {
  const raw = env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const v = raw.trim()
    if (v === '~') return home
    if (v.startsWith('~/') || v.startsWith('~\\')) return join(home, v.slice(2))
    return v
  }
  return join(home, '.dsh')
}

function safeHomedir(): string {
  try {
    return homedir()
  } catch {
    return '.'
  }
}

export class DiskCache {
  private file: string
  private dir: string
  private flushDelayMs: number
  private maxEntries: number
  private maxBytes: number
  private entries = new Map<string, CacheEntry>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private loaded = false
  private disabled = false
  /** 诊断用：最近一次落盘是否成功 */
  lastError: string | null = null

  constructor(opts: DiskCacheOptions = {}) {
    // 插件数据根目录 → 缓存落在它的 cache/ 子目录（见文件头说明）
    const root = opts.dir ?? join(resolveDshHome(), 'npm-manager')
    this.dir = join(root, 'cache')
    this.file = join(this.dir, 'registry.json')
    this.flushDelayMs = opts.flushDelayMs ?? 1200
    this.maxEntries = opts.maxEntries ?? 8000
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024
  }

  /** 缓存文件路径（诊断用） */
  get path(): string {
    return this.file
  }

  /** 缓存所在目录（整个目录都可安全删除） */
  get cacheDir(): string {
    return this.dir
  }

  get isDisabled(): boolean {
    return this.disabled
  }

  /** 读盘。任何异常都降级为空缓存（并标记 disabled，避免反复失败）。 */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.file)) return
      if (statSync(this.file).size > this.maxBytes) {
        this.dropFile()
        return
      }
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') return
      const now = Date.now()
      let dropped = 0
      for (const [k, v] of Object.entries(parsed.entries as Record<string, CacheEntry>)) {
        if (!v || typeof v !== 'object') continue
        if (typeof v.expiresAt !== 'number' || v.expiresAt <= now) { dropped++; continue }
        this.entries.set(k, { value: (v as CacheEntry).value, expiresAt: v.expiresAt })
      }
      if (dropped > 0) this.markDirty()
    } catch (e: any) {
      // 文件损坏 / 无权限 → 当作没有缓存，并禁用以避免每次操作都重试
      this.lastError = (e && e.message) ? e.message : String(e)
      this.entries.clear()
      this.disabled = true
    }
  }

  get(key: string): unknown | undefined {
    if (this.disabled) return undefined
    if (!this.loaded) this.load()
    const e = this.entries.get(key)
    if (e === undefined) return undefined
    if (e.expiresAt <= Date.now()) {
      this.entries.delete(key)
      this.markDirty()
      return undefined
    }
    return e.value
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (this.disabled) return
    if (!this.loaded) this.load()
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return
    // ⭐ 单条超 512KB 直接不入缓存 —— 防巨型包拖累整体（写入 + 读取都变慢）。
    const sz = safeByteLength(value)
    if (sz > 512 * 1024) return
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs })
    if (this.entries.size > this.maxEntries) this.evictOldest()
    this.markDirty()
  }

  size(): number {
    if (!this.loaded) this.load()
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.dropFile()
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  /** 立即落盘（dispose 时调用，避免丢最后一次写入） */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    if (this.disabled || this.entries.size === 0) return
    try {
      mkdirSync(this.dir, { recursive: true })
      // ⭐ 单条 entry 体积上限：npm 元数据膨胀很快（`eslint-plugin-react-hooks`
      //    单包就有 2790 个 versions，序列化 ~7.8MB）。整体只砍 1/4 在这种情况下
      //    会陷入"砍完再超 → 再砍"的死循环，最终只剩 1 条。
      //    改成：单条超 512KB 就跳过（这种巨型包对"是否过期"的判断收益有限），
      //    然后再按整体尺寸裁剪。set() 也做同样限制，所以正常路径
      //    进来时 entries 已经不含巨型包了，这里再扫一遍只是兜底（防旧文件 load 时绕过）。
      const MAX_SINGLE_BYTES = 512 * 1024
      const kept = new Map<string, CacheEntry>()
      for (const [k, v] of this.entries) {
        if (safeByteLength(v) > MAX_SINGLE_BYTES) {
          this.entries.delete(k)
          continue
        }
        kept.set(k, v)
      }

      const payload = JSON.stringify({
        note: FILE_NOTE,
        version: 1,
        savedAt: Date.now(),
        entries: Object.fromEntries(kept),
      })
      if (Buffer.byteLength(payload, 'utf8') > this.maxBytes) {
        this.evictOldestFrom(kept)
        return this.flush()
      }
      // 原子写：临时文件 + rename，避免半截 JSON
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, this.file)
      this.lastError = null
    } catch (e: any) {
      this.lastError = (e && e.message) ? e.message : String(e)
      // 落盘失败不影响内存缓存继续工作
    }
  }

  /* ── 内部 ── */

  private markDirty(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.flushDelayMs)
    // ⚠️ 不要 unref() —— 那会让进程空闲时（例：fetch 完成后没别的事）
    // 直接退出，缓存就丢了。这个缓存的目的是"跨进程存活"，落盘前退出 = 缓存失效。
  }

  private evictOldest(): void {
    this.evictOldestFrom(this.entries)
  }

  private evictOldestFrom(map: Map<string, CacheEntry>): void {
    const sorted = [...map.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    const drop = Math.max(1, Math.floor(sorted.length / 4))
    for (let i = 0; i < drop && i < sorted.length; i++) {
      map.delete(sorted[i][0])
      this.entries.delete(sorted[i][0])
    }
  }

  private dropFile(): void {
    try {
      if (existsSync(this.file)) unlinkSync(this.file)
    } catch {
      /* ignore */
    }
  }
}
