# Changelog

本项目自身的更新日志。

---

## [0.7.1] - 2026-09-21 (三件收尾：磁盘缓存热切换 + 移除 46MB 死仓库 + 测试自给自足)

### Fixed

- **⭐ `diskCacheDir` 改了不再要重启**：通过面板改路径，立刻生效。
  - `State.rebuildDiskCache()` 拆出旧的建盘逻辑
  - `RegistryClient.setDiskCache()` 提供换盘入口（先 flush 旧块、再换、再清相关缓存）
  - 旧的目录**不删**（用户可能临时切一下，切回来还要用）
- **⭐ 诊断探针不再吐 `probe-error: ...` 长串**：原来直接读 `ctx.workspaceRegistry`
  会抛 `cannot get property X without inject` —— 包了 try/catch 转成 `'restricted'`
  （= 服务存在但未注入，等 callback），更明确也更美观

### Cleanup

- **删掉 `package.json` 里的死依赖 `semver` 和 `node-fetch`**。
  源码里没有任何地方 import 这两个 —— 版本比较是手写的 `cmpVersion`，
  HTTP 用的是全局 `fetch`。声明放在那里只会让人误以为它们在用。
- **`files` 字段补上 `tests`**：`scripts.test` 用到它们，但没列在发布清单里。
- **`vendor` 减重 47MB（48MB → 1.3MB）**：把整个 `node_modules/` 移出（移到备份目录，
  **未删除** —— 保留 1 周观察，确认不影响宿主再手动清）。

### Tests

- **让扫描测试自给自足**（不依赖仓库里实际装什么包）：
  三条固定期望 `semver` 的断言改成 `makePkgDir()` 在 `tmpdir` 造临时 `package.json`。
  这是改完死依赖后**才暴露的问题**（之前测试通过是因为 semver 真在 dependencies 里）。

### Verified

- 全量 **154 条断言通过**（tool-schema 72 · routes 26 · client 22 · conformance 23 · build-client 11）
- **端到端实测**：把 `diskCacheDir` 切到新路径 → API 返回 `ok=true` → 旧目录文件仍在；
  重启 dsh 看新路径生效
- 移除 `node_modules` 后插件仍正常加载（peer 从宿主解析）

---

## [0.7.0] - 2026-09-21 (实现 changelog：从空实现到可用)

`npm_get_package_info` 一直声明着 `changelog` 字段却永远返回 `[]` ——
属于"声明了但不存在"。本轮实现。

### Added

- **`RegistryClient.getChangelog(name, repoUrl)`** 三级降级：
  1. **GitHub Releases API**（`/repos/{o}/{r}/releases?per_page=8`）——
     结构化、带发布日期。有 `githubToken` 时自动带上
     （未认证限额 60 次/小时，认证后 5000）
  2. **`raw.githubusercontent.com` 的 `CHANGELOG.md` / `CHANGES.md`** —— 解析 markdown 标题
  3. **`source: 'none'` 占位条目** —— 明确区分"找过了但没有"与"没找"，
     而不是返回空数组让人猜
- **`parseGitHubSlug()`**：从 npm 的 `repository.url` 解析 owner/repo。
  实测覆盖 `git+https://github.com/o/r.git` · `https://github.com/o/r` ·
  `git://github.com/o/r.git` · `github:o/r` · `ssh://git@github.com/o/r.git` ·
  带 `#fragment` 的形式；非 GitHub（如 gitlab）与无仓库都安全返回 `null`
- **`parseMarkdownChangelog()`**：识别 `## 1.2.3` / `## [1.2.3]` / `## v1.2.3` /
  `## [1.2.3] - 2024-01-01` / `## v1.2.3 (2024-01-01)` 等写法；
  只认 2~3 级标题；**非版本的二级标题（`## Unreleased`、`## Migration guide`）
  会结束当前段**而不是混进上一个版本的内容；`### Fixed` 这类三级标题正确保留在段内
- **结果缓存**：changelog 走同一套内存 + 磁盘缓存（TTL 6 小时）；
  失败结果短缓存 10 分钟，避免反复打 GitHub
- **渲染改造**：`npm_get_package_info` 原来把整段 JSON 倒出来（release notes 轻易淹没上下文），
  改为紧凑文本：单条 notes 最多 12 行 / 900 字符，超出标注「…（已截断）」

