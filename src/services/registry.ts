/**
 * Npm registry fetcher + cache + semver compare
 *
 * 用 Node 22+ / 浏览器都有的 globalThis.fetch
 * 错误消息经过 sanitize(§安全教训: 不把 URL 凭据 / Bearer token 泄露给模型)
 */

import { readFileSync } from 'node:fs'
import { DiskCache } from './disk-cache.js'

/**
 * 出站请求的 User-Agent。
 *
 * ⚠️ 别再手写 `0.6.0` 这种字面量 —— 版本已经走到 0.7.x，硬编码只会
 * 让上游看到的客户端版本永远过时（且没有任何地方会因此报错）。
 * 这里跟随 package.json 的版本；读不到就退回不带版本号的安全值。
 */
function resolveUserAgent(): string {
  try {
    // 构建产物在 lib/services/ 下，package.json 在仓库根 → ../../package.json
    const url = new URL('../../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { name?: string; version?: string }
    const name = pkg.name ?? 'dsh-plugin-npm-manager'
    const version = pkg.version ?? 'unknown'
    return `${name}/${version}`
  } catch {
    return 'dsh-plugin-npm-manager'
  }
}

const USER_AGENT = resolveUserAgent()

export interface PackageMeta {
  name: string
  latestVersion: string
  currentVersion: string
  description: string
  homepage?: string
  repository?: string
  isOutdated: boolean
  updateType: 'major' | 'minor' | 'patch' | 'same' | 'downgrade' | 'unknown'
}

export interface ChangelogSection {
  version: string
  date?: string
  notes: string
  source: 'github-releases' | 'changelog-md' | 'none'
}

interface RegistryPackageData {
  name: string
  description?: string
  'dist-tags'?: { latest?: string }
  homepage?: string
  repository?: { url?: string }
}

interface CacheEntry {
  value: unknown
  expiresAt: number
}

interface FetchOpts {
  signal?: AbortSignal
  cacheTtlMs?: number
}

/**
 * 精简后的包元数据 —— **唯一会落盘的东西**。
 *
 * 单条约 300 字节；而完整 packument 平均约 1MB（实测 `react` 6.8MB、
 * `axios` 775KB、`semver` 240KB）。缓存完整 packument 会把磁盘缓存冲垮。
 */
export interface SlimPackageMeta {
  name: string
  latest: string
  description: string
  homepage?: string
  repository?: string
}

/** 从完整 packument 提取精简投影 */
function slimOf(data: RegistryPackageData, fallbackVersion: string): SlimPackageMeta {
  const slim: SlimPackageMeta = {
    name: data.name,
    latest: data['dist-tags']?.latest ?? fallbackVersion,
    description: data.description ?? '',
  }
  if (data.homepage !== undefined) slim.homepage = data.homepage
  const repoUrl = data.repository?.url
  if (repoUrl !== undefined) slim.repository = repoUrl
  return slim
}

/** 精简投影 → PackageMeta（按调用方给的 currentVersion 计算是否过期） */
function toPackageMeta(slim: SlimPackageMeta, currentVersion: string): PackageMeta {
  const latest = slim.latest || currentVersion
  return {
    name: slim.name,
    latestVersion: latest,
    currentVersion,
    description: slim.description ?? '',
    homepage: slim.homepage,
    repository: slim.repository,
    // 不可比（workspace:* / * / file: ...）时不算「过期」——
    // 硬判成过期会让每个 monorepo 包都亮黄徽章，属于假警报
    isOutdated: (cmpVersion(currentVersion, latest) ?? 0) < 0,
    updateType: detectUpdateType(currentVersion, latest),
  }
}

/** 超时句柄：signal 到点 abort；cancel() 清理定时器 */
interface TimeoutHandle {
  signal: AbortSignal
  cancel(): void
}

/**
 * 生成一个 `ms` 毫秒后 abort 的 signal。
 * 优先用 `AbortSignal.timeout`（Node 18+），否则手工用 AbortController + 定时器。
 */
function makeTimeoutSignal(ms: number): TimeoutHandle {
  const anyAbort = AbortSignal as any
  if (typeof anyAbort?.timeout === 'function') {
    return { signal: anyAbort.timeout(ms) as AbortSignal, cancel: () => {} }
  }
  const c = new AbortController()
  const timer = setTimeout(() => c.abort(new Error(`request timeout after ${ms}ms`)), ms)
  return { signal: c.signal, cancel: () => clearTimeout(timer) }
}

/** 合并多个 signal —— 任一 abort 即整体 abort。没有 `AbortSignal.any` 时手工组合。 */function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => s !== undefined)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  const anyAbort = AbortSignal as any
  if (typeof anyAbort?.any === 'function') return anyAbort.any(list) as AbortSignal
  const c = new AbortController()
  for (const s of list) {
    if (s.aborted) { c.abort(s.reason); break }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true })
  }
  return c.signal
}

