# dsh-plugin-npm-manager — 重写版（Round 12+）

> DSH 插件：列出本地/全局 npm 包的版本/描述，给用户**可视化**界面（DSH Settings → Plugins 面板），
> 同时给 model 4 个 `defineTool` 用于对话内调用。
>
> **本轮目标**：完全按 dsh-plugin-conformance skill 的 §9 重构步骤 + dsh-market 的 webServer 模式 + dsh-tool-todo 的 defineTool 样板，把项目从"仅 4 个 model 工具"升级到"完整热插拔 + web 设置可视化 UI"插件。
>
> **沉淀产物**：本项目本身就是一份"开发技能书"——本 PLAN §11 / 项目里的 `PLUGIN_DEV_GUIDE.md` / `scripts/dev-conformance-check.mjs` 都是给未来 Agent / 复用本项目模板的开发者用的。

---

## 0. 必读（不读不许写代码）

按 `~/.workbuddy-ai/skills/dsh-plugin-conformance/SKILL.md` 规范要求：

```
官方源码（C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/）：
├─ dsh-tools/README.zh.md                       # 工具子系统（最权威）
├─ dsh-tools/lib/types/schema.d.ts              # DefineToolOptions / ParameterSchemaSpec / ValueSchemaSpec
├─ dsh-tools/lib/types/index.d.ts               # ToolDefinition / ToolOutputDefinition / ToolRegistry
├─ dsh-tools/lib/index.js                       # defineTool + 运行时校验
├─ dsh-tools/lib/types/presentation.d.ts        # ContentBlock / card-tagged UI render intents
└─ dsh-host-webserver/lib/index.js             # ctx.webServer.register({kind, path, handler})

实测案例：
├─ C:/Users/Admin/.dsh/profiles/web/node_modules/dshmarket/
│  ├─ src/index.ts                              # ctx.inject(['webServer','loader'], (hostCtx) => {...})
│  ├─ src/routes.ts                             # mountMarketRoutes 真实范例
│  ├─ src/settings.ts                           # installMarketSettings 范例
│  └─ client/client.js                          # window.__ModuleLoader__.load({id, factory})
└─ C:/Users/Admin/.dsh/profiles/web/node_modules/email-assistant/  # 另一个完整插件范例（数据层）
```

**开发期参考**：直接把以上文件当 IDE 文件读，**不要凭记忆**。

---

## 1. package.json#dsh（官方形态）

按 dsh-plugin-conformance §1（**dsh-market/package.json:47-58** 是真参考）：

```json
{
  "name": "dsh-plugin-npm-manager",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "exports": {
    ".":             { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client":      "./client/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings-plugins"],
      "platform": "web"
    },
    "engines": { "dsh": ">=0.1.5-rc.2" }
  },
  "dependencies": {
    "semver": "^7.6.0",
    "node-fetch": "^2.7.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-host-webserver": ">=0.1.5-rc.1",
    "@deepseek-ai/dsh-settings": ">=0.1.5-rc.1",
    "@deepseek-ai/dsh-tools": ">=0.1.5-rc.2",
    "@deepseek-ai/schemastery": "^3.18.2"
  },
  "files": ["lib", "client", "src", "cordis.patch.yml", "README.md", "CHANGELOG.md"]
}
```

**对照 dsh-market**:
- `dsh.client.inject` 是 `client.js` 工厂需要的**包名**（不是服务名，§2 铁律）—— client 端从这些包拿 React/locale/settings plugin 组件
- `dsh.bundle.patch` 是宿主**启动这个插件时**要 apply 的 patch（cordis.patch.yml）
- `engines.dsh` 是**最低 DSH 版本**

---

## 2. 服务端 `apply(ctx, config)` 的 4 件套（conformance §2）