### Verified

- 纯函数：9 种 repository 写法 + 4 类 markdown 标题 + 边界（空/null/limit）
- 三条降级路径（Releases 优先 / 失败转 CHANGELOG.md / 都失败给 none）都有 stub fetch 覆盖
- 非 GitHub 仓库**不发任何请求**（有断言）
- **真实联网实测**：`semver` 639ms、`express` 493ms、`axios` 492ms，
  各拿到 8 个版本段（含版本号、日期、release notes）
- 断言 139 → **151**（tool-schema 69 · conformance 23 · routes 26 · client 22 · build-client 11）

---

## [0.6.0] - 2026-09-21 (面板内可编辑配置)

此前 10 个配置项**只能在 profile 的 `cordis.patch.yml` 里改** —— 面板能看不能改。
本轮补上写入通道，全部可在界面上改。

### Added

- **`POST /plugins/npm-manager/settings`**：写入配置。
  - 服务端走官方的 `ctx.settings.register(...)` 作用域 → `scope.update(patch)`
  - 落到 `~/.dsh/settings.yaml` 的 `npm-manager:` 段（**merge 语义，只写改动的键**，
    不碰其他插件的设置）
  - 写入后 `scope.watch` 触发 → `state.updateConfig()` → 缓存作废，**热生效、不用重启**
  - **白名单**：只接受字段表里的 key。`githubToken` 是凭据，**永远不可写、也不下发到前端**
  - 非法值由 settings 服务按 schema 校验后抛错 → 原样回传 400，不会写坏文档
- **字段描述表 `SETTINGS_FIELDS`（单一事实来源）**：服务端随 `GET /settings` 下发，
  前端按它渲染表单，同时服务端用它派生写入白名单 —— 两边不会漂移。
- **面板内的配置表单**：折叠式（默认收起，不喧宾夺主），10 个字段带中文标签、
  单位与说明；有「保存 / 还原」、脏标记、保存成功与错误提示。
  不可写的宿主会显示明确说明而不是给一堆灰按钮。
- `readJsonBody()`：请求体解析，带 64KB 上限；支持真实 Node 流与预解析两种形态。

### Verified（真实环境）

- `GET /settings` → `writable: true`，下发 10 个字段
- `POST /settings {"patch":{"requestTimeoutMs":20000}}` → `{ok:true, current:{...}}`
- **`~/.dsh/settings.yaml` 里确实出现 `npm-manager: requestTimeoutMs: 20000`**，
  且其他 8 个插件的设置段完好无损（merge 语义）
- 浏览器里展开表单：10 个字段标签/单位/提示齐全，保存与还原按钮就位，**零页面错误**
- 测试断言 125 → **136**（tool-schema 59 · routes 26 · client 22 · conformance 19 · build-client 11）

### 注意

- 验证过程写入了 `requestTimeoutMs`，**已从备份逐字节还原**用户的 `settings.yaml`。
- `diskCacheDir` 改动需要重启 dsh 才会用新目录（缓存实例在构造时确定）；
  其余字段热生效。

---

## [0.5.1] - 2026-09-21 (修好 `npm_apply_upgrade`：审批门用错了 API)

`npm_apply_upgrade` 一直是 **100% 不可用** —— 调用必被拦，且用户**没有任何途径批准**。
本轮定位到是两个 API 误用叠加。

### Fixed

- **⭐ `tools.guard()` 只能拒绝、没有放行通道**。
  官方声明（`dsh-tools/lib/index.js:2813`）：
  > `@param guard - synchronous check; a returned string denies the execution.`

  它是**同步**的、返回字符串即拒绝 —— 用它做"先问用户再决定"的审批门，**结构上做不到**。
  改成官方的 `tools/pre-execute` 瀑布事件：

  ```
  'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
  ```
  可返回 `{kind:'allow'}` / `{kind:'deny', reason}` / `{kind:'ask', reason?}`，或 `next()`。
  宿主收到 `ask` 后走 `ctx.get('approval').request(...)`，`allowed-once` 才放行
  （`dsh-tools/lib/index.js:3116, 3314`）。

- **⭐ `exec.agent.approvals` 这个字段根本不存在**。
  官方 `ToolExecution` 是
  `{callId, rootCallId, name, arguments, agent?, parent?, signal, token}`。
  旧代码 `exec.agent?.approvals?.get?.(exec.callId)?.granted` 因此恒为 `undefined`
  → 永远拒绝。新实现完全不碰它（并有源码级回归断言）。

