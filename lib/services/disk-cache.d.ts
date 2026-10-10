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
/// <reference types="node" resolution-mode="require"/>
export interface CacheEntry {
    value: unknown;
    expiresAt: number;
}
export interface DiskCacheOptions {
    /** 插件数据根目录；省略时按 DSH_HOME 推导。缓存实际落在它下面的 `cache/` */
    dir?: string;
    /** 落盘延迟（毫秒），合并连续写入 */
    flushDelayMs?: number;
    /** 最多保留多少条目（超出时丢最早过期的） */
    maxEntries?: number;
    /** 文件体积上限（字节）；超过则整体丢弃重建 */
    maxBytes?: number;
}
/** 解析 DSH_HOME（与 dshmarket 的 home-paths 规则一致：支持 `~/` 前缀） */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv, home?: string): string;
export declare class DiskCache {
    private file;
    private dir;
    private flushDelayMs;
    private maxEntries;
    private maxBytes;
    private entries;
    private timer;
    private loaded;
    private disabled;
    /** 诊断用：最近一次落盘是否成功 */
    lastError: string | null;
    constructor(opts?: DiskCacheOptions);
    /** 缓存文件路径（诊断用） */
    get path(): string;
    /** 缓存所在目录（整个目录都可安全删除） */
    get cacheDir(): string;
    get isDisabled(): boolean;
    /** 读盘。任何异常都降级为空缓存（并标记 disabled，避免反复失败）。 */
    load(): void;
    get(key: string): unknown | undefined;
    set(key: string, value: unknown, ttlMs: number): void;
    size(): number;
    clear(): void;
    /** 立即落盘（dispose 时调用，避免丢最后一次写入） */
    flush(): void;
    private markDirty;
    private evictOldest;
    private evictOldestFrom;
    private dropFile;
}
//# sourceMappingURL=disk-cache.d.ts.map