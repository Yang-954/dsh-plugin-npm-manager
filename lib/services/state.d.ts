/**
 * Shared plugin state — scanner + registry + config + cache + 项目目录
 *
 * 工具 #1~#4 + 路由都共用这一个 state(避免重复创建 RegistryClient)
 */
import { type ProjectRef } from './scanner.js';
import { RegistryClient, type ChangelogSection, type PackageMeta } from './registry.js';
import { DiskCache } from './disk-cache.js';
/** 带项目归属的包元数据（仅 system 范围填充 project/projectPath） */
export interface ScopedPackageMeta extends PackageMeta {
    project?: string;
    projectPath?: string;
}
/** 一个已知项目（发现到的 Node 项目 + 当前 cwd） */
export interface ProjectInfo {
    id: string;
    title: string;
    path: string;
    /** 是否 dsh 进程当前工作目录 */
    isCurrent: boolean;
    /** 目录当前是否存在 */
    exists: boolean;
    /** 所属 DSH 工作区标题（cwd 自身没有则为 undefined） */
    workspace?: string;
}
export interface PackageListResult {
    packages: ScopedPackageMeta[];
    totalCount: number;
    outdatedCount: number;
    scope: string;
    /** system 范围实际扫描的项目数 */
    projectCount?: number;
    packageNames: string[];
    /** 本次结果是否来自缓存（false = 刚刚真实扫描过） */
    cached?: boolean;
    /** 这份数据实际扫描完成的时间戳（缓存命中时是原始扫描时间） */
    scannedAt?: number;
    /** 解析失败（404/超时/限流）的包数 —— 数据不完整时如实报出去 */
    failedCount?: number;
}
/**
 * 流式扫描事件（NDJSON / SSE 逐条推给前端）。
 *
 * 为什么要流式：全系统一次要解析 200+ 个包的 registry 元数据，耗时几十秒。
 * 等全部完成再返回会让界面长时间空着，用户以为宕机。分批推送可以让
 * 「识别到几个就先列几个」。
 */