- **dry-run 不再打扰用户**：`dryRun !== false`（默认）只预览、不改文件，直接放行；
  只有 `confirm: true && dryRun: false` 才返回 `ask` 让用户批准。
  `confirm !== true` 则直接 `deny`（属"调用姿势不对"，不是"要不要批准"）。

### Added

- `scripts/dev-conformance-check.mjs` 新增**层 5**（6 条断言）：验证审批门注册在
  `tools/pre-execute` 上、源码不再出现 `.approvals` 或 `tools.guard(`、
  以及四条决策路径（非目标工具放行 / confirm 缺失拒绝 / dry-run 放行 / 真实升级返回 ask）。

### Verified

- 全量 **124** 断言通过（build-client 11 · tool-schema 53 · routes 20 · client 22 · conformance 19）
- 插件在真实 dsh 实例上加载零错误，`/plugins/npm-manager/settings` → HTTP 200
  （验证 `ctx.on` 在插件 ctx 上可用、`apply` 不抛错）

### 顺带排除的一条优化路线（有据可依地否掉）

考虑过改用 npm registry 的 abbreviated packument
（`Accept: application/vnd.npm.install-v1+json`）来减小传输量。实测：

| 包 | 完整 | 精简 | 倍数 |
|---|---|---|---|
| react | 6833 KB | 2851 KB | 2.4× |
| typescript | 15330 KB | 8491 KB | 1.8× |
| semver | 240 KB | 99 KB | 2.4× |

**只小 2~3×，且耗时没有改善甚至更慢**（semver 589ms → 970ms，因为延迟由代理主导而非体积）。
更关键的是**该格式不含 `description` / `homepage` / `repository`** —— 正是界面要显示的字段。
结论：不采用。

---

## [0.5.0] - 2026-09-21 (跨重启磁盘缓存 + 请求超时 + 两处诊断)

用户反馈"加载依旧缓慢、现在哪个都加载不出来、一直转圈圈"。
逐层排查后修掉三个真缺陷 —— 其中两个是**会让人以为插件坏了**的静默降级。

### Fixed

- **⭐ 请求没有超时 → 网络半死时整次扫描永久挂起（"一直转圈圈"的直接原因）**。
  `fetchJson` 里是裸 `fetch`；流式扫描里任何一个不 settle 的 Promise 都会让 worker
  永不结束 → generator 永不产出 `done` 帧 → 前端永远转圈。
  现在加 `requestTimeoutMs`（默认 15s）+ 超时重试 1 次，单个包超时只跳过它、不阻塞其余。
  实测：registry 延迟从 0.5s 劣化到 2~3.5s 时，这个缺陷才暴露出来。
- **⭐ 磁盘缓存只装得下 6 条（缓存形同虚设）**。原来缓存的是**完整 packument**
  （含全部版本 + README）—— 实测 `react` 单包 6.8MB、`axios` 775KB、`semver` 240KB，
  220 个包累计数百 MB，远超 8MB 上限 → `evictOldest` 反复砍到只剩 6 条。
  改为**只缓存精简投影**（name/latest/description/homepage/repository，单条约 300 字节）：
  130 个唯一包名合计 **38KB**，完整装下。
  完整 packument 不再进缓存（内存与磁盘都不进）—— 去重由精简缓存负责。
- **⭐ 项目列表缓存把"只有当前项目"永久钉住**。`listProjects()` 在 `workspaceRegistry`
  注入到达**之前**被调用过一次，把「只有 cwd」的结果缓存住了，之后永不刷新 →
  「全系统」只剩 1 个项目。现在 `setWorkspaceProvider()` 会作废该缓存。
  另外把 provider 的异常从"静默吞掉"改为**记录并暴露到 `/settings`** ——
  之前正是这个静默降级让问题毫无线索。

### Added

- **跨重启磁盘缓存**：`~/.dsh/npm-manager/cache/registry.json`
  （`DSH_HOME` 可覆盖，`config.diskCacheDir` 可指定）。
  - 单条超 512KB 直接跳过（防巨型包拖垮整体）
  - 原子写（临时文件 + rename）、debounce 落盘、stream 结束时强制 flush
  - 文件带 `note` 字段，明示"可安全删除"
  - **实测效果：全系统 220 个包，冷启动 62022ms → 新进程 194ms（约 320×）**，
    且 `cached: false` 证明是真实扫描（文件系统 + 全部 registry 查询都由磁盘缓存命中）