/** 清理可能含敏感凭据的错误消息(token-leak 教训: 错误消息即用户接口) */
function sanitizeError(msg: string): string {
  if (!msg) return ''
  return msg
    .replace(/Bearer[\s_-]+[A-Za-z0-9._\-]+/g, 'Bearer ***')
    .replace(/_?authToken[=:]\s*[A-Za-z0-9._\-]+/gi, 'authToken=***')
    .replace(/(\b|^|\s)token[=:]\s*[A-Za-z0-9._\-]+/gi, '$1token=***')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic ***')
    .replace(/([a-z]+:\/\/)[^@\/\s]+:[^@\/\s]+@/gi, '$1***:***@')
}

/**
 * 解析一个版本字符串为 `[major, minor, patch]`。
 *
 * ⚠️ 必须**同时**处理三类输入，否则判定会静默错：
 *   - semver range 前缀：`^18.2.0` / `~2.1.0` / `>=1.2.3` / `1.2.x`
 *   - 非版本协议：`workspace:*` / `*` / `latest` / `file:...` / `link:...` / `npm:foo@1.2.3`
 *   - 预发布尾巴：`2.0.0-beta.1`
 *
 * 非版本输入返回 `null`，调用方据此给「不可比」而不是硬判成 0.0.0
 * （旧实现把 `workspace:*` 当 0.0.0，于是每个 monorepo 包都被判成 major）。
 */
export function parseVersion(raw: string): [number, number, number] | null {
  const s = String(raw ?? '').trim()
  if (s === '') return null

  // 非版本协议 / 通配：一律不可比
  if (/^[a-z]+:/i.test(s)) return null                 // workspace: / file: / link: / npm:
  if (/^[*x]$/i.test(s) || s === 'latest' || s === 'next' || s === 'beta') return null

  // 剥掉 range 前缀与 npm 别名（`npm:foo@1.2.3` 已在上面拦掉）
  let body = s.replace(/^[\^~>=<v]+/, '').trim()
  // 去掉 `>=1.2.3 <2.0.0` 这类复合 range 的后半段
  body = body.split(/\s+/)[0] ?? ''
  // 去掉预发布 / build 尾巴：`2.0.0-beta.1` → `2.0.0`
  body = body.split(/[-+]/)[0] ?? ''

  const parts = body.split('.')
  if (parts.length === 0) return null
  const nums: number[] = []
  for (let i = 0; i < 3; i++) {
    const p = parts[i]
    // `x` / `*` 作为占位（`1.x`、`1.2.x`）视为 0，但至少 major 要能解析
    if (p === undefined) { nums.push(0); continue }
    if (p === 'x' || p === 'X' || p === '*') { nums.push(0); continue }
    const n = parseInt(p, 10)
    if (!Number.isFinite(n)) return null
    nums.push(n)
  }
  // 至少 major 段要是真数字，否则不是版本
  const majorRaw = parts[0]
  if (majorRaw === undefined || !Number.isFinite(parseInt(majorRaw, 10))) return null
  return [nums[0], nums[1], nums[2]]
}

/** semver 比较的最小实现(避免引入 semver 包依赖)；不可比时返回 null */
function cmpVersion(a: string, b: string): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null || pb === null) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

export type UpdateType = 'major' | 'minor' | 'patch' | 'same' | 'downgrade' | 'unknown'

/**
 * 判定升级类型。
 *
 * ⚠️ 旧实现只剥 `^~` 给了 `cmpVersion`，却在下面重新 `split('.')` 原始字符串，
 * 于是 `'^18'` → `NaN` → `0` → 所有 caret 依赖的 minor/patch 升级都被判成 major。
 * 现在两处共用 {@link parseVersion}，并且不可比时返回 `'unknown'` 而不是瞎猜。
 */
