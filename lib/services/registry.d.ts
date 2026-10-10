/**
 * Npm registry fetcher + cache + semver compare
 *
 * 用 Node 22+ / 浏览器都有的 globalThis.fetch
 * 错误消息经过 sanitize(§安全教训: 不把 URL 凭据 / Bearer token 泄露给模型)
 */
import { DiskCache } from './disk-cache.js';
export interface PackageMeta {
    name: string;
    latestVersion: string;
    currentVersion: string;
    description: string;
    homepage?: string;
    repository?: string;
    isOutdated: boolean;
    updateType: 'major' | 'minor' | 'patch' | 'same' | 'downgrade';
}
export interface ChangelogSection {
    version: string;
    date?: string;
    notes: string;
    source: 'github-releases' | 'changelog-md' | 'none';
}
interface RegistryPackageData {
    name: string;
    description?: string;
    'dist-tags'?: {
        latest?: string;
    };
    homepage?: string;
    repository?: {
        url?: string;
    };
}
interface FetchOpts {
    signal?: AbortSignal;
    cacheTtlMs?: number;
}
/**
 * 精简后的包元数据 —— **唯一会落盘的东西**。
 *
 * 单条约 300 字节；而完整 packument 平均约 1MB（实测 `react` 6.8MB、
 * `axios` 775KB、`semver` 240KB）。缓存完整 packument 会把磁盘缓存冲垮。
 */
export interface SlimPackageMeta {
    name: string;
    latest: string;
    description: string;
    homepage?: string;
    repository?: string;
}
export type UpdateType = 'major' | 'minor' | 'patch' | 'same' | 'downgrade';
export declare function detectUpdateType(current: string, latest: string): UpdateType;
export declare class RegistryClient {
    private base;
    private cache;
    private defaultTtlMs;
    private githubToken?;
    /** 可选的磁盘缓存层：让元数据在 dsh 重启后依然可用 */
    private disk;
    /** 写盘时用的 TTL —— 比内存 TTL 长得多（元数据变化慢） */
    private diskTtlMs;
    /** 单次 registry 请求的超时（毫秒）—— 没有它，网络半死会让整次扫描永久挂起 */
    private requestTimeoutMs;
    constructor(opts?: {
        cacheTtlMs?: number;
        githubToken?: string;
        diskCache?: DiskCache | null;
        diskTtlMs?: number;
        requestTimeoutMs?: number;
    });
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
    private fetchWithTimeout;
    private fetchJson;
    private cacheGet;
    private cacheSet;
    /**
     * 清空元数据缓存。
     *
     * ⚠️ 必须由「刷新缓存」调用 —— 否则那个按钮只是改了个时间戳，
     * registry 数据其实一点没刷新（缓存 TTL 到点前一直返回旧值）。
     * 内存与磁盘**都要清**，否则重启后旧数据又回来了。
     */
    clearCache(): void;
    /**
     * 换一块磁盘缓存（配置里改了目录/开关时热切换）。
     *
     * ⚠️ 调用方应先把旧的那块 `flush()`，否则会丢掉待写入的内容。
     * 内存缓存不受影响 —— 它本来就在更上层。
     */
    setDiskCache(disk: DiskCache | null, diskTtlMs?: number): void;
    /** 立即把磁盘缓存落盘（插件 dispose 时调用，避免丢最后一次写入） */
    flushDiskCache(): void;
    /** 缓存条目数（诊断用） */
    cacheSize(): number;
    /** 磁盘缓存条目数（诊断用；未启用磁盘缓存时为 0） */
    diskCacheSize(): number;
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
    getPackage(name: string, opts?: FetchOpts): Promise<RegistryPackageData | null>;
    /**
     * 解析为 PackageMeta（工具 #1/#2 + 扫描共用）。
     *
     * **这是唯一会落盘的缓存**：只存精简投影（name/latest/description/homepage/repository），
     * 单条约 300 字节 —— 220 个包合计约 66KB，可以长期存活、跨重启复用。
     */
    getPackageMeta(name: string, currentVersion: string, opts?: FetchOpts): Promise<PackageMeta | null>;
    /** 批量取多个包的元数据(工具 #1 用,失败的包降级为 null 后过滤) */
    batchGetPackageMeta(packages: Array<{
        name: string;
        currentVersion: string;
    }>, opts?: FetchOpts): Promise<PackageMeta[]>;
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
    getChangelog(name: string, repoUrl?: string, opts?: FetchOpts): Promise<ChangelogSection[]>;
    /** GitHub Releases API */
    private changelogFromReleases;
    /** 从仓库根目录的 CHANGELOG.md 等常见文件名里解析 */
    private changelogFromMarkdown;
}
export interface GitHubSlug {
    owner: string;
    repo: string;
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
export declare function parseGitHubSlug(repoUrl?: string): GitHubSlug | null;
/**
 * 从 CHANGELOG.md 文本里抽出最近的若干版本段。
 *
 * 识别的标题写法（实测 npm 生态里最常见）：
 *   `## 1.2.3` · `## [1.2.3]` · `## v1.2.3` · `## [1.2.3] - 2024-01-01` · `## 1.2.3 (2024-01-01)`
 * 只认 2~3 级标题（`##` / `###`）—— 1 级标题通常是文档大标题。
 */
export declare function parseMarkdownChangelog(md: string, limit?: number): ChangelogSection[];
export {};
//# sourceMappingURL=registry.d.ts.map