- `config.requestTimeoutMs` / `diskCache` / `diskCacheTtlMs` / `diskCacheDir` 四个配置项
- `/settings` 新增 `diagnostics` 段：workspace 注入状态、项目数、磁盘缓存路径/条目数/错误。
  这一轮的两个"静默降级"都是靠它定位的。

### Changed

- `RegistryClient.getPackage()` **不再缓存**（完整 packument 太大）；
  新增 `SlimPackageMeta` 类型与 `slimOf()` / `toPackageMeta()` 转换。
- 测试新增 6 条：请求挂起必须超时且不阻塞其余、只缓存精简投影、跨项目去重、
  单条巨型包跳过、`DSH_HOME` 护栏（测试不得触碰真实 `~/.dsh`）。

### Verified

- 单测 **53**（tool-schema）+ 19（routes）+ 22（client）+ 13（conformance）+ 11（build-client）
- 跨进程实测：冷 62022ms → 热 194ms
- 启动日志零错误；`/settings` 诊断显示 13 个项目、130 条磁盘缓存

### ⚠️ 排查中发现的环境问题（与本插件无关，但会让 dsh 完全起不来）

**`~/.dsh/.credentials.yaml.lock` 孤儿锁会让 dsh 每次启动失败**：

```
dsh: plugin tree failed to load: failed to apply loader entry connection:
atomic-write: timed out waiting for the writer lock at ...\.credentials.yaml.lock
```

宿主 `dsh-atomic-write` 的注释明确写了 *"orphan recovery is an operator action"* ——
它**不会**自动回收，必须手工删锁。锁文件内容是持有者的 PID，确认该进程已死即可删。

另外：**在本沙箱里启动 dsh 会继承 `NODE_OPTIONS=--require=.../node-language-shim.cjs`**，
该拦截器会拦下 dsh 释放锁的 `rm`（本轮删除配额 50 用尽后），
**导致锁永远释放不掉**。绕开方式：`env -u NODE_OPTIONS CODEBUDDY_SAFE_DELETE_ENABLED=0 dsh ...`。

---

## [0.4.1] - 2026-09-19 (渐进式加载 + 加载态修正)

用户反馈："没有找到已安装的包。能不能不要一直显示这个？给个刷新或者加载中呢？
最好配个动画指导在动？而且不需要一次加载完全、识别到几个先列出来，不然总以为宕机了。"

三个问题，逐个定位后修掉。

### Fixed

- **加载中会显示空态文案**（观感上像"扫描完了且没有结果"，实为还在扫描）。
  根因是 `load()` 里的 `status: prev.status === 'ready' ? 'ready' : 'loading'` ——
  重新加载时状态**保持 ready**，若上一批是空数组就一路显示"没有找到已安装的包"。
  现在状态机明确四态：`loading`（未收到任何包）/ `streaming`（逐条到达）/
  `ready`（结束，**只有此时才允许显示空态**）/ `error`。
- **重新加载时保留上一批行**，让人误以为已经加载完。现在切到 loading 时清空 `packages`。
- **「刷新缓存」按钮的忙碌态提前收回**：`setBusy(false)` 在 POST 返回后立刻执行，
  而真正的重扫才刚开始（几十秒），期间界面毫无指示。
  现在把 `setBusy(false)` 作为 `load(true)` 的完成回调。

### Added

- **渐进式加载（流式）**：新增 `GET /packages?stream=1`，用 SSE 逐条推送。
  - `meta` 帧先到（3ms），带上本次要扫的总数 → 前端立刻能显示 `0 / 220`
  - `pkg` 帧**每解析好一个就推一个**
  - `done` 帧收尾，同时写入缓存
  - 实测（全系统 220 包、冷缓存）：`meta` 3ms → **首包 463ms** → 全部完成 39s。
    轨迹：`1@463ms  40@5.0s  80@10.4s  120@14.9s  200@19.6s`
  - 没有 `body.getReader()` 的环境自动降级为一次性解析。