export function detectUpdateType(current: string, latest: string): UpdateType {
  const pc = parseVersion(current)
  const pl = parseVersion(latest)
  // 任一侧不是可比版本（workspace:* / * / file: ...）→ 明确报 unknown，
  // 让 UI 显示「不可比」，而不是假装它是大版本升级。
  if (pc === null || pl === null) return 'unknown'

  const c = cmpVersion(current, latest)
  if (c === 0) return 'same'
  if (c !== null && c > 0) return 'downgrade'  // current 比 latest 新 → 罕见但可能(npm 撤回发布)

  if (pc[0] < pl[0]) return 'major'
  if (pc[1] < pl[1]) return 'minor'
  return 'patch'
}

export class RegistryClient {
  private base = 'https://registry.npmjs.org'
  private cache = new Map<string, CacheEntry>()
  private defaultTtlMs = 300_000
  private githubToken?: string
  /** 可选的磁盘缓存层：让元数据在 dsh 重启后依然可用 */
  private disk: DiskCache | null
  /** 写盘时用的 TTL —— 比内存 TTL 长得多（元数据变化慢） */
  private diskTtlMs: number
  /** 单次 registry 请求的超时（毫秒）—— 没有它，网络半死会让整次扫描永久挂起 */
  private requestTimeoutMs: number

  constructor(opts: {
    cacheTtlMs?: number
    githubToken?: string
    diskCache?: DiskCache | null
    diskTtlMs?: number
    requestTimeoutMs?: number
  } = {}) {
    if (opts.cacheTtlMs !== undefined) this.defaultTtlMs = opts.cacheTtlMs
    this.githubToken = opts.githubToken
    this.disk = opts.diskCache ?? null
    this.diskTtlMs = opts.diskTtlMs ?? 86_400_000
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000
  }

  /**
   * 拉一个 URL 并解析 JSON。
   *
   * ⚠️⚠️ **必须带超时**。裸 `fetch` 在网络半死（连接建立但不返回）时会永远挂着，
   * 而流式扫描里任何一个不 settle 的 Promise 都会让 worker 永不结束
   * → generator 永不产出 `done` 帧 → 前端"一直转圈圈"。
   * 这是实测踩到的故障：registry 延迟从 0.5s 涨到 2~3.5s 后，
   * 偶发的挂起会让整次扫描彻底卡死。
   */
  /**
   * 带超时与重试的请求（JSON 或文本）。
   *
   * ⚠️⚠️ **必须带超时**。裸 `fetch` 在网络半死（连接建立但不返回）时会永远挂着，
   * 而流式扫描里任何一个不 settle 的 Promise 都会让 worker 永不结束
   * → generator 永不产出 `done` 帧 → 前端"一直转圈圈"。
   * 这是实测踩到的故障：registry 延迟从 0.5s 涨到 2~3.5s 后，
   * 偶发的挂起会让整次扫描彻底卡死。
   */
  private async fetchWithTimeout(url: string, headers: Record<string, string>, as: 'json' | 'text', signal?: AbortSignal): Promise<any> {
    const timeoutMs = this.requestTimeoutMs
    let lastErr: any = null
    // 超时重试 1 次：网络抖动导致的失败不该让这个请求直接消失
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = makeTimeoutSignal(timeoutMs)
      const combined = combineSignals([signal, t.signal])
      try {
        const res = await fetch(url, { signal: combined, headers })
        if (!res.ok) throw new Error(sanitizeError(`fetch failed: ${res.status}`))
        return as === 'json' ? await res.json() : await res.text()
      } catch (e: any) {
        lastErr = e
        // 调用方主动取消 → 不重试
        if (signal?.aborted) throw e
        // 超时 / 网络错误 → 重试一次
        if (attempt === 0) continue
      } finally {
        t.cancel()
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private async fetchJson(url: string, signal?: AbortSignal): Promise<RegistryPackageData> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': USER_AGENT,
    }
    // ⚠️ 这里**绝不能**加 Authorization：`fetchJson` 只用于 registry.npmjs.org，
    // 把 GitHub PAT 发到 npm registry 是跨源凭据泄露（旧版就是这么错的）。
    // GitHub 分支在 fetchGithub 里单独注入。
    return await this.fetchWithTimeout(url, headers, 'json', signal) as RegistryPackageData
  }

