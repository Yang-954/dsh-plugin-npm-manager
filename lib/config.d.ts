/**
 * Config schema — 真包 @deepseek-ai/schemastery 的 DSL
 * 按 dsh-plugin-conformance §1 + §5.1 写法
 */
import Schema from '@deepseek-ai/schemastery';
export declare const Config: Schema<Schemastery.ObjectS<{
    scope: Schema<"project" | "global" | "system", "project" | "global" | "system">;
    /** 从每个 DSH 工作区往下发现 Node 项目的最大层数（0 = 只看工作区根） */
    projectScanDepth: Schema<number, number>;
    /**
     * 扫描结果缓存的存活时间（毫秒）。
     * 存在的意义：切换范围/项目/筛选时不重新扫描（全系统一次要几十秒）。
     * 点「刷新缓存」会立刻作废缓存，不看这个值。
     */
    listCacheTtlMs: Schema<number, number>;
    registryCacheTtlMs: Schema<number, number>;
    /**
     * 单次 registry 请求的超时（毫秒）。
     * ⚠️ 不能没有：网络半死（连接建立但不返回）时裸 fetch 会永远挂着，
     * 而流式扫描里任何一个不 settle 的请求都会让整次扫描卡在"转圈圈"。
     */
    requestTimeoutMs: Schema<number, number>;
    /**
     * 是否把 registry 元数据缓存落盘（`~/.dsh/npm-manager/registry-cache.json`）。
     * 关掉后每次重启 dsh 的首次扫描都要重新拉全部包（本机实测 220 包约 31 秒）。
     */
    diskCache: Schema<boolean, boolean>;
    /** 落盘条目的存活时间；元数据变化慢，默认 24 小时 */
    diskCacheTtlMs: Schema<number, number>;
    /** 自定义缓存目录；省略时用 `$DSH_HOME/npm-manager`（默认 `~/.dsh/npm-manager`） */
    diskCacheDir: Schema<string, string>;
    enableChangelog: Schema<boolean, boolean>;
    npmCommandTimeoutMs: Schema<number, number>;
    githubToken: Schema<string, string>;
}>, Schemastery.ObjectT<{
    scope: Schema<"project" | "global" | "system", "project" | "global" | "system">;
    /** 从每个 DSH 工作区往下发现 Node 项目的最大层数（0 = 只看工作区根） */
    projectScanDepth: Schema<number, number>;
    /**
     * 扫描结果缓存的存活时间（毫秒）。
     * 存在的意义：切换范围/项目/筛选时不重新扫描（全系统一次要几十秒）。
     * 点「刷新缓存」会立刻作废缓存，不看这个值。
     */
    listCacheTtlMs: Schema<number, number>;
    registryCacheTtlMs: Schema<number, number>;
    /**
     * 单次 registry 请求的超时（毫秒）。
     * ⚠️ 不能没有：网络半死（连接建立但不返回）时裸 fetch 会永远挂着，
     * 而流式扫描里任何一个不 settle 的请求都会让整次扫描卡在"转圈圈"。
     */
    requestTimeoutMs: Schema<number, number>;
    /**
     * 是否把 registry 元数据缓存落盘（`~/.dsh/npm-manager/registry-cache.json`）。
     * 关掉后每次重启 dsh 的首次扫描都要重新拉全部包（本机实测 220 包约 31 秒）。
     */
    diskCache: Schema<boolean, boolean>;
    /** 落盘条目的存活时间；元数据变化慢，默认 24 小时 */
    diskCacheTtlMs: Schema<number, number>;
    /** 自定义缓存目录；省略时用 `$DSH_HOME/npm-manager`（默认 `~/.dsh/npm-manager`） */
    diskCacheDir: Schema<string, string>;
    enableChangelog: Schema<boolean, boolean>;
    npmCommandTimeoutMs: Schema<number, number>;
    githubToken: Schema<string, string>;
}>>;
/**
 * 可在设置页里编辑的字段描述 —— **单一事实来源**。
 *
 * 服务端把它随 `/settings` 一起发给前端，前端按它渲染表单；
 * 服务端也用它的 key 列表做写入白名单。两边不会漂移。
 *
 * `githubToken` 刻意**不**放进列表 —— 它是凭据，不该在面板里回显/编辑。
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
//# sourceMappingURL=config.d.ts.map