```typescript
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { registerWebRoutes } from './routes.js'
import { installSettingsPanel } from './settings.js'

export const name = 'npm-manager'
export const inject = ['tools', 'webServer', 'settings']  // 注入 3 个 DSH 真服务
export { Schema as Config }                              // 重新导出（DSH Loader 用这个名字读 schema）

export const Config = Schema.object({
  scope:           Schema.union(['local', 'global', 'both']).default('both'),
  registryCacheTtlMs: Schema.number().default(300_000),
  enableChangelog:    Schema.boolean().default(true),
  npmCommandTimeoutMs: Schema.number().default(60_000),
  githubToken:         Schema.string(),                    // 可选 = 不传 .optional()
})

export function apply(ctx: Context, config: InferConfig<typeof Config>): void {
  // 4 件套 export 已满足；这里只做"启动副作用"

  // 共享 services
  const state = createState(config)

  ctx.effect(() => {
    // 1. 注册 4 个 defineTool（给 model）
    const disposeTools = registerTools(ctx, state)
    // 2. 注册 webServer 路由（给人看）
    const disposeRoutes = registerWebRoutes(ctx, state)
    // 3. 注册 settings 面板（出现在 DSH Settings 页面）
    const disposeSettings = installSettingsPanel(ctx, state)

    ctx.logger.info('[npm-manager] loaded')

    return () => {
      disposeTools()
      disposeRoutes()
      disposeSettings()
      ctx.logger.info('[npm-manager] disposed (hot-unplug ok)')
    }
  }, 'npm-manager: tools + web routes + settings panel')
}
```

### 2.1 `inject` 白名单（§2 铁律 7）

| 服务 | 真实存在 | 我们用吗 |
|---|---|---|
| `tools` | ✅ `@deepseek-ai/dsh-tools` | ✅ `ctx.tools.register(defineTool(...))` |
| `webServer` | ✅ `@deepseek-ai/dsh-host-webserver` | ✅ `ctx.webServer.register({kind, path, handler})` |
| `settings` | ✅ `@deepseek-ai/dsh-settings` | ✅ `ctx.settings.register('npm-manager', Config)` |
| `webServer`/`tools`/`settings` | 必须显式声明 | 不声明 → 永久 pending（"waiting for service: X"） |
| ❌ `home`、`credentials`、`agents` 等 | 按需声明，不写假名 | 不在 inject 里 |

---

## 3. 4 个 `defineTool` 工具（conformance §3-§5 + 真包类型）

### 3.1 真包 API（dsh-tools/lib/types/schema.d.ts 已读）

```typescript
// 真包导出（不是 z.enum！）：
Schema.union(['local', 'global', 'both']).default('both')
Schema.number().default(300_000)
Schema.string()                          // 可选 = 不调 .optional()
Schema.string().required()                // 必填
Schema.object({ additionalProperties: false, properties: {...} })

// 真包 defineTool：
import { defineTool } from '@deepseek-ai/dsh-tools'

const tool = defineTool({
  name: '...',
  description: '...',
  parameters: { key: { type: 'string', required: true } },  // 属性 map，不是 JSON Schema 根
  output: { schema: {...}, render: (args, value) => [{type:'text', text:value}] },
  async execute(args, exec) { return value },
})
```

### 3.2 4 个工具的完整定义（放在 `src/tools/*.ts`）

```typescript
// src/tools/list-packages.ts
ctx.tools.register(defineTool({
  name: 'npm_list_packages',
  description: '列出本机已安装的 npm 包（local/global/both）。返回每包的当前版本、最新版本、过期状态、描述。只读，不修改任何文件。',
  parameters: {
    scope: { type: 'string', enum: ['local', 'global', 'both'], default: 'both', description: '范围' },
    includeDev: { type: 'boolean', default: true, description: '是否包含 devDependencies' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packages: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              currentVersion: { type: 'string' },
              latestVersion: { type: 'string' },
              isOutdated: { type: 'boolean' },
              updateType: { type: 'string', enum: ['major', 'minor', 'patch', 'same', 'downgrade'] },
              description: { type: 'string' },
              scope: { type: 'string', enum: ['local', 'global'] },
            },
          },
        },
        totalCount: { type: 'integer' },
        outdatedCount: { type: 'integer' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args, exec) {
    return await scanPackages({ scope: args.scope, includeDev: args.includeDev, signal: exec.signal })
  },
}))
```

### 3.3 4 个工具的关键差异

| 工具 | 副作用 | 沙箱权限 |
|---|---|---|
| `npm_list_packages` | ❌ 只读 | 无 |
| `npm_get_package_info` | ❌ 只读（可选 fetch changelog）| 只读网络 |
| `npm_preview_upgrade` | ❌ 只读（`npm --dry-run`）| 只读子进程 |
| `npm_apply_upgrade` | ✅ 写 `package.json` + `node_modules` | 必须 confirm:true + dryRun:false |