  private cacheGet<T>(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (entry !== undefined) {
      if (entry.expiresAt >= Date.now()) return entry.value as T
      this.cache.delete(key)
    }
    // 内存未命中 → 查磁盘（命中则回填内存，后续同步读）
    if (this.disk !== null) {
      const fromDisk = this.disk.get(key)
      if (fromDisk !== undefined) {
        this.cache.set(key, { value: fromDisk, expiresAt: Date.now() + this.defaultTtlMs })
        return fromDisk as T
      }
    }
    return undefined
  }

  private cacheSet(key: string, value: unknown, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs
    this.cache.set(key, { value, expiresAt: Date.now() + ttl })
    if (this.disk !== null) {
      // ⚠️ 磁盘 TTL 必须取 **min(本次 TTL, 磁盘 TTL)**。
      // 旧版无脑用 diskTtlMs：于是「changelog 找不到」这类 10 分钟负缓存
      // 被落盘 24 小时，且内存过期后又会从磁盘回填 —— 用户一天内一直看到
      // 「没有更新日志」，且重启也救不回来。
      this.disk.set(key, value, Math.min(ttl, this.diskTtlMs))
    }
  }

  /**
   * 清空元数据缓存。
   *
   * ⚠️ 必须由「刷新缓存」调用 —— 否则那个按钮只是改了个时间戳，
   * registry 数据其实一点没刷新（缓存 TTL 到点前一直返回旧值）。
   * 内存与磁盘**都要清**，否则重启后旧数据又回来了。
   */
  clearCache(): void {
    this.cache.clear()
    if (this.disk !== null) this.disk.clear()
  }

  /**
   * 换一块磁盘缓存（配置里改了目录/开关时热切换）。
   *
   * ⚠️ 调用方应先把旧的那块 `flush()`，否则会丢掉待写入的内容。
   * 内存缓存不受影响 —— 它本来就在更上层。
   */
  setDiskCache(disk: DiskCache | null, diskTtlMs?: number): void {
    this.disk = disk
    if (diskTtlMs !== undefined) this.diskTtlMs = diskTtlMs
  }

  /** 立即把磁盘缓存落盘（插件 dispose 时调用，避免丢最后一次写入） */
  flushDiskCache(): void {
    if (this.disk !== null) this.disk.flush()
  }

  /** 缓存条目数（诊断用） */
  cacheSize(): number {
    return this.cache.size
  }

  /** 磁盘缓存条目数（诊断用；未启用磁盘缓存时为 0） */
  diskCacheSize(): number {
    return this.disk === null ? 0 : this.disk.size()
  }

  /**
   * 拉单个包的**完整** packument。
   *
   * ⚠️ 刻意**不缓存**（内存与磁盘都不缓存）：
   *   npm 的 packument 含全部版本 + README，实测 `react` 单包 6.8MB、
   *   常见包 100KB~800KB，220 个包累计可达数百 MB。
   *   缓存它们既撑爆内存也会把磁盘缓存冲垮（实测导致 220 条只剩 6 条）。
   *
   * 去重由 {@link getPackageMeta} 的精简缓存负责 —— 同一个包第二次问就直接命中，
   * 不会再走到这里。
   */
  async getPackage(name: string, opts: FetchOpts = {}): Promise<RegistryPackageData | null> {
    try {
      const url = `${this.base}/${encodeURIComponent(name)}`
      return await this.fetchJson(url, opts.signal)
    } catch (e: any) {
      const msg = sanitizeError((e && e.message) ? e.message : String(e))
      if (msg.includes('404')) return null
      throw new Error(msg)
    }
  }

