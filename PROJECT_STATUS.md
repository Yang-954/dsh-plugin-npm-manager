# PROJECT_STATUS.md — dsh-plugin-npm-manager

> 最新沉淀状态（**2026-10-27，版本 0.8.0**）。给下一个接手的 Agent 一眼看清"做到哪、怎么验证、还差什么"。
>
> ⚠️ 0.7.1 及以前的目标宿主是 DSH **0.1.5-rc.2**；0.8.0 已迁移到 **0.2.1-rc.3**。
> 检查报告见 [CHECK_REPORT_2026-10-27.md](./CHECK_REPORT_2026-10-27.md)。

## 一句话现状

**已适配 DSH 0.2.1 并全绿**：`npm test` 159 条断言零配置通过（含真实 0.2.1 宿主契约测试）。
检查报告里的 P0（settings API 被删）与 7 条 P1 全部修完；插件**当前未部署**（用户尚未装回 profile）。

## 0.8.0：为什么必须迁移

检查发现 0.7.1 在本机（DSH Desktop 0.2.1-rc.3）上**根本装不起来**：

| 层 | 问题 | 修法 |
|---|---|---|
| settings | `ctx.settings.register` 已被 0.2.1 删除（改为从 Config schema 派生） | `configure()` + `describe()` + `update(ns, patch, revision)` |
| 配置值 | `.volatile()` 字段解析后是 `{ get() }` 引用，不是裸值 | `readConfigValue()` / `State.cfg()` 统一解引用 |
| 热生效 | `scope.watch` 没了，loader 用 `updateVolatile` 原地写引用 | `State.syncConfig()` 读前对比快照 |
| 副作用 | effect setup 抛错时 cordis 只回收**该 effect 内**的 disposer | 面板放进 `ctx.inject(['settings'])` 子作用域做降级边界 |

**最危险的细节**：P0 崩溃后 **4 工具 + 6 路由仍留在宿主上**（`apply` 顶层的 `new State()`
与 effect 外的 `ctx.inject` 回调不归 effect 管）——「工具在、设置页没了」比全崩更难查。

## 0.8.0 修掉的 P1

| # | 缺陷 | 修法 |
|---|---|---|
| 1 | `updateType` 把所有 caret 依赖判成 major（`^18.2.0→18.3.0 = major`） | `parseVersion()` 统一归一化；不可比返回 `unknown` |
| 2 | GitHub token 发到 registry.npmjs.org（跨源泄露） | 只在 `api.github.com` / `raw.githubusercontent.com` 注入 |
| 3 | `/settings` 回显 `githubToken` 明文 | `redactConfigForClient()` 白名单投影 + `.role('secret')` |
| 4 | Windows `spawn('npm')` 必 ENOENT（两个升级工具 100% 不可用） | 新增 `npm-cli.ts`：`npm.cmd` + `shell:true` + 包名白名单 |
| 5 | `scope=global` 拼成 `-g@latest`，全局升级必失败 | `flags` 与包名分开传 |
| 6 | 客户端两份同名 `draftState` 互相覆盖（点应用崩） | 拆成 `draft`（路径）/ `cfgDraft`（配置） |
| 7 | SSE error 帧被 JSON.parse 的 catch 吞掉 | `try` 只包 `JSON.parse` |

## 目录结构

```
src/                 服务端（TS → tsc → lib/）
  index.ts           4 件套 + apply；effect 管理；清理链调 state.dispose()
  config.ts          Config（全部可写字段 .volatile() + min/max）+ readConfigValue
                     + SETTINGS_FIELDS + redactConfigForClient
  services/
    scanner.ts       三范围扫描 + discoverNodeProjects + 全局候选路径兜底
    registry.ts      registry 客户端（超时重试、精简投影缓存、parseVersion、sanitize）
    disk-cache.ts    跨重启磁盘缓存（损坏自愈、原子写、debounce）
    state.ts         项目列表、结果缓存、流式扫描、cfg() 解引用、syncConfig 热生效
    npm-cli.ts       ⭐ npm 子进程跨平台封装（Windows .cmd + shell + 包名白名单）
    guards.ts        npm_apply_upgrade 审批门（tools/pre-execute → {kind:'ask'}）
  tools/             4 个工具
  web/routes.ts      6 条路由；/packages 支持 stream=1 SSE；CSRF/Content-Type 校验
  web/settings.ts    0.2.1 settings 面板（configure/describe/update）
client/
  src/index.js       独立标签页源码（factory 体，React.createElement，无 JSX）
  client.js          构建产物
scripts/
  build-client.mjs   构建链：源码校验 → 套壳 → 产物复校
  patch-src.mjs      测试加载器：宿主探测（优先 dsh-tools >= 0.2）
  extract-core-from-asar.mjs  ⭐ 从桌面版 app.asar 解包核心包（按版本缓存）
  dev-conformance-check.mjs   schema 四层校验
tests/
  tool-schema-verify.mjs   79 断言（服务层 + 项目发现 + 缓存语义 + 超时 + 磁盘缓存）
  routes-verify.mjs        25 断言（宿主**真实** register/match + 流式帧 + CSRF）
  client-verify.mjs        22 断言（React 元素契约 + 模块 id + section + 加载态）
  host-contract-021.mjs    ⭐ 10 断言（真实 0.2.1 契约）
_diag/
  browser-check.mjs / cache-check.mjs / loading-check.mjs / measure-scan.mjs
```