export type StreamEvent = {
    type: 'meta';
    scope: string;
    total: number;
    projectCount?: number;
    cached: boolean;
} | {
    type: 'pkg';
    package: ScopedPackageMeta;
} | {
    type: 'done';
    totalCount: number;
    outdatedCount: number;
    projectCount?: number;
    cached: boolean;
    scannedAt: number;
} | {
    type: 'error';
    error: string;
};
export interface PackageDetailResult extends PackageMeta {
    changelog: ChangelogSection[];
}
export interface StateOptions {
    cwd: string;
}
export declare class State {
    config: any;
    cwd: string;
    registryClient: RegistryClient;
    cacheInvalidatedAt: number;
    /** DSH 工作区提供者 —— 由 apply 通过 ctx.inject(['workspaceRegistry']) 注入；缺失时降级为只有 cwd */
    private workspaceProvider;
    /** 磁盘缓存（registry 元数据跨进程存活）；未启用时为 null */
    diskCache: DiskCache | null;
    /** 最近一次 workspaceProvider 抛出的错误（诊断用） */
    private workspaceError;
    /** 诊断探针 */
    private serviceProbe;
    private injectProbe;
    /** settings 作用域（由 installSettingsPanel 注入）；null = 只读 */
    private settingsScope;
    /**
     * settings 文档的当前 revision（0.2.1 乐观并发用）。
     *
     * `describe()` 返回它；`update(ns, patch, revision)` 要求传回。传错会抛
     * `SETTINGS_CONFLICT`，从而避免两个标签页互相覆盖。
     */
    settingsRevision: number | undefined;
    /** listProjects() 的缓存（发现过程要遍历目录树） */
    private projectCache;
    /**
     * listPackages() 的结果缓存，键为 `scope\0projectPath`。
     *
     * 目的：切换范围/项目/筛选时**不重新扫描**（全系统一次要扫 220 个包、
     * 每个都查 registry，实测要几十秒）。只在首次进入某个组合时扫一次，
     * 直到显式「刷新缓存」或 TTL 到期。
     */
    private listCache;
    /** 上次看到的配置值快照（用于检测 0.2.1 volatile 引用的原地更新） */
    private lastConfigSnapshot;
    /**
     * 缓存代数。
     *
     * 每次 {@link invalidate}（刷新按钮 / 配置变更）就 +1。扫描开始时记下当时的代数，
     * 结束前比对：不一致说明「扫描期间有人清了缓存」，这份结果不能再写回
     * （否则旧数据会被盖上新的 scannedAt 混进缓存）。
     */
    private cacheGeneration;
    constructor(config: any, opts: StateOptions);
    /**
     * 读一项配置的**当前值**。
     *
     * ⚠️ 0.2.1 里标了 `.volatile()` 的字段是 `{ get() }` 引用，不是普通值。
     * 全类统一走这里，不要写 `this.config.x` —— 那拿到的是引用对象，
     * 会让 `scope === 'system'` 之类的比较全部失效（且不报错，最阴的一种）。
     */
    private cfg;
    /**
     * 按当前 config 造一块磁盘缓存。
     *
     * 构造失败（目录不可建等）一律降级为 null（纯内存缓存），
     * 绝不让缓存问题影响插件主流程。
     */
    private createDiskCache;
    /**
     * 注入 DSH 工作区列表（服务缺失时不调用 → 自动降级）。
     *
     * 传 `null` 表示撤销（热重载时 effect 清理会调它）—— 不撤销的话
     * 旧闭包会一直指向已销毁的 sctx，重载后「全系统」范围会静默变空。
     */
    setWorkspaceProvider(fn: (() => ProjectRef[]) | null): void;
    /** 是否已拿到 workspaceRegistry（诊断用） */
    hasWorkspaceProvider(): boolean;
    /** 诊断探针：调用时直接看宿主 ctx 上有没有 workspaceRegistry */
    setServiceProbe(fn: () => string): void;
    /** 诊断探针：两个 inject 回调是否触发过 */
    setInjectProbe(fn: () => {
        control: boolean;
        workspace: boolean;
    }): void;
    /**
     * 注入 settings 作用域（由 installSettingsPanel 提供）。
     * 没有它时面板只能读配置、不能写。
     */
    setSettingsScope(scope: any): void;
    /** 配置是否可在面板里编辑（诊断用） */
    get settingsWritable(): boolean;
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
    applySettingsPatch(patch: Record<string, unknown>): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** 当前配置的值快照（解引用后；用于比较与下发，**不要**拿它当长期配置） */
    configValues(): Record<string, any>;
    /**
     * 检测 volatile 引用是否被改了，并按影响面作废缓存。
     *
     * 0.2.1 删掉了 `scope.watch`，改配置时 loader 直接把新值写进 volatile 引用
     * （`updateVolatile`），**不重启插件**。所以这里在每次读取前对比一次快照：
     * 变了就按影响面失效 —— 改「扫描深度」不该清 registry 缓存（否则要重拉 60 秒）。
     */
    syncConfig(): boolean;
    /**
     * 兼容旧调用点（settings 面板装好后会先调一次）。
     * 现在没有 `watch` 了，等价于「强制同步一次」。
     */
    updateConfig(_next?: any): void;
    /** 诊断快照 */
    probeSnapshot(): {
        serviceType: string | null;
        inject: {
            control: boolean;
            workspace: boolean;
        } | null;
    };
    /** 最近一次 workspaceProvider 抛出的错误（诊断用；正常为 null） */
    get lastWorkspaceError(): string | null;
    /**
     * 按当前 config 重建磁盘缓存并换给 registry 客户端。
     *
     * 换之前**先把旧块 flush** —— 它可能还有 debounce 里没落盘的条目。
     * 刻意**不删旧目录**：用户可能只是临时切一下，切回来还能用。
     */
    private rebuildDiskCache;
    /**
     * 清空全部缓存。
     *
     * ⚠️ 三处都要清：结果缓存、项目发现缓存、registry 元数据缓存。
     * 只清前两个的话「刷新缓存」按钮是假的 —— registry 那边 TTL 没到就仍返回旧值。
     */
    invalidate(): void;
    /** 当前结果缓存条目数（诊断/测试用） */
    listCacheSize(): number;
    /**
     * 插件卸载/重载时调用：把磁盘缓存落盘。
     * 不落盘会丢掉最后一批写入（debounce 还没到点就退出了）。
     */
    dispose(): void;
    /** 结果缓存的有效期；配置为 0 或负数时用默认 30 分钟 */
    private listCacheTtlMs;
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
    listProjects(): ProjectInfo[];
    /** 解析单个已安装包的元数据，并补上项目归属 */
    private resolveOne;
    /** 计算某个 scope 要扫的项目列表（仅 system 范围非空） */
    private projectsFor;
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
    private explicitProject;
    /** 缓存键 */
    private keyOf;
    /** 取缓存命中（未过期时） */
    private cacheHit;
    /** 写入结果缓存 */
    private cachePut;
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
    streamPackages(scope?: string, projectPath?: string): AsyncGenerator<StreamEvent>;
    /**
     * 列出包(工具 #1 + 路由 GET /packages 共用)。
     *
     * 缓存优先：同一 `(scope, projectPath)` 组合在 TTL 内直接返回上次结果，
     * 不重新扫盘、不重新查 registry。切范围/切项目因此是瞬时的。
     * 需要真正刷新时调用 {@link invalidate}（「刷新缓存」按钮 / 配置变更）。
     */
    listPackages(scope?: string, projectPath?: string): Promise<PackageListResult>;
    /**
     * 用固定并发池解析全部包。
     *
     * @param generation 扫描开始时的缓存代数；与当前不一致时提前放弃剩余工作
     */
    private resolveAll;
    /** 单包详情(工具 #2 + 路由 GET /packages/:name 共用) */
    getPackageDetail(name: string, currentVersion: string): Promise<PackageDetailResult | null>;
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
    inferInstalledVersion(name: string): Promise<string | undefined>;
}
//# sourceMappingURL=state.d.ts.map