  /**
   * 解析为 PackageMeta（工具 #1/#2 + 扫描共用）。
   *
   * **这是唯一会落盘的缓存**：只存精简投影（name/latest/description/homepage/repository），
   * 单条约 300 字节 —— 220 个包合计约 66KB，可以长期存活、跨重启复用。
   */
  async getPackageMeta(name: string, currentVersion: string, opts: FetchOpts = {}): Promise<PackageMeta | null> {
    const cacheKey = `meta:${name}`
    const cached = this.cacheGet<SlimPackageMeta>(cacheKey)
    if (cached !== undefined) return toPackageMeta(cached, currentVersion)

    const data = await this.getPackage(name, opts)
    if (!data) return null
    const slim = slimOf(data, currentVersion)
    this.cacheSet(cacheKey, slim, opts.cacheTtlMs)
    return toPackageMeta(slim, currentVersion)
  }

  /** 批量取多个包的元数据(工具 #1 用,失败的包降级为 null 后过滤) */
  async batchGetPackageMeta(
    packages: Array<{ name: string; currentVersion: string }>,
    opts: FetchOpts = {},
  ): Promise<PackageMeta[]> {
    const results = await Promise.all(
      packages.map(p => this.getPackageMeta(p.name, p.currentVersion, opts).catch(() => null))
    )
    return results.filter((m): m is PackageMeta => m !== null)
  }

  /**
   * 拉 changelog（工具 #2 用）。
   *
   * 顺序：
   *   1. **GitHub Releases API** —— 结构化、带发布日期
   *   2. **raw.githubusercontent.com 的 CHANGELOG.md** —— 解析 markdown 标题
   *   3. `source: 'none'` 的占位条目 —— 明确告诉调用方"找过了、没有"，
   *      而不是返回空数组让人分不清"没找"和"没找到"
   *
   * ⚠️ 仓库地址必须由调用方传入（`PackageMeta.repository`）——
   * 完整 packument 刻意不缓存，这里不能再拉一次。
   */
  async getChangelog(name: string, repoUrl?: string, opts: FetchOpts = {}): Promise<ChangelogSection[]> {
    const cacheKey = `changelog:${name}`
    const cached = this.cacheGet<ChangelogSection[]>(cacheKey)
    if (cached !== undefined) return cached

    const slug = parseGitHubSlug(repoUrl)
    if (slug !== null) {
      const fromReleases = await this.changelogFromReleases(slug, opts).catch(() => [])
      if (fromReleases.length > 0) {
        this.cacheSet(cacheKey, fromReleases, CHANGELOG_TTL_MS)
        return fromReleases
      }
      const fromMd = await this.changelogFromMarkdown(slug, opts).catch(() => [])
      if (fromMd.length > 0) {
        this.cacheSet(cacheKey, fromMd, CHANGELOG_TTL_MS)
        return fromMd
      }
    }

    const placeholder: ChangelogSection[] = [{
      version: '',
      notes: slug === null
        ? '该包未声明 GitHub 仓库（或仓库不在 GitHub），无法拉取更新日志。'
        : '在 GitHub Releases 与 CHANGELOG.md 里都没有找到可用的更新日志。',
      source: 'none',
    }]
    // 失败结果短缓存 —— 避免反复打 GitHub（未认证时限额只有 60 次/小时）
    this.cacheSet(cacheKey, placeholder, 600_000)
    return placeholder
  }

  /** GitHub Releases API */
  private async changelogFromReleases(slug: GitHubSlug, opts: FetchOpts): Promise<ChangelogSection[]> {
    const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases?per_page=${CHANGELOG_LIMIT}`
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    }
    // 有 token 就带上：未认证限额 60 次/小时，认证后 5000
    if (this.githubToken) headers['Authorization'] = `Bearer ${this.githubToken}`
    const list = await this.fetchWithTimeout(url, headers, 'json', opts.signal)
    if (!Array.isArray(list)) return []
    const out: ChangelogSection[] = []
    for (const r of list) {
      if (!r || typeof r !== 'object') continue
      const tag = r.tag_name ?? r.name
      if (typeof tag !== 'string' || tag === '') continue
      const sec: ChangelogSection = {
        version: tag.replace(/^v/, ''),
        notes: String(r.body ?? '').trim().slice(0, MAX_NOTES_CHARS),
        source: 'github-releases',
      }
      if (typeof r.published_at === 'string' && r.published_at.length >= 10) {
        sec.date = r.published_at.slice(0, 10)
      }
      out.push(sec)
      if (out.length >= CHANGELOG_LIMIT) break
    }
    return out
  }

  /** 从仓库根目录的 CHANGELOG.md 等常见文件名里解析 */
  private async changelogFromMarkdown(slug: GitHubSlug, opts: FetchOpts): Promise<ChangelogSection[]> {
    // 只试最可能的两个，避免为一个包打 5 次请求
    for (const filename of ['CHANGELOG.md', 'CHANGES.md']) {
      const url = `https://raw.githubusercontent.com/${slug.owner}/${slug.repo}/HEAD/${filename}`
      try {
        const text = await this.fetchWithTimeout(
          url,
          { 'User-Agent': USER_AGENT },
          'text',
          opts.signal,
        )
        const sections = parseMarkdownChangelog(String(text ?? ''))
        if (sections.length > 0) return sections
      } catch {
        /* 文件不存在 → 试下一个 */
      }
    }
    return []
  }
}

