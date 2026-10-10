# dsh-plugin-npm-manager — Plugin Development Guide

> 本项目**本身**就是一份"DSH 插件开发技能书"。本指南沉淀开发过程 + 关键技术决策 + 必避陷阱，
> 给未来 Agent 或复用本项目模板的开发者参考。
>
> **必读源**：`.workbuddy-ai/skills/dsh-plugin-conformance/SKILL.md`（1033 行，DSH 插件官方规范 + 30 条铁律）

---

## 0. 30 秒 TL;DR

```ts
// 一个能跑的 DSH 插件必须有的最小集合:
export const name = '...'               // ① 唯一标识
export const inject = ['tools', ...]    // ② 真实服务名（不是包名）
export { Config }                       // ③ schemastery schema
export function apply(ctx, config) {}    // ④ 启动副作用入口

export const Config = Schema.object({
  key1: Schema.union([...]).default('x'),     // ⚠ Schema.union 替代 z.enum
  key2: Schema.string(),                       // 可选 = 不调 .optional()
  key3: Schema.string().required(),            // 必填
  nested: Schema.object({                       // ⚠ object 必填 additionalProperties
    additionalProperties: false,
    properties: { ... },
  }),
})
```

**装到 DSH**：`pnpm add link:./vendor/your-plugin && pnpm install`（**workspace:*** 优于 link:）

---

## 1. 4 件套的细节（§2 铁律）

| 件 | 形态 | 易错 |
|---|---|---|
| `name` | 字符串,kebab-case | 不能含 `@`、不能与内置 bundle 同名 |
| `inject` | **服务名**（`tools`/`webServer`/`settings`/`agents`）| **不是包名**！写 `@deepseek-ai/xxx` 会永久 pending |
| `Config` | schemastery schema 对象 | `Schema.union([...])` 不是 `z.enum([...])` |
| `apply` | `(ctx, config) => void` | 加载期**不 console.***；用 `ctx.logger` |

**inject 白名单（§2 铁律 7）**：

| 服务 | 真实存在 | 来源 |
|---|---|---|
| `tools` | ✅ | `@deepseek-ai/dsh-tools` |
| `webServer` | ✅ | `@deepseek-ai/dsh-host-webserver` |
| `settings` | ✅ | `@deepseek-ai/dsh-settings` |
| `agents`、`home`、`credentials` | 按需 | 不在 inject 里写假名 |

**错误示范（永久 pending）**：
```ts
// ❌ 包名当服务名
export const inject = ['@deepseek-ai/dsh-client-ui-settings']
// → "pending (waiting for service: @deepseek-ai/dsh-client-ui-settings)"

// ✅ 服务名
export const inject = ['theme', 'slots']
```

---

## 2. Schema DSL 的 3 处硬差异（§5.1 铁律 11）

`output.schema` **不是 JSON Schema**，走 `dsh-tools` 自己的 schema 编译器。三处最容易踩：

### 差异 1：`required` 是属性节点上的**布尔**

```ts
// ❌ 错(原始 JSON Schema 风格)
parameters: {
  type: 'object',
  properties: { foo: { type: 'string' }, bar: { type: 'integer' } },
  required: ['bar'],                              // 错：数组形式
}

// ✅ 对(DSL 风格)
parameters: {
  foo: { type: 'string' },
  bar: { type: 'integer', required: true },       // 对：属性节点上的布尔
}
```

### 差异 2：`additionalProperties` 必须字面量

```ts
// ❌ 错（内嵌 schema 形式）
additionalProperties: { type: 'string' }
// → schema.properties.X.additionalProperties must be explicitly true or false

// ✅ 对
additionalProperties: false    // 或 true
```

### 差异 3：关键字白名单受限