## 如何验证

```bash
npm run build          # tsc → lib/
npm test               # 全量 159 断言，应全绿（会自动解包宿主核心）
```

`npm test` 无需任何环境变量：`scripts/patch-src.mjs` 会自动
（1）探测 `$DSH_HOME/profiles/*/node_modules`，（2）从桌面版 `app.asar` 解包核心包，
并**优先选 `dsh-tools >= 0.2` 的宿主** —— 旧行为是写死 `profiles/web`，
而该目录自 2026-10-17 起为空，导致 `npm test` 跑到第 2 段就崩。

部署后的**唯一可信判据**（静态）：

```bash
dsh --profile desktop --dump-config > /tmp/d.yml 2>/tmp/w.txt
grep -c 'npm-manager' /tmp/d.yml    # 必须 >= 1
grep 'not found' /tmp/w.txt         # 必须没有 npm-manager 那条
```

## 还差什么

### 0.8.0 已修完（原检查报告的 P0 + P1）

1. ~~settings API 被删导致插件装不起来~~ — 已迁移到 `configure/describe/update`
2. ~~Windows npm spawn 必 ENOENT~~ — 已用 `npm.cmd` + shell + 白名单
3. ~~`scope=global` 参数拼接~~ — 已分离 flags
4. ~~GitHub token 跨源/回显~~ — 已限制域名 + 响应投影
5. ~~updateType 误判~~ — 已归一化 + `unknown`
6. ~~客户端两份 draft / SSE error 帧~~ — 已拆开 + 移出 try

### 仍待办（改进类，不影响"能不能用"）

1. **冷扫描首次仍要几十秒**（无磁盘缓存时）。已通过渐进显示 + 缓存缓解（热路径 194ms）；
   真正的"第一次就快"需要批量接口或并发调优（本机吞吐次线性且测量噪声大）。
2. **`/settings` 的诊断探针**目前常驻（`serviceType` 探针仍每次请求执行一次）。
3. **`registry.ts` 重试策略**：目前对 4xx 也重试一次、无退避、404 无负缓存
   （检查报告 P2-7，尚未修）。
4. **`scanner.ts` 依赖段未去重**：同包在 deps+peer 会出两行、计数重复
   （检查报告 P2-8，尚未修）。
5. **`disk-cache.ts` 固定 `.tmp` 名**：两个 dsh 实例共用 DSH_HOME 时后写者丢条目
   （检查报告 P2-6，尚未修；单实例场景不受影响）。
6. **项目发现的边界**：不跟随符号链接；跳过 `_` 前缀目录。
7. **`vendor/` 里的 `node_modules` 备份**（若仍存在）：保留观察期后建议删除。删除前问一次。

## 部署要点（踩过的坑）

- **`node_modules/<plugin>` 是软链指向 `vendor/`** —— 改源码不同步 vendor 等于没改。
  ⚠️ 同步时**整目录替换 `lib/`**，别只 cp 单个文件。
- 自研插件用 `workspace:*`，不要写 registry 版本号。
- `cordis.patch.yml` 的 `name` 是**包名**，不是 pnpm 的 `link:` / `file:` 协议。
- 客户端 bundle 的 `id` 必须**逐字等于包名**。
- **`.gitignore` 别写 `*.patch.yml`** —— 会连 `cordis.patch.yml` 一起忽略（该文件是
  随包发布的 bundle patch，缺了插件挂不进配置树）。
- 本机**没有** esbuild / rolldown / tsdown；客户端手写 `React.createElement`，
  构建用确定性包装脚本，不引入新依赖。
- DSH 的 SPA 保持长连接，puppeteer 不能用 `waitUntil: 'networkidle*'`；
  点击要用真实鼠标事件；断言要限定选择器作用域。
- 本沙箱 shell **没有 `APPDATA`**（有 `LOCALAPPDATA` / `USERPROFILE` / `TEMP`）。
- 组件重新加载期间会**保留上一批行**，端到端断言要等范围独有标志或统计文本变化。

### ⚠️ dsh 起不来时先查这两件事

1. **孤儿锁** `~/.dsh/.credentials.yaml.lock`：
   ```
   dsh: plugin tree failed to load: failed to apply loader entry connection:
   atomic-write: timed out waiting for the writer lock at ...\.credentials.yaml.lock
   ```
   宿主 `dsh-atomic-write` 注释明确 *"orphan recovery is an operator action"* ——
   **不自动回收，必须手工删**。锁内容是持有者 PID，确认已死即可删。
2. **沙箱的 safe-delete 拦截器会让 dsh 释放不掉锁**：
   启动时要 `env -u NODE_OPTIONS CODEBUDDY_SAFE_DELETE_ENABLED=0`。

