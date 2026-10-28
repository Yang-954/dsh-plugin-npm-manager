/**
 * Config schema — 真包 @deepseek-ai/schemastery 的 DSL
 *
 * ## 0.2.1 契约（本文件的关键约束）
 *
 * 0.2.1 的 settings 服务**不再有 `register()`**，命名空间改为「从插件的 Config
 * schema 派生」，且只有标了 `.volatile()` 的字段可写。三个后果，缺一不可：
 *
 * 1. **可写字段必须 `.volatile()`** —— 否则 `describe()` 里看不到它，
 *    `update()` 会抛 `Plugin entry "..." has no volatile fields`。
 * 2. **`.volatile()` 字段解析后变成引用对象** —— `config.scope` 不再是字符串，
 *    而是 `{ get: () => value }`。读值必须走 {@link readConfigValue}。
 * 3. **loader 靠引用原地热更新** —— 改配置不重启插件，只把新值写进引用。
 *    所以 State 必须**长期持有这个引用**，不能一次性深拷贝成普通对象。
 *
 * 凭据类字段（`githubToken`）用 `.role('secret')`：0.2.1 的 `describe({redactSecrets})`
 * 会把它替换成 presence marker，前端拿不到明文。
 */
import Schema from '@deepseek-ai/schemastery';
/**
 * 读一个配置字段的**当前值**。
 *
 * 0.2.1 里标了 `.volatile()` 的字段是 `{ get() }` 引用（cosmokit 的 volatile
 * reference，用 `Symbol.for('cosmokit.volatile.write')` 识别）；没标的是普通值。
 * 两种形态都要能读 —— 这是全插件唯一允许的读法，避免各处各写一遍。
 */