| 节点 | 允许 |
|---|---|
| `type:'object'` | `type`、`properties`、`additionalProperties` |
| `type:'array'` | `type`、`items` |
| 标量(string/number/integer/boolean/null) | `type`、`enum`、`const` |
| `oneOf` 分支 | `oneOf`、`type`(二者不能同时) |
| 通用注解(所有节点) | `description`、`title`、`default`、`examples` |
| **只给属性节点** | `required`(且必须 === true) |

**详细源码**：`@deepseek-ai/dsh-tools/lib/types/schema.js` 的 `assertAuthorKeys`

---

## 3. 返回值必须是 lossless JSON（§5.2 铁律 12）

`defineTool` 执行链路：
```
execute() → snapshotToolValue() → snapshotJsonValue() → validateJsonSchemaValue() → render()
```

**`snapshotJsonValue` 严格规则**（违反任意一条 → `value is not lossless JSON`）：

| 规则 | 违反后果 |
|---|---|
| 对象原型必须是 `Object.prototype` 或 `null` | 同上 |
| 数组原型必须是 `Array.prototype`，且无稀疏键 | 同上 |
| **`Buffer` 不是 JSON 值** | 同上 |
| `Map` / `Set` / `Date` 不是 JSON 值 | 同上 |
| 数值必须有限且非 `-0` | 同上 |
| 不能有循环引用 | 同上 |

**典型 bug**：imapflow 返回 `Buffer`、`Map`、`Date` —— 在 execute 里剥掉/转换掉：

```ts
// ✅ 正确
const safe = {
  ...detail,
  attachments: detail.attachments.map(a => ({
    filename: a.filename, mimeType: a.mimeType, size: a.size,  // 不要 Buffer
  })),
  date: detail.date?.toISOString(),  // Date → string
}
return safe
```

**绝对禁止**：duck-typing 判断 Buffer（**灾难写法**）：

```ts
// ❌ 灾难：会把数组误判成 Buffer,因为数组也有 length/slice/toString
function isBuffer(v) {
  return typeof v.length === 'number'
    && typeof v.slice === 'function'
    && typeof v.toString === 'function'
}
// → 所有数组变成 {__type:'Buffer', data:'a,b', size:2}
// → "value.emails must be an array" 报错指向 schema, 真因是转换层

// ✅ 唯一判据
function isBuffer(v) {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(v)
}
```

---

## 4. mock 测试 ≠ 验证（§13.1 铁律 23）

**真实事故**：`phase1-verify.mjs` 有 40 个「凭证安全场景」全过，但**内联重写**了加解密逻辑（不 import 真实 `CredentialStore`）。线上 P0/P1 全没发现。

**自查判据**：
```bash
grep -n "from '../../dist\|from '../dist\|import.*dist/" tests/unit/*.mjs
# 没有 → 你在测另一份代码
```

**正解**：能实例化就实例化。

```ts
// ✅ 真实测试
import { CredentialStore } from '../../dist/credentials/store.js'
const dir = await mkdtemp(join(tmpdir(), 'plugin-test-'))
const store = new CredentialStore({ storageDir: dir, ... })
await store.unlock()
```

**沙箱无 dist 时**：用 §10 的"宿主真实编译器单测"路径（conformance §13），按 dsh-tools 真包类型推断，避免内联 mock。

---

## 5. webServer 路由唯一键（§5.3 铁律 14）

```ts
ctx.webServer.register({ kind: 'exact', path: '/x', handler: get })
ctx.webServer.register({ kind: 'exact', path: '/x', handler: post })
// → "duplicate exact route" 报错

// ✅ 合并
ctx.webServer.register({
  kind: 'exact', path: '/x',
  handler: async (req, res) => {
    if (req.method === 'GET') return get(req, res)
    if (req.method === 'POST') return post(req, res)
  },
})
```

⚠️ 注册失败**只打印一行 `failed to install web routes` 日志**，**不影响插件其余部分加载**——容易漏看。

---

## 6. client.js factory 必须 return module.exports（§11 铁律 9）