`npm_apply_upgrade` 走 §7 的 `ctx.tools.guard`（让用户必须先批准）。

---

## 4. webServer 路由（conformance §5.3 + dsh-market/src/routes.ts 真参考）

### 4.1 `ctx.webServer.register()` 的 `(kind, path)` 唯一键

```typescript
// src/routes.ts
export function registerWebRoutes(ctx: Context, state: State): Dispose {
  return ctx.effect(() => {
    // ===== 给人看的 REST API =====

    // 包列表（带版本、描述、过期状态）
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/packages',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://x')
        const scope = url.searchParams.get('scope') ?? 'both'
        const includeDev = url.searchParams.get('includeDev') !== 'false'
        const data = await state.scanner.scan({ scope, includeDev })
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(data))
      },
    })

    // 单包详情
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/packages/:name',
      handler: async (req, res) => { /* 同上但 fetch changelog */ },
    })

    // 过期包列表
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/packages/outdated',
      handler: async (req, res) => { /* only isOutdated=true */ },
    })

    // 触发重扫（POST）
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/refresh',
      handler: async (req, res) => {
        await state.scanner.invalidate()
        res.end(JSON.stringify({ ok: true }))
      },
    })

    // ===== 4 个工具对应的内部端点（client.js 走 host.call 而不是 fetch，所以这些是给外部测试用）=====
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/tools/list',
      handler: async (req, res) => { /* 调 list_packages 工具 */ },
    })
    // ... list / get / preview / apply 4 个

    return () => {} // dispose
  }, 'npm-manager: web routes')
}
```

### 4.2 路由唯一键规则（§5.3 铁律 14）

```typescript
// ❌ 重复注册：同 kind 同 path，第二行抛错
ctx.webServer.register({ kind:'exact', path:'/x', handler: getHandler })
ctx.webServer.register({ kind:'exact', path:'/x', handler: postHandler })
// → webserver: duplicate exact route "/x"

// ✅ 合并到一个 exact，handler 内按 req.method 分支
ctx.webServer.register({
  kind: 'exact', path: '/x',
  handler: async (req, res) => {
    if (req.method === 'GET') return getHandler(req, res)
    if (req.method === 'POST') return postHandler(req, res)
  },
})
```

### 4.3 path 形式

- `exact` —— 路径完全匹配（`/plugins/npm-manager/packages` 不匹配 `/plugins/npm-manager/packages/foo`）
- `prefix` —— 前缀匹配（`/plugins/npm-manager` 匹配所有子路径）
- 我们主要用 `exact`

---

## 5. Settings 面板（conformance §2 + dsh-market/settings.ts）

### 5.1 `ctx.settings.register()`

```typescript
// src/settings.ts
export function installSettingsPanel(ctx: Context, state: State): Dispose {
  return ctx.effect(() => {
    // 注册一个命名空间 + schema + 当前值
    const scope = ctx.settings.register('npm-manager', state.configSchema, {
      base: state.config,  // 部署配置作为 base 层，用户改动在上面叠加
    })

    // 监听变化（热生效）
    scope.watch((next) => {
      state.updateConfig(next)
      ctx.logger.info(`[npm-manager] settings changed: scope=${next.scope}`)
    })

    return () => scope.dispose?.()  // 释放
  }, 'npm-manager: settings panel')
}
```

`@deepseek-ai/dsh-settings` 会让用户在 DSH Settings 页面看到这个 tab，点开能编辑 4 个字段（scope / cacheTtlMs / enableChangelog / npmCommandTimeoutMs）。

---

## 6. client.js（浏览器端 React 面板）

学 dsh-market/client/client.js（**第 1 行 + 第 11377 行 `return module.exports`** 关键）：

