# 部署清单 (Round 12+)

> 按 dsh-plugin-conformance §14 — workspace:* 协议,不写 registry 版本号。

---

## 1. 用户本机:建 vendor + 写 workspace 配置

```bash
# 假设 DSH profile 在 ~/.dsh/profiles/web(默认)
DSH_PROFILE=~/.dsh/profiles/web

# 1. 把本项目复制到 vendor
mkdir -p "$DSH_PROFILE/vendor"
cp -r /path/to/dsh-plugin-npm-manager "$DSH_PROFILE/vendor/"

# 2. 删除 workspace 成员快照里的 scripts(§14.2.1 防 prepare 失败)
node -e "
const fs = require('fs');
const path = '$DSH_PROFILE/vendor/dsh-plugin-npm-manager/package.json';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
delete pkg.scripts;
delete pkg.devDependencies;
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
console.log('✓ clean scripts/devDependencies');
"
```

---

## 2. 修改 profile 的 dependencies

`$DSH_PROFILE/package.json` 里把 `dsh-plugin-npm-manager` 改成 `workspace:*`:

```jsonc
{
  "dependencies": {
    "dsh-plugin-npm-manager": "workspace:*",   // ← §14.3 铁律 25
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-host-webserver": ">=0.1.5-rc.1",
    "@deepseek-ai/dsh-settings": ">=0.1.5-rc.1",
    "@deepseek-ai/cordis": "^4.0.2"
  }
}
```

同时 `$DSH_PROFILE/pnpm-workspace.yaml`:

```yaml
packages:
  - .
  - vendor/dsh-plugin-npm-manager   # ← 登记为 workspace 成员
```

---

## 3. pnpm install（必须,否则 link 不生效）

```bash
cd "$DSH_PROFILE"
pnpm install
```

**验证清单**（§14.3）：

```bash
# 1. install 成功且无 404
pnpm install

# 2. outdated 能正常列出
pnpm outdated

# 3. pnpm-lock.yaml 里 specifier 应为 link:
grep -A2 "dsh-plugin-npm-manager:" pnpm-lock.yaml

# 4. node_modules 是软链(不是复制)
ls -ld node_modules/dsh-plugin-npm-manager   # 应显示 → ../../vendor/dsh-plugin-npm-manager

# 5. dshmarket 不再把库依赖列成"已装插件"
node -e "
const { readInstalled } = require('dshmarket/lib/profile.js');
const names = Object.keys(readInstalled('web'));
console.log('已装插件:', names);
console.log('应只有 npm-manager + 真正插件, 出现 imapflow/mailparser 是错的');
"
```

---

## 3.5 ⚠️ 把包名加进 `dsh.profile.bundles`（**最容易漏的一步**）

`pnpm install` 只让包**可解析**，不会让它**被加载**。必须把它登记为 bundle：

```jsonc
// $DSH_PROFILE/package.json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        // ...其他插件...
        "dsh-plugin-npm-manager"          // ← 必须加
      ]
    }
  }
}
```

为什么必须：profile 的配置树 = 依次 apply 每个 bundle 的 `dsh.bundle.patch`，
再 apply profile 自己的 `cordis.patch.yml`。
不在 `bundles` 里 → 本插件的 `cordis.patch.yml` **根本不会被读**。

⚠️ 同时注意：**插件自带的 `cordis.patch.yml` 必须用 `- insert:` 形式**。
顶层 `- id:` 是"改已存在的条目"，id 不存在时只打印一条 warn 就丢弃：

```
dsh: [.../cordis.patch.yml] patch: entry "npm-manager" not found
```

这条 warn 极易被当成噪音忽略 —— 它的实际含义是"插件完全没有被挂载"。

**验证（唯一可信的判据）**：

```bash
dsh --profile web --dump-config > /tmp/dump.yml 2>/tmp/warn.txt
grep -c 'npm-manager' /tmp/dump.yml     # 必须 >= 1
grep 'not found' /tmp/warn.txt          # 必须没有 npm-manager 那条
```

---

## 4. 启动 DSH，打开「设置 → NPM 管理器」