```javascript
// ❌ 灾难:factory 闭合前忘了 return module.exports
function apply() { ctx.inject(...) }
// → loader 拿到 undefined → "received undefined"

// ✅ 必须
window.__ModuleLoader__.load({
  id: 'your-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    // ...你的代码...
    return module.exports   // ← 必需
  },
})
```

**加载期保持静默（§11 铁律 10）**：
```javascript
// ❌ 污染 dsh web 的 token URL
exports.apply = function (ctx) { console.log('plugin loaded') }
// ✅ 用 ctx.logger
exports.apply = function (ctx) { ctx.inject(...) }
```

---

## 7. 部署：自研插件绝不能声明成 registry 版本号（§14 铁律 25）

```jsonc
// ❌ 致命：pnpm 找不到 @deepseek-ai/schemastery@1.2.3 → 整个 profile 所有插件无法更新
{ "dependencies": { "your-plugin": "1.2.3" } }

// ✅ 用 workspace:*
{ "dependencies": { "your-plugin": "workspace:*" } }
// + pnpm-workspace.yaml 登记 vendor/your-plugin 为成员
```

**三种接入协议对比（§14.2）**：

| 协议 | 改源码生效 | 装依赖 | 库名进 manifest？ |
|---|---|---|---|
| `link:./vendor/x` | ✅ | ❌ 否 | ❌ 否 |
| `file:./vendor/x` | ❌ | ❌ 否 | ❌ 否 |
| `workspace:*` | ✅ | ✅ 是 | ❌ 否（**推荐**）|

**workspace 成员快照必须去掉 `scripts`（§14.2.1）**：
```ts
// 部署脚本里手动清理
const snap = JSON.parse(await readFile(pkgPath, 'utf8'))
delete snap.scripts
delete snap.devDependencies
await writeFile(pkgPath, JSON.stringify(snap, null, 2))
```

**否则 pnpm 会在 install 时跑 `npm run build` → 找不到 tsconfig.json → 安装失败**。

---

## 8. §13 schema 验证 4 层（部署前必跑）

```ts
// 层 1: schema 静态编译
defineTool({ name, description, parameters, output, execute })
// ↑ 这步本身抛 = schema 写错

// 层 2: 返回值校验（用宿主真实编译器）
const compiled = defineTool({ ... }).output.schema
const violations = validateJsonSchemaValue(compiled, sampleValue, 'value')
assert.deepEqual(violations, [])

// 层 3: 反向断言
assert.ok(validateJsonSchemaValue(compiled, { WRONG: 'bad' }, 'value').length > 0)

// 层 4: 全量注册
registerTools({ tools: { register: (t) => { registered.push(t); return () => {} } } }, {})
assert.equal(registered.length, EXPECTED_TOOL_COUNT)
```

**关键**：必须用**宿主真实 `dsh-tools`**（不是 mock）。沙箱无 npm install 时，**跳过而非失败**（peer dep 缺失不该让 CI 变红）。

---

## 9. 本项目（npm-manager）的关键决策沉淀

### 决策 1：scanner 用 fs.readdirSync 而非 `npm ls`

**背景**：沙箱 spawn 真 npm 子进程 EPERM 失败。

**选 fs**：扫 `node_modules/*/package.json` + 全局 `APPDATA/npm/node_modules/*/package.json`。
**优点**：零子进程、纯 fs、稳定。
**缺点**：扫不到 workspace、peer 冲突等情况。

### 决策 2：changelog 暂不实现

**背景**：GitHub Releases API + raw.githubusercontent.com 都依赖外网，沙箱无法保证可达。

**当前**：changelog section 为空数组，`enableChangelog` flag 保留，**留到部署时接**。
**schema**：`changelog` 字段类型仍是 `array`（不会因空数组 schema 失败）。

### 决策 3：client.js 用占位（不构建）