```javascript
// client/client.js
window.__ModuleLoader__.load({
  id: 'npm-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')

    // 客户端运行时要求（在 dsh.client.inject 里声明）
    // @deepseek-ai/dsh-client-locale (t 函数)
    // @deepseek-ai/dsh-client-ui-settings-plugins (SettingsCard 组件)

    exports.name = 'npm-manager'
    exports.REQUIRED_PRIMITIVES = ['@deepseek-ai/dsh-client-locale']
    exports.inject = ['settingsScope']    // 注入 host 的 settings scope
    exports.apply = function (ctx) {
      ctx.inject(['settingsScope'], (scoped) => {
        scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
          name: 'settings.plugin.item',
          key: 'npm-manager',
          locale: { en: { name: 'NPM Manager', description: '...' }, zh: {...} },
          inject: () => ({ t }),
        }, () => react.createElement(NpmManagerCard, {
          t, scope: ctx.settings,        // ← 用 host.call? 不，client 端用 fetch
          onRefresh: () => fetch('/plugins/npm-manager/refresh', { method: 'POST' }),
          fetchPackages: (scope) => fetch(`/plugins/npm-manager/packages?scope=${scope}`).then(r => r.json()),
          onToggleScope: (newScope) => ctx.settings.update('npm-manager', { scope: newScope }),
        })))
      })
    }

    return module.exports
  },
})
```

### 6.1 关键约束（conformance §11 铁律 9）

```javascript
// ❌ 灾难：factory 闭合前忘了 return module.exports
function apply() { ctx.inject(...) }
// → loader 拿到 undefined → "received undefined"

// ✅ 必须
return module.exports
```

### 6.2 加载期静默（铁律 10）

```javascript
// ❌ 在 apply 期间 console.log 会污染 dsh web 的 token URL（stdout）
exports.apply = function (ctx) {
  console.log('plugin loaded')  // 灾难
  ctx.inject(...)  // 真正干活的代码
}

// ✅ 用 ctx.logger 或什么都不输出
exports.apply = function (ctx) {
  ctx.inject(...)  // 静默
}
```

---

## 7. 审批机制（conformance §7 + §8.1）

### 7.1 `npm_apply_upgrade` 是高危操作

```typescript
// src/guards.ts
export function installApprovalGuard(ctx: Context): Dispose {
  return ctx.effect(() => {
    return ctx.tools.guard((exec) => {
      // 只拦截 npm_apply_upgrade
      if (exec.name !== 'npm_apply_upgrade') return
      // 检查 agent 是否已批准
      if (exec.agent?.approvals?.get?.(exec.callId)?.granted) return
      return `npm 包升级是受控操作,需要用户批准`  // 返回理由 = 拒绝
    })
  }, 'npm-manager: upgrade approval gate')
}
```

### 7.2 状态门分级（§8.1）

| 入口 | 是否需要状态门 |
|---|---|
| `GET /packages`（元数据读）| ❌ 不需要 |
| `POST /refresh`（触发重扫）| ❌ 不需要 |
| `POST /tools/apply`（执行升级）| ✅ 需要 approval gate |
| `PUT /settings`（改配置）| ❌ 不需要（settings 自己有 watch）|

---

## 8. 项目结构

```
dsh-plugin-npm-manager/
├─ PLAN.md                         # 本文件
├─ README.md                       # 用户视角
├─ CHANGELOG.md                    # 自己项目的 changelog（Phase 13 自指验证）
├─ PROJECT_STATUS.md               # 项目状态报告（给用户决策依据）
├─ PLUGIN_DEV_GUIDE.md             # ★ 沉淀的"开发技能书"——给未来 Agent / 复用本项目模板的开发者
├─ package.json                    # §1 形态
├─ tsconfig.json                   # ESM + NodeNext + strict
├─ cordis.patch.yml                # DSH Loader apply 这个 patch
│
├─ src/
│  ├─ index.ts                     # §2 4 件套 apply(ctx, config)
│  ├─ config.ts                    # Schema.object(...)
│  ├─ services/
│  │  ├─ scanner.ts                # 扫 node_modules + npm registry
│  │  ├─ registry.ts               # fetch('https://registry.npmjs.org/<pkg>')（带缓存）
│  │  └─ guards.ts                 # §7 approval gate
│  ├─ tools/
│  │  ├─ list-packages.ts          # §3.2 defineTool #1
│  │  ├─ get-package-info.ts       # defineTool #2
│  │  ├─ preview-upgrade.ts        # defineTool #3
│  │  └─ apply-upgrade.ts          # defineTool #4
│  └─ web/
│     ├─ routes.ts                 # §4 webServer.register(...)
│     └─ settings.ts               # §5 ctx.settings.register(...)
│
├─ client/
│  └─ client.js                    # §6 window.__ModuleLoader__.load(...)  ← build 产物（直接放仓库）
│
├─ scripts/
│  ├─ dev-conformance-check.mjs    # ★ 用宿主真实 defineTool 验证 schema（§13 四层）
│  └─ build-client.mjs             # 把 src/client/* 打包成 client.js（带 return module.exports）
│
└─ tests/                          # ★ 用宿主真实编译器单测（不内联 mock）
   ├─ tool-schema-verify.mjs      # §13 层 1-3
   ├─ tool-execute-verify.mjs      # §13 层 4 (full register)
   └─ web-routes-verify.mjs        # §5.3 路由唯一键 + handler 行为
```

