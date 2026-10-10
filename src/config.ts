/**
 * Config schema — 真包 @deepseek-ai/schemastery 的 DSL
 * 按 dsh-plugin-conformance §1 + §5.1 写法
 */

import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  scope: Schema.union(['project', 'global', 'system']).default('project'),
  /** 从每个 DSH 工作区往下发现 Node 项目的最大层数（0 = 只看工作区根） */
  projectScanDepth: Schema.number().default(3),
  /**
   * 扫描结果缓存的存活时间（毫秒）。
   * 存在的意义：切换范围/项目/筛选时不重新扫描（全系统一次要几十秒）。
   * 点「刷新缓存」会立刻作废缓存，不看这个值。
   */
  listCacheTtlMs: Schema.number().default(1_800_000),
  registryCacheTtlMs: Schema.number().default(300_000),
  /**
   * 单次 registry 请求的超时（毫秒）。
   * ⚠️ 不能没有：网络半死（连接建立但不返回）时裸 fetch 会永远挂着，
   * 而流式扫描里任何一个不 settle 的请求都会让整次扫描卡在"转圈圈"。
   */
  requestTimeoutMs: Schema.number().default(15_000),
  /**
   * 是否把 registry 元数据缓存落盘（`~/.dsh/npm-manager/registry-cache.json`）。
   * 关掉后每次重启 dsh 的首次扫描都要重新拉全部包（本机实测 220 包约 31 秒）。
   */
  diskCache: Schema.boolean().default(true),
  /** 落盘条目的存活时间；元数据变化慢，默认 24 小时 */
  diskCacheTtlMs: Schema.number().default(86_400_000),
  /** 自定义缓存目录；省略时用 `$DSH_HOME/npm-manager`（默认 `~/.dsh/npm-manager`） */
  diskCacheDir: Schema.string(),
  enableChangelog: Schema.boolean().default(true),
  npmCommandTimeoutMs: Schema.number().default(60_000),
  githubToken: Schema.string(),
})

// 由 schemastery 的类型推导(InferValue)导出
// (TS-only type alias 已删, 沙箱 strip-types 兼容)

/**
 * 可在设置页里编辑的字段描述 —— **单一事实来源**。
 *
 * 服务端把它随 `/settings` 一起发给前端，前端按它渲染表单；
 * 服务端也用它的 key 列表做写入白名单。两边不会漂移。
 *
 * `githubToken` 刻意**不**放进列表 —— 它是凭据，不该在面板里回显/编辑。
 */
export interface SettingsField {
  key: string
  type: 'select' | 'number' | 'boolean' | 'text'
  /** 单位（数字字段用） */
  unit?: string
  /** select 的选项 */
  options?: string[]
  min?: number
  max?: number
}

export const SETTINGS_FIELDS: SettingsField[] = [
  { key: 'scope', type: 'select', options: ['project', 'global', 'system'] },
  { key: 'projectScanDepth', type: 'number', min: 0, max: 8, unit: '层' },
  { key: 'requestTimeoutMs', type: 'number', min: 1000, max: 120000, unit: 'ms' },
  { key: 'listCacheTtlMs', type: 'number', min: 0, max: 86400000, unit: 'ms' },
  { key: 'registryCacheTtlMs', type: 'number', min: 0, max: 86400000, unit: 'ms' },
  { key: 'diskCache', type: 'boolean' },
  { key: 'diskCacheTtlMs', type: 'number', min: 0, max: 604800000, unit: 'ms' },
  { key: 'diskCacheDir', type: 'text' },
  { key: 'enableChangelog', type: 'boolean' },
  { key: 'npmCommandTimeoutMs', type: 'number', min: 1000, max: 600000, unit: 'ms' },
]

/** 允许通过 API 写入的 key 白名单（由字段表派生，不另维护一份） */
export const WRITABLE_SETTING_KEYS: ReadonlySet<string> = new Set(SETTINGS_FIELDS.map((f) => f.key))