**理由**：第 3 轮 build 链接入前，先让 DSH Loader 能加载是首要目标。
**占位版**：手写 `window.__ModuleLoader__.load`，用纯 DOM 渲染包列表（不开 React JSX）。
**验证**：跑了 `client-verify.mjs` §11 铁律 9（return module.exports）。

---

## 10. 调试技巧

### 10.1 报错快速定位

| 报错 | 真因 | § |
|---|---|---|
| `pending (waiting for service: X)` | inject 写错（包名当服务名）| §2 |
| `must declare output { schema, render, presentationMeta? }` | output 缺或 render 不是函数 | §5 |
| `failed to register tools` | 整批失败（任一工具 schema 错） | §5.1 |
| `unsupported JSON schema: schema.X is not supported by the value schema DSL` | schema 用 DSL 不支持的关键字 | §5.1 |
| `value is not lossless JSON` / `"value.X" must be an array` | 返回值不合规（Buffer/Map/Date/字段漂移） | §5.2 |
| `failed to install web routes` | 路由重复或 handler 抛错 | §5.3 |
| `webserver: duplicate exact route` | (kind, path) 重复 | §5.3 |
| `duplicate exact route` 静默吞错 | 不影响插件其余加载, 易漏看 | §5.3 |
| `ERR_PNPM_FETCH_404` 拖垮所有插件 | profile deps 里写了 registry 规格的未发布包 | §14 |

### 10.2 `must be an array` 先怀疑自己的转换层

**schema 声明 array 却报 `must be an array`** —— **值**不是数组，先看 execute 返回前经过的每一层转换。

### 10.3 "部分工具正常" 是定位金线索

查正常的那几个与失败的区别（走了哪条代码路径），通常一步就能锁定真因。

---

## 11. 工具书使用指南

### 11.1 怎么读本指南

- **第 1 次写插件**：按章节顺序读，重点看 §0 TL;DR + §1 + §2 + §3
- **已写过 1 个插件**：重点看 §3 + §4 + §5 + §10（避坑）
- **写第 2 个插件**：重点看 §7 部署 + §8 schema 验证（CI 接入）

### 11.2 怎么用本项目作为模板

1. 复制 `src/` `client/` `tests/` `scripts/` `cordis.patch.yml` `package.json`
2. 改 `name` / 业务逻辑 / schema
3. 跑 `scripts/dev-conformance-check.mjs`（§13 四层）
4. 部署到 vendor + pnpm install（§14）

### 11.3 升级路径

- 升级 DSH 时，profile 内 `@deepseek-ai` 要整体对齐（§profile-forensics §2.1）
- 改源码后**必须**重新 build + 校验产物（§11 铁律 5）

---

## 12. 参考链接

- `~/.workbuddy-ai/skills/dsh-plugin-conformance/SKILL.md` —— 30 条铁律 + 12 类报错 + 完整范例
- `~/.workbuddy-ai/skills/dsh-profile-forensics/SKILL.md` —— profile 损坏诊断
- DSH 官方 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) monorepo
- dsh-market 参考实现（已装在你的 `~/.dsh/profiles/web/node_modules/dshmarket/`）

---

## 13. 沉淀来源

本指南来自：
- dsh-plugin-conformance skill 1033 行原文（30 条铁律 + 12 类报错）
- dsh-market 真实源码（已读 src/index.ts + client/client.js + package.json）
- dsh-tools 真包 TypeScript 类型定义（已读 types/schema.d.ts + types/index.d.ts）
- email-assistant 完整插件范例（数据层 + credentials 状态门案例）
- 本项目 Round 12+ 重写实战

---

**遵循 dsh-plugin-conformance §11 铁律**：1 先读范例 / 2 attributes map / 3 output 必填 / 4 throw 不吞 / 5 build+校验 / 6 无 dsh.plugin.yml / 7 服务名 / 8 真实 stdout / 9 return module.exports / 10 加载期静默 / 11 客户端真打后端。