---

## 9. 开发步骤（按 dsh-plugin-conformance §9 重构步骤）

| # | 步骤 | 验证 |
|---|---|---|
| 1 | **结构对齐**：删旧 `dsh.plugin.yml`；重写 `package.json#dsh`（§1） | `pnpm install` 无 404 |
| 2 | **配置层**：新建 `src/config.ts` 用真包 `Schema.object`（不是 z.enum） | Phase 10 测试 11/11 |
| 3 | **入口重写**：`src/index.ts` 4 件套 `apply(ctx, config)`（§2） | Phase 0 静态 + 运行时 |
| 4 | **工具重写**：4 个 `defineTool` 用真包 DSL（§3） | §13 层 1-3 + 4 全过 |
| 5 | **webServer 路由**：5 个 exact 路由（§4） | routes verify 测试 |
| 6 | **Settings 面板**：`ctx.settings.register`（§5） | 手动跑 `dsh web` 看到 tab |
| 7 | **client.js**：build 出 §6 形态（必须 `return module.exports`） | §11 铁律 9 |
| 8 | **审批门**：`npm_apply_upgrade` 走 guard（§7） | guard verify 测试 |
| 9 | **build + dev-conformance-check**（§13） | CI 跑全过 |
| 10 | **部署到 vendor + workspace:* + pnpm install**（§14） | §14.3 验证清单 |

---

## 10. 沙箱能验证 vs 用户本机能验证

| 验证 | 沙箱 | 用户本机 |
|---|---|---|
| import 链通 | ✅ | ✅ |
| 类型定义 | ✅ | ✅ |
| 4 件套导出 | ✅ | ✅ |
| defineTool schema 通过 §13 层 1-3 | ✅（装真包 dsh-tools 后） | ✅ |
| defineTool 注册（§13 层 4） | ✅ | ✅ |
| webServer.register（§5.3 唯一键）| ✅ | ✅ |
| settings.register（§5） | ✅ | ✅ |
| client.js factory return（§11 铁律 9）| ✅ | ✅ |
| client.js 实际渲染（React 挂载到 settings slot） | ❌（沙箱无 React DOM）| ✅ |
| dsh web 启动后看到面板 | ❌ | ✅ |
| 真 npm scan + 真 registry fetch | ⚠️（沙箱 npm cache 权限错）| ✅ |

**沙箱能测的：§13 层 1-3 schema 验证 + §13.1 mock 测试不是验证 → 必须用真实 dsh-tools**。

---

## 11. 沉淀产物（本项目作为"开发技能书"）

### 11.1 项目自带的"开发技能书"

| 文档 | 沉淀什么 |
|---|---|
| `PLAN.md`（本文档）| 架构设计 + 重构步骤 + §13 验证策略 |
| `PLUGIN_DEV_GUIDE.md` | "如何基于本项目模板写新插件"（§9 重构步骤 + §13 四层 schema 验证 + §14 workspace 部署） |
| `scripts/dev-conformance-check.mjs` | 用宿主真实编译器做 schema 验证（避免 §13.1 "mock 测试不是验证"）|
| `scripts/build-client.mjs` | 把 TS 源码 build 成 client.js，确保 `return module.exports`（§11 铁律 9）|
| `PROJECT_STATUS.md` | 完整度报告，给用户决策依据 |
| `CHANGELOG.md` | 项目自己的更新日志（自指验证：本项目 changelog 解析工具能正确读自己 changelog）|