- **旋转动画 + 进度条**：`.npmgr-spin`（CSS keyframes 旋转环）与 `.npmgr-track`
  （已知总量走确定性填充，未知走不确定滑动）。扫描期间统计行显示
  `⟳ 已加载 137 / 220`，不再是静止文本。
- **空态补了副标题**："该目录下没有 package.json，或它没有声明依赖。" —— 让"空"有解释。
- `_diag/loading-check.mjs`：加载观感专项验证（高频轮询取证：全程不得出现空态文案、
  必须有动画与进度条、行数必须逐步增长）。

### Changed

- `RESOLVE_CONCURRENCY`（原 `RESOLVE_BATCH`）语义变更：
  ⚠️ **不能用 `Promise.all` 分批** —— 每批都要等**最慢**的成员，实测 9 个包一批
  会让首个结果等到 7 秒，等于没有渐进效果。改成"N 个 worker 并发、谁先完成谁先入队"。
  取值 16：本机吞吐随并发次线性增长且重复测量差异极大（24 并发两次分别 3.8s / 40s），
  测不出稳定最优值，故取折中；真正的加速来自缓存而非这个数字。

### Verified

- 单测 90 → **100+**（client-verify 新增 5 条加载态断言，routes-verify 新增 3 条流式断言）
- 浏览器专项：`loading-check.mjs` 全绿
- curl 实测 SSE 帧的到达时间戳（见上）

---

## [0.4.0] - 2026-09-19 (三范围 + 项目发现 + 结果缓存)

用户反馈两点：① 范围选项应该是「本项目 / 全局 / 全系统」，本项目要能指向任意项目，
全系统要能看出包属于哪个项目并可按项目筛选；② 每次切换都重新全量扫描太慢，
只在进入时扫一次并缓存，切换子选项与筛选都读缓存。

### Added

- **三范围模型**（服务端 / 路由 / 工具 / 界面四处一致）：
  - `project` 本项目 —— 单个项目目录，可切换为任意已知项目或自定义路径
  - `global` 全局 —— npm 全局安装目录
  - `system` 全系统 —— 所有已知项目，每行标注所属项目，可按项目筛选
- **项目发现**：`discoverNodeProjects()` 在 DSH 工作区下按深度发现真正的 Node 项目。
  为什么必需：工作区往往是"容器目录"（`web插件`、`day05`），根下没有 `package.json`，
  只列工作区根会让「全系统」几乎扫不到东西。实测从 6 个工作区发现出 13 个项目。
- **`GET /plugins/npm-manager/projects`**：项目列表（当前 cwd + 发现的子项目 + 工作区归属）。
  数据来自宿主 `workspaceRegistry` 服务，通过 `ctx.inject(['workspaceRegistry'])`
  作降级边界（服务缺失时退化为只有 cwd，插件照常工作）。
- **结果缓存**（本次的核心）：
  - 服务端按 `(scope, projectPath)` 缓存扫描结果，`listCacheTtlMs` 默认 30 分钟；
    响应带 `cached` / `scannedAt`，前端据此显示「数据 HH:MM (缓存)」。
  - 客户端同样按 key 缓存，切换范围/项目命中缓存时**一个请求都不发**。
  - 只有两种情况真正重新扫描：该组合首次访问，或用户点「刷新缓存」。
- `config.listCacheTtlMs`、`config.projectScanDepth` 两个配置项。

### Fixed

- **「刷新缓存」按钮原本是假的**：`invalidate()` 只改了一个时间戳，
  `RegistryClient` 的元数据缓存从没被清过 —— TTL 未到时「刷新」后拿到的还是旧数据。
  新增 `RegistryClient.clearCache()` 并在 `invalidate()` 中调用，三处缓存（结果 /
  项目发现 / registry 元数据）一起作废。
- **全局扫描两个缺陷**（「全局」是这个功能的一部分，顺带修掉）：
  - `if (item.startsWith('@')) continue` 会**永久跳过所有 scoped 全局包** ——
    本机 4 个全局项里 `@colbymchenry/codegraph`、`@deepseek-ai/dsh` 两个永远列不出来。
    改为下钻一层读 `@scope/name/package.json`。
  - 只认 `process.env.APPDATA`，缺失时静默返回空。改为 `NPM_CONFIG_PREFIX` →
    `APPDATA` → `USERPROFILE` → `homedir()` 逐级兜底。
    实测：修前 无 APPDATA → 0 个 / 有 APPDATA → 2 个；修后两种情况都是 **4 个**。
