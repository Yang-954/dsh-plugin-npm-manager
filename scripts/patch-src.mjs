/**
 * patch-src.mjs — 沙箱统一加载器(替代旧 mock 方案)
 *
 * 背景:
 *   - Node 22.23 默认 strip-types, 可直接跑 .ts
 *   - 但 ESM 相对导入必须带后缀, 且 .js 后缀不会自动映射到 .ts
 *   - 裸包 @deepseek-ai/dsh-tools 在项目 node_modules 里没有, 宿主 profile 里有真包
 *
 * 本模块把 src/ 复制到临时目录并做两类改写:
 *   1. 相对导入 '.js' → '.ts'(因为跑的是 .ts 副本)
 *   2. 裸包导入 → 真实包绝对 file:// URL
 *      - @deepseek-ai/dsh-tools      → 宿主 profile 真包(lib/index.js)
 *      - @deepseek-ai/schemastery    → 项目 node_modules 真包(lib/index.mjs)
 *   - import type ... 整行被 strip-types 擦除, 无需改写
 *
 * 返回 patched 目录路径(file URL), 测试从那里 import。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * 解析宿主包目录。
 *
 * ⚠️ 旧版把路径**写死**成 `C:/Users/Admin/.dsh/profiles/web/node_modules/@deepseek-ai`。
 * 本机 `profiles/web/` 从 2026-10-17 起就是空目录（活跃 profile 是 `desktop`），
 * 于是 `routes-verify` 与 `dev-conformance-check` 直接 `ERR_MODULE_NOT_FOUND` ——
 * `npm test` 跑到第 2 段就崩，看起来像真失败。
 *
 * ⚠️ 顺序很关键：**先找真实宿主 profile，再退回项目 node_modules**。
 * 项目 node_modules 里装的是开发期依赖（本机是 0.1.5-rc.2，还带着早已删除的
 * `settings.register`）—— 用它跑契约测试会得出「一切正常」的假结论，
 * 正好掩盖真实宿主（0.2.1-rc.3）上必崩的 P0。
 */
async function resolveHostNodeModules() {
  const candidates = []

  // 1. 真实宿主 profile（活跃的那个才是真宿主）
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    for (const name of fs.readdirSync(path.join(dshHome, 'profiles'))) {
      candidates.push(path.join(dshHome, 'profiles', name, 'node_modules', '@deepseek-ai'))
    }
  } catch {
    /* 没有 profiles 目录就往下走 */
  }

  // 2. DSH 桌面版核心包（Electron 的 app.asar 里；本机宿主就是这种形态）。
  //    可用 `DSH_CORE_NODE_MODULES` 显式指定解包目录，否则尝试自动从 asar 解包。
  const coreOverride = process.env.DSH_CORE_NODE_MODULES
  if (typeof coreOverride === 'string' && coreOverride !== '') {
    candidates.push(path.join(coreOverride, 'node_modules', '@deepseek-ai'))
    candidates.push(coreOverride) // 也接受直接指向 @deepseek-ai 的写法
  } else {
    try {
      // 惰性 import：解包脚本只在需要时才跑（避免每次测试都解一遍）
      const mod = await import('./extract-core-from-asar.mjs')
      const extracted = mod.extractCore()
      candidates.push(path.join(extracted.dir, 'node_modules', '@deepseek-ai'))
    } catch {
      /* 没有桌面版 / 解包失败：继续用剩下的候选 */
    }
  }
  const asarUnpacked = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai',
  )
  candidates.push(asarUnpacked)

  // 3. 项目自身（CI / 独立 clone）
  candidates.push(path.join(ROOT, 'node_modules', '@deepseek-ai'))

  const hasTools = (dir) => fs.existsSync(path.join(dir, 'dsh-tools', 'lib', 'index.js'))

  // 优先挑「新契约宿主」（dsh-tools >= 0.2）—— 0.1.x 还带着早已删除的
  // `settings.register`，拿它测契约等于测了个已经不存在的世界。
  for (const dir of candidates) {
    if (!hasTools(dir)) continue
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'dsh-tools', 'package.json'), 'utf8')).version || ''
      const [maj, min] = v.split('.').map((x) => parseInt(x, 10))
      if (Number.isFinite(maj) && (maj > 0 || (Number.isFinite(min) && min >= 2))) return dir
    } catch {
      /* 版本读不到就当候选 */
    }
  }

  // 4. 退回第一个可用的（老宿主：测试仍可跑，契约测试会自己跳过）
  for (const dir of candidates) if (hasTools(dir)) return dir
  return null
}

const HOST_NM = await resolveHostNodeModules()

/**
 * 宿主包的 file URL；宿主缺失时对应值为 `null`。
 *
 * 调用方（测试脚本）应显式处理 null 并打印「跳过」，不要让它变成模块解析崩溃。
 */
export const PKG_URLS = {
  '@deepseek-ai/dsh-tools': HOST_NM === null
    ? null
    : pathToFileURL(path.join(HOST_NM, 'dsh-tools', 'lib', 'index.js')).href,
  '@deepseek-ai/schemastery': fs.existsSync(path.join(ROOT, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs'))
    ? pathToFileURL(path.join(ROOT, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs')).href
    : (HOST_NM === null ? null : pathToFileURL(path.join(HOST_NM, 'schemastery', 'lib', 'index.mjs')).href),
}

/** 宿主包目录（供测试脚本探测 WebServer 等）；null = 没找到 */
export const HOST_PACKAGE_DIR = HOST_NM

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.patched' || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    // ⚠️ 跳过 .d.ts：它们是纯类型声明，strip-types 加载会直接 SyntaxError
    //    （`src/types/shims.d.ts` 曾因此让 tool-schema-verify 崩在 parse 阶段）
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** 构建 patched src, 返回 { dirUrl, dirPath } */
export function buildPatchedSrc(tag = 'test') {
  const srcRoot = path.join(ROOT, 'src')
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), `npm-mgr-${tag}-`))

  for (const file of walk(srcRoot)) {
    let content = fs.readFileSync(file, 'utf8')
    const rel = path.relative(srcRoot, file)
    const dest = path.join(outRoot, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    // 1. 相对导入 .js → .ts
    content = content.replace(
      /from\s+(['"])(\.\.?\/[^'"]+?)\.js(['"])/g,
      (_m, q, p, q2) => `from ${q}${p}.ts${q2}`
    )

    // 2. 裸包 → 真实包绝对路径(file URL)
    for (const [pkg, url] of Object.entries(PKG_URLS)) {
      if (url === null) continue // 宿主缺失：保留原样，让 import 自己报错（调用方已先跳过）
      content = content.replace(
        new RegExp(`from\\s+(['"])${pkg.replace('/', '\\/')}\\1`, 'g'),
        `from '${url}'`
      )
    }

    fs.writeFileSync(dest, content)
  }

  return { dirPath: outRoot, dirUrl: pathToFileURL(outRoot).href }
}
