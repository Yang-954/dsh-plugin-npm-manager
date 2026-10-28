# dsh-plugin-npm-manager

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)

> DeepSeek Harness (DSH) 插件:列出本地/全局 npm 包,在 **DSH Settings → 插件** 面板里直接看(版本、描述、过期状态、升级)。
>
> **架构**：4 件套函数插件 + 6 条 webServer 路由 + settings 面板（独立标签页）+ 手写 React 客户端。
> **宿主契约**：DSH **0.2.1+**（settings 用 `configure/describe/update`，可写字段必须 `.volatile()`）。

---

## 用户视角(打开 DSH Web UI 后)

1. 打开 DSH Web UI（`pnpm dsh` 或 `npx @deepseek-ai/dsh web`）
2. 进 **设置 → 左侧导航「NPM 管理器」**（独立标签页，与「插件市场」同级）
3. 页面内：
   - 包列表: 本项目 / 全局 / 全系统 三档
   - 过期标记: 黄色徽章 + updateType(major/minor/patch/**unknown**)
   - 操作按钮: **刷新缓存** / **预览升级** / **配置**
4. 配置区可调 10 个字段(scope / projectScanDepth / listCacheTtlMs / registryCacheTtlMs /
   requestTimeoutMs / diskCache / diskCacheTtlMs / diskCacheDir / enableChangelog / npmCommandTimeoutMs)

> `unknown` = 该依赖声明不可比（`workspace:*` / `*` / `file:` / `link:`），
> 不是「大版本升级」。0.7.x 会把它误判成 major。

---

## 4 个 model-callable 工具

| 工具 | 副作用 | 用例 |
|---|---|---|
| `npm_list_packages` | ❌ 只读 | "列出项目所有 npm 包" |
| `npm_get_package_info` | ❌ 只读 | "typescript 这个包的最新版本和 changelog" |
| `npm_preview_upgrade` | ❌ 只读（npm --dry-run）| "升级 cowsay 会改什么" |
| `npm_apply_upgrade` | ✅ 写（需 confirm:true + dryRun:false）| "确认升级 cowsay 到最新" |

> Windows 上 npm 只有 `npm.cmd`，裸 `spawn('npm')` 会 ENOENT —— 见
> `src/services/npm-cli.ts`（`shell: true` + 包名白名单，两者成对）。

---

## 开发者视角（看代码）

- `PLUGIN_DEV_GUIDE.md` — 完整开发技能书（怎么基于本项目写新插件）
- `PROJECT_STATUS.md` — 当前状态、目录结构、还差什么
- `cordis.patch.yml` — DSH Loader 加载时 apply 的 patch（**随包发布，必须进 git**）
- `src/` — 服务端 TS 源码，按 §8 结构分层
- `client/client.js` — Settings 面板的客户端产物（手写 `React.createElement`）
- `scripts/dev-conformance-check.mjs` — §13 schema 验证 4 层
- `tests/*.mjs` — 沙箱可跑的单元测试

---

## 快速验证

```sh
npm test    # 全量 159 条断言（含真实 0.2.1 宿主契约测试）
```

`npm test` 会**自动**从 DSH 桌面版的 `app.asar` 解包核心包来做契约测试
（见 `scripts/extract-core-from-asar.mjs`，结果按版本缓存到临时目录）。
也可以显式指定：

```sh
node scripts/extract-core-from-asar.mjs          # 打印解包路径
DSH_CORE_NODE_MODULES=<那个路径> npm test         # 用指定宿主跑
```

单独跑：

```sh
node tests/tool-schema-verify.mjs    # 服务层 + 缓存 + 超时（79）
node tests/routes-verify.mjs         # 宿主真实 register/match + SSE（25）
node tests/client-verify.mjs         # React 元素契约 + 模块 id（22）
node scripts/dev-conformance-check.mjs  # schema 四层（23）
node tests/host-contract-021.mjs     # 真实 0.2.1 契约（10）
```

---

## 部署（用户本机）

完整步骤见 [DEPLOY.md](./DEPLOY.md)。最小安装：

```bash
# 1. 装到 DSH profile（DSH_PROFILE 按你的实际 profile 目录）
cd ~/.dsh/profiles/desktop
pnpm add "dsh-plugin-npm-manager@github:Yang-954/dsh-plugin-npm-manager"

# 2. 在 profile 的 package.json 里登记 bundle
#    dsh.profile.bundles 追加 "dsh-plugin-npm-manager"
#    dependencies 追加 "dsh-plugin-npm-manager": "github:Yang-954/dsh-plugin-npm-manager"

# 3. 重启 DSH，插件会在「设置 → 左侧导航 → NPM 管理器」出现
```

> 插件通过 `dsh.profile.bundles` + 随包的 `cordis.patch.yml` 挂载；
> 缺少 bundle 登记时 Loader 只会打印一条 `entry "npm-manager" not found` 的告警并丢弃该条目。

---

## 许可

[MIT](./LICENSE) — Copyright (c) 2026 凡尘相守 (Yang-954)

---

## 版本要点

| 版本 | 变更 |
|---|---|
| **0.8.0** | **适配 DSH 0.2.1**：settings 改 `configure/describe/update` + `.volatile()`；修 Windows npm spawn、`scope=global` 参数、`updateType` 误判、GitHub token 跨源/回显；测试改为自动解包真实宿主 |
| 0.7.x | 磁盘缓存热切换、移除死依赖、changelog 三级降级 |
| 0.6.0 | 面板内可编辑配置 |
| 0.5.x | 跨重启磁盘缓存、请求超时、审批门修正 |
| 0.4.x | 三范围 + 项目发现 + 渐进式加载 |
| 0.3.0 | 挂载修复 + 真 React 客户端 |

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。