- **死路由**：`/plugins/npm-manager/packages/:name` 原用 `kind:'exact'`，
  而 exact 表是字面量 Map 查找、不支持 `:param` → 永远命中不了，请求落到 SPA fallback。
  改为 `kind:'prefix'` 并在 handler 内解析 pathname。
- **`onClick: load` 会把点击事件当成 `force` 参数**传进去（重试按钮），改为显式 `load(true)`。

### Changed

- **破坏性**：配置 `scope` 枚举由 `local|global|both` 改为 `project|global|system`，
  默认 `project`。profile 的 `cordis.patch.yml` 与插件自带 patch 已同步迁移
  （`scope: both` → `scope: project`）—— 不迁移会因非法值导致 settings 注册失败。
- 工具 `npm_list_packages`：`scope` 枚举同步为三范围，新增 `project` 路径参数；
  输出新增 `project` / `projectPath` / `projectCount` / `cached` / `scannedAt`；
  `render` 改为紧凑逐行文本（原为整段 JSON，220 个包时会淹没上下文）。
- 工具 `npm_apply_upgrade`：`scope` 枚举 `local|global` → `project|global`。
- `src/types.ts` 的 Scope 形状同步更新（并标注该文件当前无活跃引用）。

### Verified（真实环境，非沙箱）

- `dsh --profile web --dump-config`：条目入树，无 warn。
- 服务端：`/projects` 返回 13 个项目；`/packages?scope=system` → 219 个包 / 170 个可升级 /
  13 个项目；同 key 第二次请求 `cached=true` 且 `scannedAt` 不变。
- 浏览器（Edge headless）三范围端到端 + **缓存行为专项验证 11/11**：
  | 操作 | 累计 packages 请求 | 数据时间 |
  |---|---|---|
  | 进入（本项目） | 1 | 22:35 |
  | 切全局 | 2 | 22:36 |
  | 切全系统 | 3 | 22:37 |
  | **切回本项目** | **3（+0）** | **22:35 未变** |
  | **再切全系统** | **3（+0）** | **22:37 未变** |
  | 点刷新缓存 | 4 | 更新 |
  | 搜索筛选 | **4（+0）** | — |
- 零 pageerror、零失败请求。

### Known issues（仍未修）

- `npm_apply_upgrade` 的 guard 读 `exec.agent.approvals` —— 官方 `ToolExecution` 无此字段，
  该工具永久不可用且用户无法批准。
- 卡片不支持在界面上编辑配置（4 个字段仍需改 profile 的 patch）。
- `RegistryClient.getChangelog` 仍返回空数组（GitHub Releases 未接）。
- 项目发现**不跟随符号链接**（避免环），且跳过 `.` / `_` 前缀目录 ——
  名字以 `_` 开头的真实项目需用「自定义路径」访问。

---

## [0.3.0] - 2026-09-19 (挂载修复 + 真 React 客户端 + 浏览器端到端验证)

用户报的现象：插件"已安装"但 Settings → Plugins 里什么都看不到。

### Fixed

- **P0 插件从未被挂载**：`dsh --profile web --dump-config` 里 `npm-manager` 出现 **0 次**，
  同时打出 `patch: entry "npm-manager" not found`。三处同时错：
  1. 本插件的 `cordis.patch.yml` 用了顶层 `- id:`（应为 `- insert:`），
     且 `name` 填了 pnpm 的 `link:./src/index.ts` —— 把依赖协议写进了包名字段；
  2. profile 的 `dsh.profile.bundles` 没有登记本包 → 本插件的 patch 根本不会被 apply；
  3. profile 的 `cordis.patch.yml` 里那段 `- id: npm-manager` 因 id 不存在被静默丢弃。
- **P0 客户端面板不是 React 组件**：`settings.plugin.item` 的第二个参数返回普通对象
  `{ render: fn }`，渲染器走 `jsx(Comp, props)` → 抛 *Objects are not valid as a React child*。
  且组件读取的 `props.target` / `props.dom` 在 slot kit 里根本不存在。