### 11.2 关键经验沉淀

| 经验 | 来源 |
|---|---|
| `parameters` 是属性 map，不是 `{type:'object',...}` | conformance §5.1 |
| `required: true` 是布尔在属性节点上 | conformance §5.1 |
| `additionalProperties: false` 必须字面量 | conformance §5.1 |
| 返回值必须 plain JSON（无 Buffer/Map/Date）| conformance §5.2 |
| mock 测试 ≠ 验证（必须 `import` 真实模块）| conformance §13.1 |
| `inject` 写服务名不写包名 | conformance §2 |
| `webServer` 路由 `(kind, path)` 唯一键 | conformance §5.3 |
| `client.js` factory 必须 `return module.exports` | conformance §11 铁律 9 |
| 加载期保持静默（不 console.*）| conformance §11 铁律 10 |
| 自研插件**不**写 registry 版本号，用 `workspace:*` | conformance §14 |
| workspace 成员快照必须去掉 `scripts` | conformance §14.2.1 |

### 11.3 借鉴 dsh-market 的展示方式（你说要学的"布局"）

- 卡片网格（`grid-template-columns: repeat(auto-fit, ...)`）
- 每张卡片显示：包名 + 版本（粗体）+ 描述（3 行截断）+ tags + 操作按钮
- 顶部 tabs：Discover / Installed / Settings / Updates
- 搜索框 + 排序（按时间/星数/相关性）
- 截图预览（README 提取的 auto-screenshot，§6 客户单 .nUhMVa_shots 类）
- 状态色（绿 = latest，橙 = outdated，红 = conflict）

**我们的 Settings tab** 长这样（卡片示例）：
```
┌─────────────────────────────────────────┐
│ 📦 npm-manager                            │
│    v1.0.0                                │
│                                          │
│ 列出本地/全局 npm 包,显示版本/描述/...  │
│                                          │
│ Tags: [npm] [deps] [settings]           │
│                                          │
│ [配置] [更新] [卸载]                     │
└─────────────────────────────────────────┘
```

---

## 12. 验收标准（沙箱内能跑的全跑）

### 12.1 静态（沙箱）

- [ ] `package.json#dsh` 字段符合 §1 形态（11 项必填）
- [ ] 4 件套导出（name / inject / Config / apply）
- [ ] `src/index.ts` 通过 `tsc --noEmit`

### 12.2 运行时（沙箱）

- [ ] §13 层 1：每个 `defineTool` 能调成功（schema 编译过）
- [ ] §13 层 2：每个工具的执行返回值通过 `validateJsonSchemaValue`
- [ ] §13 层 3：反向断言（错误返回值应报错）
- [ ] §13 层 4：全量 `registerTools` 不抛 `failed to register tools`
- [ ] `ctx.webServer.register` 5 条路由无重复键
- [ ] `ctx.settings.register('npm-manager', Config, { base })` 成功

### 12.3 运行时（用户本机）

- [ ] `dsh web` 启动后 Settings → Plugins 看到 npm-manager 卡片
- [ ] 点开能看到配置（scope / cacheTtlMs / enableChangelog / npmCommandTimeoutMs）
- [ ] 改 config 后 `scope.watch` 触发（apply 重跑或不跑，看 §5 行为设计）
- [ ] `pnpm install` 装 vendor/npm-manager 时**不** 报 404（§14）

---

## 13. 真包 API 速查（已从用户本机 dsh-tools/lib/types/schema.d.ts 读出）

```typescript
// 真包导出（不是 z.enum！）
Schema.union(['a', 'b', 'c']).default('a')           // ✅ enum 替代
Schema.string()                                       // ✅ 可选
Schema.string().required()                            // ✅ 必填
Schema.number().default(60_000)                       // ✅ 数字
Schema.integer().min(1).max(200)                      // ✅ 整数
Schema.boolean().default(true)                        // ✅ 布尔
Schema.object({
  additionalProperties: false,                      // ✅ 必须字面量（§5.1）
  properties: {                                       // ✅ 属性 map
    foo: { type: 'string', description: '...' },      // ✅ 属性节点
    bar: { type: 'integer', required: true },         // ✅ required 是布尔
  },
})
Schema.array({ items: {...} })                        // ✅ 数组
Schema.oneOf([A, B])                                 // ✅ 至少两个分支
Schema.literal('x')                                  // ✅ 字面量

// ✅ 属性节点的额外注解
description / title / default / examples / required

// ❌ 不要用：
{ type: 'object', properties: {...}, required: ['x'] } // required 数组形式
{ type: 'object', properties: {...}, additionalProperties: { type: 'string' } } // 非字面量
{ type: 'object' }                                    // 缺 additionalProperties
```