export declare function readConfigValue<T = any>(field: any): T;
/** 把一个可能是引用的配置对象整体摊平成普通对象（诊断/下发用，**不要**拿它当长期配置） */
export declare function readConfigSnapshot(config: any): Record<string, any>;
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    scope: Schema<"project" | "global" | "system", "project" | "global" | "system", "volatile-defined">;
    /** 从每个 DSH 工作区往下发现 Node 项目的最大层数（0 = 只看工作区根） */
    projectScanDepth: Schema<number, number, "volatile-defined">;
    /**
     * 扫描结果缓存的存活时间（毫秒）。
     * 存在的意义：切换范围/项目/筛选时不重新扫描（全系统一次要几十秒）。
     * 点「刷新缓存」会立刻作废缓存，不看这个值。0 = 关闭结果缓存。
     */
    listCacheTtlMs: Schema<number, number, "volatile-defined">;
    registryCacheTtlMs: Schema<number, number, "volatile-defined">;
    /**
     * 单次 registry 请求的超时（毫秒）。
     * ⚠️ 不能没有：网络半死（连接建立但不返回）时裸 fetch 会永远挂着，
     * 而流式扫描里任何一个不 settle 的请求都会让整次扫描卡在"转圈圈"。
     */
    requestTimeoutMs: Schema<number, number, "volatile-defined">;
    /**
     * 是否把 registry 元数据缓存落盘（`~/.dsh/npm-manager/cache/registry.json`）。
     * 关掉后每次重启 dsh 的首次扫描都要重新拉全部包（本机实测 220 包约 31 秒）。
     */
    diskCache: Schema<boolean, boolean, "volatile-defined">;
    /** 落盘条目的存活时间；元数据变化慢，默认 24 小时 */
    diskCacheTtlMs: Schema<number, number, "volatile-defined">;
    /** 自定义缓存目录；省略时用 `$DSH_HOME/npm-manager`（默认 `~/.dsh/npm-manager`） */
    diskCacheDir: Schema<string, string, "volatile">;
    enableChangelog: Schema<boolean, boolean, "volatile-defined">;
    npmCommandTimeoutMs: Schema<number, number, "volatile-defined">;
    /**
     * GitHub token（可选）。
     *
     * ⚠️ 两个「不」：**不进** {@link SETTINGS_FIELDS}（面板里不回显/不编辑）、
     * **不进**任何 HTTP 响应（见 `redactConfigForClient`）。
     * `.role('secret')` 让 0.2.1 的 settings 层自己也会脱敏。
     */
    githubToken: Schema<string, string, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    scope: Schema<"project" | "global" | "system", "project" | "global" | "system", "volatile-defined">;
    /** 从每个 DSH 工作区往下发现 Node 项目的最大层数（0 = 只看工作区根） */
    projectScanDepth: Schema<number, number, "volatile-defined">;
    /**
     * 扫描结果缓存的存活时间（毫秒）。
     * 存在的意义：切换范围/项目/筛选时不重新扫描（全系统一次要几十秒）。
     * 点「刷新缓存」会立刻作废缓存，不看这个值。0 = 关闭结果缓存。
     */
    listCacheTtlMs: Schema<number, number, "volatile-defined">;
    registryCacheTtlMs: Schema<number, number, "volatile-defined">;
    /**
     * 单次 registry 请求的超时（毫秒）。
     * ⚠️ 不能没有：网络半死（连接建立但不返回）时裸 fetch 会永远挂着，
     * 而流式扫描里任何一个不 settle 的请求都会让整次扫描卡在"转圈圈"。
     */
    requestTimeoutMs: Schema<number, number, "volatile-defined">;
    /**
     * 是否把 registry 元数据缓存落盘（`~/.dsh/npm-manager/cache/registry.json`）。
     * 关掉后每次重启 dsh 的首次扫描都要重新拉全部包（本机实测 220 包约 31 秒）。
     */
    diskCache: Schema<boolean, boolean, "volatile-defined">;
    /** 落盘条目的存活时间；元数据变化慢，默认 24 小时 */
    diskCacheTtlMs: Schema<number, number, "volatile-defined">;
    /** 自定义缓存目录；省略时用 `$DSH_HOME/npm-manager`（默认 `~/.dsh/npm-manager`） */
    diskCacheDir: Schema<string, string, "volatile">;
    enableChangelog: Schema<boolean, boolean, "volatile-defined">;
    npmCommandTimeoutMs: Schema<number, number, "volatile-defined">;
    /**
     * GitHub token（可选）。
     *
     * ⚠️ 两个「不」：**不进** {@link SETTINGS_FIELDS}（面板里不回显/不编辑）、
     * **不进**任何 HTTP 响应（见 `redactConfigForClient`）。
     * `.role('secret')` 让 0.2.1 的 settings 层自己也会脱敏。
     */
    githubToken: Schema<string, string, "plain">;
}>>, "plain">;
/**
 * 可在设置页里编辑的字段描述 —— **单一事实来源**。
 *
 * 服务端把它随 `/settings` 一起发给前端，前端按它渲染表单；
 * 服务端也用它的 key 列表做写入白名单。两边不会漂移。
 *
 * `githubToken` 刻意**不**放进列表 —— 它是凭据，不该在面板里回显/编辑。
 *
 * ⚠️ 这里的每个 key 都必须在 {@link Config} 里标了 `.volatile()`，
 *    否则 0.2.1 的 `update()` 会拒绝写入（`Config field "x" is not volatile`）。
 */
export interface SettingsField {
    key: string;
    type: 'select' | 'number' | 'boolean' | 'text';
    /** 单位（数字字段用） */
    unit?: string;
    /** select 的选项 */
    options?: string[];
    min?: number;
    max?: number;
}
export declare const SETTINGS_FIELDS: SettingsField[];
/** 允许通过 API 写入的 key 白名单（由字段表派生，不另维护一份） */
export declare const WRITABLE_SETTING_KEYS: ReadonlySet<string>;
/**
 * Config 的全部 key（含不可写的凭据字段）。
 *
 * 用途：`State.syncConfig()` 逐 key 对比快照以检测 volatile 引用变化。
 * 从 `Config.dict` 派生，避免再手写一份清单跟 schema 漂移。
 */
export declare const CONFIG_KEYS: readonly string[];
/**
 * 下发给浏览器的配置投影。
 *
 * ⚠️ **不能**直接 dump `state.config`：它含 `githubToken`。
 * 只下发 {@link SETTINGS_FIELDS} 里的字段，且都经过 {@link readConfigValue} 解引用。
 */
export declare function redactConfigForClient(config: any): Record<string, any>;
//# sourceMappingURL=config.d.ts.map