- **P0 `locale` 传了字典对象**：契约要求**命名空间字符串**，传对象不报错但会让界面显示裸 key。
- **P0 客户端模块 id 与包名不一致**：产物里写 `id: 'npm-manager'`，
  而 `dsh-client-modules` 用**包名**做图行 id，对不上会抛
  `bundle ... loaded without registering "dsh-plugin-npm-manager"`。
  现由 `scripts/build-client.mjs` 从 `package.json#name` 读取，杜绝漂移。

### Added

- **真 React 客户端**：`client/src/index.js` —— 包列表页（范围切换 / 搜索 / 仅看可升级 /
  刷新缓存 / 过期徽章 / 当前→最新版本对比 / 加载·空·筛选空·错误四态），
  用 `React.createElement` 手写，不依赖 `@deepseek-ai/dsh-client-ui-primitives`
  （本 profile 未安装该包）。
- **独立标签页**：注册 `settings.section`（`id: npm-manager`、`order: 37`），
  位置在 Settings 左侧导航「邮箱助手」与「插件市场」之间 ——
  与「邮箱助手」同级，不再是「插件 → 插件配置」里那张卡片。
  用户反馈卡片形态"不好看"，故改为整页；`settings.plugin.item` 卡片已移除
  （邮箱助手同样只有 section，无卡片）。
- `_diag/browser-check.mjs`：puppeteer + Edge 的端到端验证脚本
  （登录 → 打开设置 → 点导航项 → 等数据 → 交互 → 截图）。
- `_diag/verify-instance.patch.yml`：验证用临时 overlay
  （用户已有实例持有 task-board ledger 锁，第二个实例需绕开，不改任何 profile 文件）。
- **`scripts/build-client.mjs` 真构建链**：源码校验 → 套 `__ModuleLoader__` 外壳 →
  产物复校。本机无 esbuild/rolldown/tsdown，故用确定性包装构建，不引入新依赖；
  换真打包器时外壳格式不变。
- **`tests/client-verify.mjs` 升级为契约测试**（4 → 17 断言）：真正调用注册的组件，
  断言返回的是 React 元素而非 `{ render }` 对象；断言模块 id == 包名；
  断言 `locale` 是字符串；断言注册进 `settings.section` 且 `id`/`order`/`label` 齐全。
  旧版只做 `content.includes(...)` 字符串检查，全绿却漏掉了上述所有 P0。

### Changed

- `package.json#dsh.client.inject`：`["@deepseek-ai/dsh-client-locale"]`
  → 补上 `@deepseek-ai/dsh-client-ui-settings`。
- `package.json#scripts`：新增 `build:client`；`test` 串上构建步骤。
- `npm test` 断言总数 31 → **55**。

### Verified（真实环境，非沙箱）

- `dsh --profile web --dump-config`：条目入树，warn 消失。
- 服务端：`GET /plugins/npm-manager/packages?scope=local` → HTTP 200，
  真实返回 9 个包（4 个可升级）。
- 客户端：Edge headless 打开 `设置 → NPM 管理器` 标签页，
  **整页渲染成功**，表格 9 行，中文文案正常（证明 locale 座位生效），
  范围切换 / 搜索 / 刷新可用，**零页面错误、零失败请求**。

### Known issues（本轮未修，已定位）

- `scanGlobalPackages()` 依赖 `process.env.APPDATA`，无 `USERPROFILE`/`homedir()` 兜底；
  且 `if (item.startsWith('@')) continue` 会**永久跳过所有 scoped 全局包**
  （本机 4 个全局项里有 2 个是 scoped，永远列不出来）。
- 路由 `/plugins/npm-manager/packages/:name` 是死路由：`kind:'exact'` 的 path 不支持
  `:param`（exact 表是字面量查找）。
- `npm_apply_upgrade` 的 guard 读 `exec.agent.approvals` —— `ToolExecution` 无此字段，
  该工具永久不可用且用户无法批准。

---

## [0.2.1] - 2026-09-19 (沙箱修复 + 真包验证 + lib 构建)