/** 一次最多返回几个版本段 */
const CHANGELOG_LIMIT = 8
/** 单段 notes 的字符上限（防超大 release body 撑爆输出） */
const MAX_NOTES_CHARS = 4000
/** changelog 缓存时长（比元数据短一些：它更容易变） */
const CHANGELOG_TTL_MS = 6 * 3600_000

export interface GitHubSlug {
  owner: string
  repo: string
}

/**
 * 从 npm 的 `repository.url` 解析 GitHub 的 owner/repo。
 *
 * 实测 npm 上这些写法都有：
 *   `git+https://github.com/o/r.git` · `https://github.com/o/r` ·
 *   `git://github.com/o/r.git` · `github:o/r` · `o/r`
 *
 * @returns 解析不出 GitHub 仓库时返回 null（非 GitHub / 无仓库 / 格式不认识）
 */
export function parseGitHubSlug(repoUrl?: string): GitHubSlug | null {
  if (typeof repoUrl !== 'string') return null
  const raw = repoUrl.trim()
  if (raw === '') return null

  // 简写：github:owner/repo
  const short = raw.match(/^github:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (short) return { owner: short[1], repo: short[2] }

  // 完整 URL：允许 git+ / git:// / https:// / ssh://git@ 前缀
  const full = raw.match(
    /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/#?\s]+?)(?:\.git)?(?:[#?].*)?$/i,
  )
  if (full) return { owner: full[1], repo: full[2] }

  return null
}

/**
 * 从 CHANGELOG.md 文本里抽出最近的若干版本段。
 *
 * 识别的标题写法（实测 npm 生态里最常见）：
 *   `## 1.2.3` · `## [1.2.3]` · `## v1.2.3` · `## [1.2.3] - 2024-01-01` · `## 1.2.3 (2024-01-01)`
 * 只认 2~3 级标题（`##` / `###`）—— 1 级标题通常是文档大标题。
 */
export function parseMarkdownChangelog(md: string, limit = CHANGELOG_LIMIT): ChangelogSection[] {
  const lines = String(md ?? '').split(/\r?\n/)
  const heading = /^#{2,3}\s+\[?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]?(?:\s*[-–—(]\s*(\d{4}-\d{2}-\d{2}))?/
  // 非版本的二级标题（`## Unreleased` / `## Migration` …）应当**结束**当前段，
  // 否则它们会被当成上一个版本的内容。三级标题（`### Fixed`）不算，那是版本内的分节。
  const anyH2 = /^##\s+\S/
  const out: ChangelogSection[] = []
  let cur: { version: string; date?: string; buf: string[] } | null = null

  const finish = (): void => {
    if (cur === null) return
    const sec: ChangelogSection = {
      version: cur.version,
      notes: cur.buf.join('\n').trim().slice(0, MAX_NOTES_CHARS),
      source: 'changelog-md',
    }
    if (cur.date !== undefined) sec.date = cur.date
    out.push(sec)
  }

  for (const line of lines) {
    const m = line.match(heading)
    if (m) {
      if (cur !== null) {
        finish()
        if (out.length >= limit) return out
      }
      cur = { version: m[1], buf: [] }
      if (m[2] !== undefined) cur.date = m[2]
      continue
    }
    if (anyH2.test(line)) {
      if (cur !== null) {
        finish()
        cur = null
        if (out.length >= limit) return out
      }
      continue
    }
    if (cur !== null) cur.buf.push(line)
  }
  if (cur !== null && out.length < limit) finish()
  return out
}
