# 项目检查报告 — dsh-plugin-npm-manager

> 检查时间：2026-10-27 16:05 → 16:45（UTC+8）
> 检查者：小鲸鱼 🐳（DeepSeek Harness）
> 方式：只读体检 + 定向复现（未修改任何源文件、未执行 `npm install`、未部署）
> 被检版本：`package.json` = **0.7.1**（源码 2026-09-21 冻结，此后 5 周无改动）
> 目标宿主：本机 DSH Desktop **0.2.1-rc.3**（`dsh-tools` / `dsh-settings` / `dsh-host-webserver` 均为 0.2.1-rc.3，cordis 4.0.5，schemastery 3.18.5）

---

## 0. 一句话结论

**架构方向正确、注释质量高，但当前版本在 0.2.1-rc.3 宿主上「装了也起不来」，且升级链路的 Windows / global 两条路径必然失败。**
测试看似全绿，实际已被「宿主路径写死 + 契约 mock」掩盖；建议按 §6 的顺序修完 P0/P1 再谈部署。

**当前是否在跑：否。** 本机 `~/.dsh/profiles/desktop`（唯一的活跃 profile）的 `dsh.profile.bundles` 与 `node_modules` 里都**没有** `dsh-plugin-npm-manager`，即插件处于「已下线」状态。所以下面的 P0 不会立刻炸，但只要按 `DEPLOY.md` 装回去就会炸。

---

## 1. 体检结果（可复现）

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `./node_modules/.bin/tsc --noEmit` | ✅ 0 error（strict / noUnusedLocals 全开） |
| 客户端构建 | `node scripts/build-client.mjs` | ✅ 11 项校验全过，产物与 HEAD 逐字节一致 |
| 服务层测试 | `node tests/tool-schema-verify.mjs` | ✅ **72 通过 / 0 失败** |
| 客户端测试 | `node tests/client-verify.mjs` | ✅ 22 通过 / 0 失败 |
| 路由测试 | `node tests/routes-verify.mjs` | ❌ **崩溃**（非断言失败） |
| 契约测试 | `node scripts/dev-conformance-check.mjs` | ❌ **崩溃**（同上） |
| 全量 | `npm test` | ❌ **exit 1**（跑到第 2 段就崩） |