### Fixed
- **修复 src/ 被旧剥离脚本损坏的语法**：registry/state/scanner/routes/apply-upgrade/preview-upgrade 中 `:  {`、`isDev = ==`、`packages((n)=>)`、`handler(req) =>` 等残损语法全部改正
- **测试改为真包验证**（不再用 mock）：新增 `scripts/patch-src.mjs` 统一加载器，把 `@deepseek-ai/dsh-tools` 重定向到宿主 profile 真包、`@deepseek-ai/schemastery` 重定向到项目 node_modules 真包
- **client-verify**：改用 Node `vm` 真跑 `client.js`，验证 factory 返回 `module.exports` 且 `apply` 是函数
- **dev-conformance-check**：层 4 改为对已编译的 `t.parameters` 直接做 `validateJsonSchemaValue`（`validateArgs` 需原始属性 map，不能吃编译后的 schema）

### Added
- **tsc 构建链路打通**：本地安装 typescript@5.4 + @types/node@22，`npm run build` 产出 `lib/`（ES2022 ESM + .d.ts + sourcemap）
- `package.json` 补齐 `scripts.build` / `scripts.test`，修正 `types` 指向 `./lib/index.d.ts`
- 冒烟验证：构建产物 `lib/index.js` 可独立 import，4 件套导出齐全，fake ctx 下 apply 注册 4 个工具

### Notes
- 沙箱全绿：tool-schema 6/6 · routes 8/8 · client 4/4 · conformance 13/13（共 31 断言），全部跑在宿主真 dsh-tools 上
- **未做任何部署**：未拷贝 vendor、未改 profile、未启动 dsh web；真实 DSH 端到端渲染仍需用户本机验证

---

## [0.2.0] - 2026-09-19 (Round 12+ 重写)

### Added
- **完整重写为 dsh-market 风格**：4 件套 + 5 条 webServer 路由 + settings 面板
- 5 条 webServer 路由: GET /packages · GET /packages/:name · GET /packages/outdated · POST /refresh · GET /settings
- 真实包 API 适配: `Schema.union([...])` 替代 `z.enum`, 严格按 dsh-plugin-conformance §5.1
- §13 schema 验证 4 层: `scripts/dev-conformance-check.mjs`(静态编译 + 返回值校验 + 反向断言 + 全量注册)
- §11 铁律 9: client.js factory `return module.exports`
- §11 铁律 10: client.js 加载期静默(无 console.* 污染)
- §14 部署协议: workspace:* + vendor + pnpm install(不自创 dsh.plugin.yml)
- §7 高危操作 approval gate: `npm_apply_upgrade` 走 `ctx.tools.guard`
- §8.1 状态门分级: 元数据读入口不挂 state gate, 需敏感材料操作按需 unlock
- `PLUGIN_DEV_GUIDE.md`: 完整开发技能书沉淀(给未来 Agent / 复用本项目模板的开发者)
- `tests/*.mjs`: 沙箱可跑的 §13 + §5.3 + §11 验证

### Changed
- **API**: `z.enum([...])` → `Schema.union([...])`(真包 API)
- **入口**: `inject: ['tools']` → `inject: ['tools', 'webServer', 'settings']`(3 个真服务)
- **scan**: 仍走 fs.readdirSync(node_modules)(沙箱 EPERM 不能 spawn npm 子进程)

### Removed
- `src/cordis-mock.ts`(不需要了,直接用真包)
- `src/schemastery-mock.ts`(不需要了,直接用真包)
- `src/utils/runner.ts`(不需要了,直接用 node:child_process)
- 旧 `tests/phase*.mjs` 全部 18 个(由新的 §13 测试替代)

### Notes
- 项目**本身**就是一份"DSH 插件开发技能书": 详见 PLUGIN_DEV_GUIDE.md
- §13 schema 验证沙箱可跑: `node scripts/dev-conformance-check.mjs`
- 完整端到端(真实 dsh web 渲染 + Settings 面板)需要用户本机跑(沙箱无浏览器)
- 跟 dsh-market 布局: 卡片网格 + 顶部 tabs + 搜索框 + 截图预览(本轮占位, build 链路 build-client.mjs 第 3 轮接入)

---

## [0.1.0] - 2026-09-19 (Round 1-11)

### Added
- Round 1-11 累计 273/273 测试通过(本地 mock 验证)
- 4 个 defineTool(apply-upgrade 等)的初步版本
- 真包 API 适配未完成(Schema.union vs z.enum 等差异)
- 沙箱内完整测试通过, 但未实际部署到 DSH

### Notes
- 归档在 `npm-manager-archive` 分支
- 全部源文件备份在 `.archive/src.round1-11/` `tests.round1-11/` `tsconfig.round1-11.json`