```bash
# 4.1 清掉沙箱代理变量（dsh-market §profile-forensics §5 坑）
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY

# 4.2 启动（前台跑, 完整捕获 stdout）
node "$DSH_PROFILE/scripts/start-web.mjs"   # 或你常用的启动方式

# 4.3 打开 http://127.0.0.1:3080 → 设置
#     左侧导航里应出现「NPM 管理器」，位置在「邮箱助手」与「插件市场」之间
#     （注册的是 settings.section，order=37；不是「插件 → 插件配置」里的卡片）
```

⚠️ **不要用 `Settings → Plugins` 去找它** —— 0.4.0 起它是独立标签页，与
「邮箱助手」「插件市场」同级。命名空间 `npm-manager` 没有被任何 `settings.plugin.item`
卡片认领，所以「插件配置」里是空白的（这是正常的，不是故障）。

**判定加载成功**（§11 铁律 8）：

```
plugin stdout 里应有:
  {"plugin":"dsh-plugin-npm-manager","level":"info","msg":"[npm-manager] loaded"}
  {"plugin":"dsh-plugin-npm-manager","level":"info","msg":"[npm-manager] disposed (hot-unplug ok)"}
  ↑ 后者是 toggle off 时
```

**判定失败**：

```
{"plugin":"dsh-plugin-npm-manager","level":"error","msg":"failed to apply loader entry <hash>: ...\n  invalid plugin, expect function or object with an \"apply\" method, received undefined"}
↑ client.js factory 没 return module.exports（§11 铁律 9）
```

**浏览器控制台报 `bundle ... loaded without registering "dsh-plugin-npm-manager"`**：
客户端 bundle 的 `id` 与 `package.json#name` 不一致（§17.0）。构建脚本已从
`package.json` 读取，改包名后重新 `npm run build:client` 即可。

---

## 4.5 配置项参考

配置走 profile 的 `cordis.patch.yml`（用户层覆盖），全部有默认值：

```yaml
- id: npm-manager
  name: dsh-plugin-npm-manager
  config:
    scope: project            # 默认范围：project | global | system
    projectScanDepth: 3       # 从每个 DSH 工作区往下发现 Node 项目的层数（0 = 只看工作区根）
    listCacheTtlMs: 1800000   # 扫描结果缓存存活时间（30 分钟）；点「刷新缓存」立即作废
    registryCacheTtlMs: 300000
    enableChangelog: true
    npmCommandTimeoutMs: 60000
```

⚠️ **`scope` 的合法值是 `project | global | system`**。旧值 `local` / `both` 已废弃，
配错会导致 settings 注册失败（非法存量值会连带注册一起挂掉）。

| 项 | 作用 | 什么时候需要改 |
|---|---|---|
| `scope` | 打开标签页时的默认范围 | 想默认看全局就设 `global` |
| `projectScanDepth` | 「全系统」下钻发现项目的深度 | 项目藏在 4 层以下时调大；嫌慢可调小 |
| `listCacheTtlMs` | 扫描结果缓存时长 | 想要更"新鲜"就调小；0 表示用默认 30 分钟（不是禁用缓存） |

---

## 5. 验证 §13 schema 验证 4 层（部署前必做）

```bash
# 在本项目根目录跑
node scripts/dev-conformance-check.mjs
```

应输出 4 层全过：
- 层 1 schema 编译过
- 层 2 返回值 validateJsonSchemaValue 无违规
- 层 3 反向断言（坏值应报错）实际报错
- 层 4 全量 registerTools 注册成功

---

## 6. 用户本机 `dsh` CLI 操作清单

```bash
# 6.1 安装到 profile
cd "$DSH_PROFILE"
pnpm install                          # 必须无 404

# 6.2 验证 plugin 出现在 dsh plugin list
dsh --profile web plugin list

# 6.3 修改配置(可选)
#     条目本身由本插件的 bundle patch 提供（前提：包名已列进 dsh.profile.bundles）
#     这里只做「用户层覆盖」，用 - id: 形式（bundle 层先插入，本层后应用，id 已存在）
vim $DSH_PROFILE/cordis.patch.yml

# 6.4 启动 dsh web
dsh web --profile web
# 浏览器打开 http://127.0.0.1:3080 → 设置 → 左侧导航「NPM 管理器」
```

---

## 7. 升级与回滚

### 7.1 升级本插件

⚠️ **不要在 vendor 里改源码** —— 那是运行副本。正确顺序是"改源码项目 → 构建 → 同步到 vendor"：

