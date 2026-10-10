# dsh-plugin-npm-manager

> DeepSeek Harness (DSH) 插件:列出本地/全局 npm 包,在 **DSH Settings → Plugins** 面板里直接看(版本、描述、过期状态、升级)。
>
> **架构**：4 件套函数插件 + 5 条 webServer 路由 + settings 面板 + 占位 client.js,完全按 dsh-plugin-conformance §9 重构步骤。

---

## 用户视角(打开 DSH Web UI 后)

1. 打开 DSH Web UI（`pnpm dsh` 或 `npx @deepseek-ai/dsh web`）
2. 进 **Settings → Plugins**,看到 `npm-manager v0.2.0` 卡片
3. 点开卡片:
   - 包列表: 本地/全局/全部 三档
   - 过期标记: 黄色徽章 + updateType(major/minor/patch)
   - 操作按钮: **刷新缓存** / **预览升级** / **配置**
4. Settings tab 可调 4 个字段(scope / cacheTtlMs / enableChangelog / npmCommandTimeoutMs)

---

## 4 个 model-callable 工具

| 工具 | 副作用 | 用例 |
|---|---|---|
| `npm_list_packages` | ❌ 只读 | "列出项目所有 npm 包" |
| `npm_get_package_info` | ❌ 只读 | "typescript 这个包的最新版本和 changelog" |
| `npm_preview_upgrade` | ❌ 只读（npm --dry-run）| "升级 cowsay 会改什么" |
| `npm_apply_upgrade` | ✅ 写（需 confirm:true + dryRun:false）| "确认升级 cowsay 到最新" |

---

## 开发者视角（看代码）

- `PLAN.md` — 架构设计 + 30 条 DSH 准则映射
- `PLUGIN_DEV_GUIDE.md` — 完整开发技能书（怎么基于本项目写新插件）
- `cordis.patch.yml` — DSH Loader 加载时 apply 的 patch
- `src/` — 13 个 TS 文件,按 §8 结构分层
- `client/client.js` — Settings 面板的占位客户端（React 后续 build）
- `scripts/dev-conformance-check.mjs` — §13 schema 验证 4 层
- `tests/*.mjs` — 沙箱可跑的单元测试

---

## 快速验证（沙箱）

```sh
node --experimental-strip-types tests/tool-schema-verify.mjs   # §13 层 1+2+3 (沙箱)
node --experimental-strip-types tests/routes-verify.mjs        # §5.3 唯一键
node --experimental-strip-types tests/client-verify.mjs        # §11 铁律 9+10
```

---

## 部署（用户本机）

按 §14 workspace:* 协议,见 [DEPLOY.md](./DEPLOY.md)。

---

## 重写记录（Round 12+）

| 旧（Round 1-11） | 新（Round 12+） |
|---|---|
| 4 个 model 工具 + mock 验证 273/273 | 4 个工具 + 5 条路由 + settings 面板 + 客户端占位 |
| `z.enum` mock API | 真包 `Schema.union([...])` |
| 4 件套 mock + 自创 | 4 件套真包 + dsh-market 模式 |
| 无 dev-conformance-check | §13 四层验证脚本 |
| 无 client.js | client.js 占位 (§11 铁律 9/10) |

完整重写原因与决策见 `PLAN.md` §11。