---

## 14. 完成度清单（与 dsh-plugin-conformance §11 铁律对齐）

| # | 铁律 | 我们满足吗 |
|---|---|---|
| 1 | 先读官方范例（dsh-tool-todo）| ✅（本 PLAN §0 已列）|
| 2 | `parameters` 是属性 map | ✅（§3.2 严格用 DSL）|
| 3 | `output` 必填 + `render` 必填 | ✅（§3.2 4 个工具全有）|
| 4 | 失败 throw 不吞 `{ok:false}` | ✅ |
| 5 | 改了源码必须重新 build + 校验产物 | ✅（§13 + scripts/build-client.mjs）|
| 6 | 官方没有 `dsh.plugin.yml` | ✅（删了旧的）|
| 7 | `inject` 只写服务名 | ✅（`['tools', 'webServer', 'settings']` 全是真服务）|
| 8 | 真实加载成功以插件 stdout 为准 | ✅（dev-conformance-check 跑通即成功）|
| 9 | `client.js` factory 必须 `return module.exports` | ✅（§6.1）|
| 10 | 加载期保持静默 | ✅（`ctx.logger`）|
| 11 | 客户端必须真打后端 | ✅（fetch + webServer）|
| 12 | `additionalProperties: false` 字面量 | ✅ |
| 13 | schema 错误用宿主真实编译器单测 | ✅（§13 四层）|
| 14 | `webServer` 路由 `(kind, path)` 唯一键 | ✅（§4.2）|
| 15 | 返回值 plain JSON | ✅（conformance §5.2 防御做法）|
| 16 | `must be an array` 先怀疑转换层 | ✅（不用 duck-typing）|
| 17 | 验证输出管线用真实映射函数 | ✅ |
| 18 | `must be an array` 先怀疑 | ✅ |
| 19 | "部分工具正常" 是定位金线索 | ✅ |
| 20 | 报错原文只能从日志/复现拿 | ✅（§13）|
| 21 | 状态门不要挂满所有入口 | ✅（§7.2 分级）|
| 22 | 错误文案里提到的工具必须存在 | ✅ |
| 23 | mock 测试不是验证 | ✅（§10/§13）|
| 24 | `check(name, async () => {})` 静默漏测 | ✅ |
| 25 | 自研插件不写 registry 版本号 | ✅（§1 workspace:*）|
| 26 | 不把插件库依赖写进 profile | ✅（workspace:*）|
| 27 | workspace 成员快照去掉 `scripts` | ✅（§14.2.1 + scripts/build-client）|
| 28 | 改 profile 后必须 pnpm install | ✅ |
| 29 | 部署脚本反向校验 | ✅ |
| 30 | 修好依赖解析会升级插件 → 主动告知 | ✅ |

---

## 15. 接下来（第 2 轮代码 + 第 3 轮部署清单）

**第 2 轮**（需要审批，因为涉及写代码）：
- 删旧 `src/`
- 写新 `src/index.ts` / `src/config.ts` / `src/services/*` / `src/tools/*` / `src/web/*`
- 写新 `client/client.js`（或先写 `client/src/index.tsx`，build 出 client.js）
- 写 `PLUGIN_DEV_GUIDE.md` + `scripts/dev-conformance-check.mjs` + `tests/*`

**第 3 轮**：
- 在用户本机用 `pnpm dsh web` 验证 Settings → Plugins 出现 npm-manager 卡片
- 列出真包/全局包，验证页面布局学 dsh-market
- 出"操作清单"（cordis.patch.yml 内容 + pnpm install + 重启 dsh）

---

**第 1 轮完成**。等你确认 PLAN 后进入第 2 轮。