```bash
# 1. 在源码项目里改（本仓库根目录）
cd /path/to/dsh-plugin-npm-manager

# 2. 构建两端
npm run build          # src/*.ts → lib/
npm run build:client   # client/src/index.js → client/client.js

# 3. 同步到 vendor —— ⚠️ 这一步最容易漏
#    node_modules/dsh-plugin-npm-manager 是**软链指向 vendor**，
#    被加载的是 vendor 副本；不同步等于没改。
VEN="$DSH_PROFILE/vendor/dsh-plugin-npm-manager"
cp -r lib/. "$VEN/lib/"
cp client/client.js "$VEN/client/client.js"
cp client/src/index.js "$VEN/client/src/index.js"
cp cordis.patch.yml package.json "$VEN/"

# 4. 重启 dsh web
#    ⚠️ 客户端 bundle 由 dsh-client-modules 缓存（按 rev 命中），
#    改了 client.js 必须重启，HMR 不一定会重建。
```

**改完自查**（两条都过才算生效）：

```bash
dsh --profile web --dump-config > /tmp/d.yml 2>/tmp/w.txt
grep -c 'npm-manager' /tmp/d.yml     # >= 1
grep 'not found' /tmp/w.txt          # 不能有 npm-manager 那条
```

### 7.2 回滚

```bash
# 1. 关掉插件（不停 dsh）
dsh --profile web plugin off dsh-plugin-npm-manager

# 2. 移除依赖
cd "$DSH_PROFILE"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
delete pkg.dependencies['dsh-plugin-npm-manager'];
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
pnpm install

# 3. 完全移除（删除 vendor）
rm -rf vendor/dsh-plugin-npm-manager
pnpm install
```

---

## 8. 部署后验证清单

- [ ] §3.1 `pnpm install` 无 404
- [ ] §3.2 `pnpm outdated` 正常列出
- [ ] §3.4 `node_modules/dsh-plugin-npm-manager` 是软链不是目录
- [ ] §3.5 `readInstalled` 不含 `imapflow` / `mailparser`（库依赖泄漏）
- [ ] §3.5 `dsh --profile web --dump-config` 里 `npm-manager` 出现 ≥1 次，且无 `not found` warn
- [ ] §4.1 启动 dsh web 后 **设置 → 左侧导航出现「NPM 管理器」**（在「邮箱助手」与「插件市场」之间）
- [ ] §4.2 默认「本项目」能看到包列表（真实包数 ≥ 1）
- [ ] §4.3 切「全局」→ 有数据（含 scoped 包，如 `@deepseek-ai/dsh`）
- [ ] §4.4 切「全系统」→ 出现「项目」列，统计行显示「N 个项目」
- [ ] §4.5 用项目下拉筛选 → 行数下降且只剩该项目
- [ ] §4.6 ⭐ 切来切去时统计行的「数据 HH:MM」**不变**（证明缓存生效）
- [ ] §4.7 点「刷新缓存」→ 数据时间更新
- [ ] §4.8 搜索框过滤 → 行数下降（纯客户端，不发请求）
- [ ] §5 `scripts/dev-conformance-check.mjs` 全过
- [ ] §6.2 `dsh plugin list` 列出 `dsh-plugin-npm-manager`
- [ ] 浏览器控制台无 `loaded without registering` / `Objects are not valid as a React child`

---

## 9. 沙箱 vs 用户本机

| 验证 | 沙箱 | 用户本机 |
|---|---|---|
| import 链通 | ✅ | ✅ |
| 4 件套导出 | ✅ | ✅ |
| §13 schema 4 层验证 | ✅（用宿主真包）| ✅ |
| webServer.register 唯一键 + **真实 match 语义** | ✅ | ✅ |
| client.js §11 铁律 9 / §17.0 模块 id | ✅ | ✅ |
| 真实 npm scan + registry fetch | ⚠️ 缺 `APPDATA` 时全局为空 | ✅ |
| dsh web 实际渲染 React | ✅（puppeteer + Edge）| ✅ |
| `设置 → NPM 管理器` 标签页显示 | ✅ | ✅ |
| 缓存行为（按请求数取证） | ✅ | ✅ |
| 高危操作（apply upgrade）的 approval gate | ❌ 沙箱无审批 user | ⚠️ 该工具当前不可用（guard 读不存在的字段）|

**沙箱可验证 §13 + §11 + §5.3 + §17 + 浏览器端到端；只剩真实审批链要用户本机跑**。