崩溃根因（环境，非代码逻辑）：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  'C:\Users\Admin\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-tools\lib\index.js'
```

`scripts/patch-src.mjs:25` 把宿主包路径**写死**成 `C:/Users/Admin/.dsh/profiles/web/node_modules/@deepseek-ai`，而本机 `profiles/web/` 从 2026-10-17 起已是**空目录**（实际活跃 profile 是 `profiles/desktop`）。`tests/routes-verify.mjs:49` 同样只找 `profiles/web`。

→ **结论：`PROJECT_STATUS.md` 里「`npm test` 全量 154 断言应全绿」在当前机器上不再成立**，且崩溃发生在「跳过」分支之前，看起来像真失败。

---

## 2. P0 — 会直接导致插件不可用

### P0-1 设置面板用了 0.2.1 已删除的 API

- **位置**：`src/web/settings.ts:13`（`ctx.settings.register('npm-manager', Config, { base })`）
- **事实**：0.2.1-rc.3 的 `dsh-settings` 服务类 `SettingsForms` 只有 `configure / describe / update / replace / mutate`，**没有 `register`**；命名空间改为「从插件 Config schema 派生」，且只有标了 `.volatile()` 的字段可写。
- **复现**（用真实 0.2.1 方法面 mock settings 服务后加载 `lib/index.js`）：

```
APPLY_THREW: TypeError: ctx.settings.register is not a function
after-failure tools=4 routes=6
```

- **额外发现（比崩溃更严重）**：`apply` 里 `ctx.effect(...)` 的 setup 抛错后，cordis 只回收**该 effect 内**已注册的 disposer；而 `State` 是在 `apply` 顶层 `new State(...)` 的。实测崩溃后 **4 个工具 + 6 条路由仍然注册在宿主上**，形成一个「工具在、设置页没了」的半残状态 —— 路由里的 `POST /settings` 也会因为 `settingsScope === null` 恒返回「只读降级」。
- **修复方向**：二选一
  1. 迁移到 0.2.1：`ctx.inject(['settings'], sctx => sctx.settings.configure({ auto: false }, ctx.fiber))` + `describe()` + `update(entryId, patch, revision)`，并给可写字段加 `.volatile()`；
  2. 短期止血：`engines.dsh` 锁 `<0.2.0`，并在 `installSettingsPanel` 里 `typeof ctx.settings.register === 'function'` 判空降级（dsh-market 的 `canRegister()` 就是现成范例）。

---

## 3. P1 — 功能必坏或数据/凭据外泄

### P1-1 `updateType` 对所有 caret/tilde 依赖判成 major（已复现）

- **位置**：`src/services/registry.ts:146-155`（`detectUpdateType`）
- **原因**：`cmpVersion` 剥了 `^~>=<`，但 `detectUpdateType` 里 `String(current).split('.')` 没剥 → `'^18'` → `parseInt` → `NaN` → `|| 0` → 0，于是 `0 < 18` 命中 `major`。
- **实测**：

```
^18.2.0 -> 18.3.0 = major      （应为 minor）
~2.1.0  -> 2.2.0  = major      （应为 minor）
1.2.3   -> 1.2.4  = patch      （正确）
workspace:* -> 1.0.0 = major   （应为「不可比」）
2.0.0-beta.1 -> 2.0.0 = same   （应为 patch/预发布升级，漏报）
```

- **影响面**：`project` / `system` 是默认范围，几乎**每个**项目依赖都带 `^`，所以「黄色徽章 + updateType」这一列基本全错，用户会被误导成「全是大版本升级」。

### P1-2 `githubToken` 被发到 registry.npmjs.org（跨源凭据泄露）

- **位置**：`src/services/registry.ts:230`（`fetchJson`，只用于 npm registry）
- **事实**：`if (this.githubToken) headers['Authorization'] = 'Bearer ...'` 出现在 `fetchJson` 里；该 token 本应只用于 `api.github.com` / `raw.githubusercontent.com`（`:397` 才是正确分支）。
- **后果**：① 用户的 GitHub PAT 被送到第三方（npm registry）；② token 失效/权限不符时，**所有**包元数据请求变 401 → 整页空。

### P1-3 `/settings` 把 `githubToken` 原样回显给浏览器

- **位置**：`src/web/routes.ts:242`（POST 成功后 `current: state.config`）与 `:251`（GET）
- **实测**：`Config({githubToken:'xxx'})` 的 JSON **确实包含** 该值（`JSON.stringify(c).includes(secret) === true`）。
- **矛盾点**：`config.ts:48` 的注释明确写「`githubToken` 刻意不放进 SETTINGS_FIELDS —— 不该在面板里回显」，但响应体整体 dump 把它漏了出去。测试只断言了 `fields` 不含 token，**没断言 `current`**，所以是假绿。

### P1-4 Windows 上 `spawn('npm', ...)` 必然 ENOENT（已复现）

- **位置**：`src/tools/preview-upgrade.ts:41`、`src/tools/apply-upgrade.ts:40`
- **实测**（直接调用插件真实 `defineTool` 执行体）：

```
PREVIEW_RESULT={"packages":[{"name":"left-pad","warnings":["预览失败: spawn npm ENOENT"]}]}
```

  裸 `spawn('npm')` 与 `spawn('npm.cmd')` 均失败（后者 `EINVAL`）；`spawn('npm', {shell:true})` 成功返回 `11.17.0`。
- **影响**：`npm_preview_upgrade` 与 `npm_apply_upgrade` 在本机 **100% 不可用**，且失败被包装成「预览失败」提示，用户看不出是环境问题。
- **修复**：win32 分支用 `npm.cmd`（Node 24 上需 `shell:true` 或 `cmd.exe /d /s /c`），并对包名做严格白名单校验（`^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$`）后再交给 shell。

### P1-5 `scope=global` 参数拼接错误（已复现）

- **位置**：`src/tools/apply-upgrade.ts:127` + `:37`
- **实测**：

```
const target = ['-g', ...packages]        // :127
const args = ['install','--json', ...target.map(p => p+'@latest')]   // :37
→ ["install","--json","-g@latest","cowsay@latest"]
```

  `-g` 被当成包名拼成了 `-g@latest`，**全局升级必失败**。

### P1-6 客户端两个同名 `draftState` 互相覆盖（已复现）

- **位置**：`client/src/index.js:379-381`（自定义路径，string）与 `:411-413`（配置表单，object）
- **事实**：`var` 重复声明，后者覆盖前者；构建产物 `client/client.js:385 / :417` 里**两份都在**。
- **实测**：

```
draft.trim() → TypeError: draft.trim is not a function   （draft 实际是 {}）
for (const k in 'abc') → {"0":"a","1":"b","2":"c"}       （配置 patch 会把字符串下标当字段）
```

- **触发**：打开「自定义路径」→ 点「应用」直接崩；或先编辑配置表单再用自定义路径。
- **修复**：拆成 `customPathDraft` / `cfgDraft` 两份 state。

### P1-7 SSE `error` 帧被 JSON.parse 的 catch 吞掉

- **位置**：`client/src/index.js:653`（`try { applyEvent(JSON.parse(...)) } catch (e) { /* 跳过坏帧 */ }`）
- **原因**：`applyEvent` 对 `{type:'error'}` 是 `throw new Error(...)`，但它在 `try` 里 → 被当成「坏帧」静默吞掉，界面永远停在 `streaming`、刷新按钮的 busy 收不回。
- **修复**：`try` 只包 `JSON.parse`，`applyEvent` 移到 `try` 外；error 帧显式 `setView('error')` + `finish()`。

---

## 4. P2 — 正确性/健壮性缺陷（按影响排序）

| # | 位置 | 问题 | 证据 |
|---|---|---|---|
| 1 | `registry.ts:251-254` | 按次 TTL 对磁盘层无效：10 分钟的「changelog 找不到」负缓存被按 `diskCacheTtlMs=24h` 落盘并跨重启 | `this.disk.set(key, value, this.diskTtlMs)` 忽略 `ttlMs` |
| 2 | `state.ts:394-405` + `:477`/`:520` | 解析失败的包被静默丢弃；`meta.total` 用 `installed.length`、`done.totalCount` 用 `packages.length`，进度永远停在中途且无 error 帧 | `} catch { return null }` |
| 3 | `state.ts:573` | 非流式路径 `Promise.all` 无并发上限（流式是 16），`system` 范围一次打 220~300 个 registry 请求，且无单飞去重 | `await Promise.all(installed.map(...))` |
| 4 | `state.ts:426-434` | 失效竞态：扫描中途点「刷新缓存」，在途扫描结束仍会 `cachePut` 并把旧数据标成新 `scannedAt` | `cacheHit` 只看 TTL，不看 `cacheInvalidatedAt` |
| 5 | `disk-cache.ts:136-141` / `:174` | 缓存文件损坏即 `disabled=true` 且 `loaded=true`，**永久禁用本进程**；`clear()` 不复位，坏文件也不删 → 重启后再次禁用 | `catch { this.disabled = true }` |
| 6 | `disk-cache.ts:212-215` | 固定 `.tmp` 名 + 整文件覆盖：两个 dsh 实例共用 DSH_HOME 时后写者丢条目；并发 flush 有发布半截文件风险（**待验证**） | `const tmp = this.file + '.tmp'` |
| 7 | `registry.ts:205-221` | 重试不区分状态码：404/401/403 也重试一次、无退避、404 无负缓存 → 缺失包每轮固定打 2 次 | `if (attempt === 0) continue` |
| 8 | `scanner.ts:52-61` | 四段依赖全量拼接不去重：同包在 deps+peer 出现两行、`totalCount`/`outdatedCount` 重复计数；`peerDependencies` 未必安装却被当已安装 | 逐条 `result.push` |
| 9 | `state.ts:416-424` | `projectPath` 完全不校验（任意绝对/相对/UNC 路径直通），且 `system` 范围下该参数被忽略却仍参与 `keyOf` → 同数据重复缓存、键无界增长 | `projectPath.trim()` |
| 10 | `config.ts:11-37` | Schema 无 `.min()/.max()`，`SETTINGS_FIELDS` 的 min/max 只给前端渲染；`POST /settings` 可写 `requestTimeoutMs: 0` → 全部请求立刻 abort → 空列表且无报错 | `Schema.number().default(15_000)` |
| 11 | `state.ts:317-323` + `index.ts:86-92` | `State.dispose()` 是死代码，热卸载会丢 debounce（≤1.2s）内最后一批落盘 | cleanup 未调用 `state.dispose()` |
| 12 | `index.ts:57-66` | `ctx.inject(['workspaceRegistry'])` 的回调只 set provider，**卸载时没有还原**；热重载后旧闭包仍指向旧 `sctx` | 无 `ctx.effect` 包裹 |
| 13 | `web/routes.ts:89-113` | SSE 不接 `req`、不监听 `close`、不看 `res.write()` 返回值 → 客户端断开后 16 个 worker 仍扫完；无背压 | `streamPackagesTo(res, ...)` |
| 14 | `web/routes.ts:230` | `readJsonBody` 不看 `Content-Type`，预解析 `req.body` 分支还**绕过 64KB 限制**；无 Origin/CSRF 校验 → 任意本机网页可 POST 改配置 | `if (req.body ...) return req.body` |
| 15 | `tools/get-package-info.ts:13,52` | `currentVersion` 默认 `'0.0.0'` 却宣称「自动从 node_modules 推断」；包不存在时返回 `null`，0.2.1 的 `createSuccessResult` 会判 `ToolOutputError` | `validateJsonSchemaValue(tool.output.schema, detached)` |
| 16 | `tools/preview-upgrade.ts:55` | `code === 0 \|\| code === 1` 都当成功，parse 失败 `resolve({})` → 网络错误/包不存在被误报成「无变化」 | 同上 |
| 17 | `tools/*-upgrade.ts` | `packages` 参数未标 `required`，省略时 `for...of undefined` / `.map` 直接 TypeError | schema 无 `required` |
| 18 | `client/src/index.js:451,683-690` | 除流式外所有 fetch 无超时；refresh 回包后再发 load；卸载后仍 `setState`；旧请求可覆盖新状态 | 无 AbortController / generation id |

---

## 5. 安全专项

| 项 | 结论 |
|---|---|
| 凭据进模型可见错误 | ✅ 已修（`sanitizeNpmStderr` / `sanitizeFetchError`），本版未回归 |
| 凭据进 HTTP 响应 | ❌ **P1-3**：`/settings` 回显 `githubToken` |
| 凭据跨源发送 | ❌ **P1-2**：GitHub PAT 发往 npm registry |
| 命令注入 | 🟡 `spawn` 无 shell（注入面小），但 P1-4 修成 `shell:true` 后**必须**同时加包名校验 |
| 任意路径读取 | ❌ **P2-9**：`?project=` 可读任意目录 `package.json` |
| 路由鉴权 | ❌ 裸路由无鉴权/无 Origin 校验；宿主 `dsh-host-webserver` README 明确「不提供 server-wide 认证，由 route owner 自己负责」——本项目没做 |
| XSS | ✅ 无 `innerHTML` / `dangerouslySetInnerHTML` |
| 审批门 | ✅ `tools/pre-execute` + `{kind:'ask'}` 用法与 0.2.1 一致（`dsh-tools` 里 `gate.kind === 'ask'` 分支仍在） |

---

## 6. 建议修复顺序

**第 1 批（不修就不能用）**
1. P0-1 设置 API 迁移（或 `engines` 锁版本 + 判空降级）
2. P1-4 Windows npm spawn（+ 包名校验）
3. P1-5 global 参数拼接
4. P1-2 / P1-3 凭据（发错源 + 回显）

**第 2 批（用户立刻能看见的错）**
5. P1-1 `detectUpdateType` 归一化（+ 非版本协议给「不可比」状态）
6. P1-6 / P1-7 客户端两份 draft + SSE error 帧
7. P2-1 磁盘 TTL 取 `min(ttlMs, diskCacheTtlMs)`
8. P2-5 损坏文件 `dropFile()` + 允许重载

**第 3 批（健壮性）**
9. P2-2 / P2-3 / P2-4 / P2-13（失败可见、并发上限、失效代数、SSE 断连）
10. P2-8 / P2-9 / P2-10 / P2-14（去重、路径校验、schema 范围、Content-Type）
11. P2-11 / P2-12 / P2-15~18

**第 4 批（工程卫生）**
12. `scripts/patch-src.mjs:25` 与 `tests/routes-verify.mjs:49` 改为「按 `DSH_HOME` + `profiles/desktop` 探测」，别再写死 `profiles/web`
13. 测试补真契约：0.2.1 settings 集成、真实 spawn、带真实 state 的 React 交互、token 断言覆盖 `current`
14. `.gitignore:27` 的 `*.patch.yml` 把 **`cordis.patch.yml` 也忽略了** → 这个「随包发布的 bundle patch」**没进 git**（本机有、仓库无，换机器 clone 直接缺文件）；建议改成只忽略 `_diag/*.patch.yml` 与根级验证 overlay
15. `package.json#files` 里的 `src` 会把 35 个 `.patched.*` 临时产物打进 tarball；`src/types.ts` 是死文件；`User-Agent` 还写着 `0.6.0`；README 说「5 条路由」实际 6 条

---

## 7. 附录：本次复现证据

```text
# 1) 0.2.1 settings 契约
APPLY_THREW: TypeError: ctx.settings.register is not a function
after-failure tools=4 routes=6        ← effect 失败后工具/路由仍在宿主上

# 2) updateType
^18.2.0 -> 18.3.0 = major
~2.1.0  -> 2.2.0  = major
workspace:* -> 1.0.0 = major
2.0.0-beta.1 -> 2.0.0 = same

# 3) Windows spawn
spawn('npm', ['--version'])        → ERROR ENOENT / close -4058
spawn('npm.cmd', ['--version'])    → SYNC THROW EINVAL
spawn('npm', ['--version'], {shell:true}) → close 0, out 11.17.0
PREVIEW_RESULT = 预览失败: spawn npm ENOENT

# 4) global 参数
["install","--json","-g@latest","cowsay@latest"]

# 5) 客户端 draft 冲突
draft.trim() → TypeError: draft.trim is not a function
for (const k in 'abc') → {"0":"a","1":"b","2":"c"}

# 6) token 回显
Config({githubToken:'xxx'}) 的 JSON 包含该值 → true

# 7) 测试
tsc --noEmit           → 0 error
tool-schema-verify     → 72 / 0
client-verify          → 22 / 0
routes-verify          → ERR_MODULE_NOT_FOUND（profiles/web 已空）
dev-conformance-check  → ERR_MODULE_NOT_FOUND
npm test               → exit 1

# 8) 部署状态
profiles/desktop/package.json  dsh.profile.bundles → 无 dsh-plugin-npm-manager
profiles/desktop/node_modules  → 无 dsh-plugin-npm-manager
profiles/web/                  → 空目录（2026-10-17 起）
```

---

## 8. 相关历史

- 已解决问题：[dsh-plugin-npm-manager-token-leak](../../.agent/problems/solved/2026-09-19-dsh-plugin-npm-manager-token-leak.md)（本版 sanitize 未回归）
- 环境问题：[no-npm-pnpm-toolchain](../../.agent/problems/active/2026-09-19-no-npm-pnpm-toolchain.md)（`npm` 已在 PATH，但 `spawn` 仍受 Windows `.cmd` 限制 —— 与本报告 P1-4 同源不同层）
