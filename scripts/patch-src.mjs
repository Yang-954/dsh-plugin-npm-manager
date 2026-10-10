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
const HOST_NM = 'C:/Users/Admin/.dsh/profiles/web/node_modules/@deepseek-ai'

export const PKG_URLS = {
  '@deepseek-ai/dsh-tools': pathToFileURL(`${HOST_NM}/dsh-tools/lib/index.js`).href,
  '@deepseek-ai/schemastery': pathToFileURL(path.join(ROOT, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs')).href,
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.patched' || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
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
      content = content.replace(
        new RegExp(`from\\s+(['"])${pkg.replace('/', '\\/')}\\1`, 'g'),
        `from '${url}'`
      )
    }

    fs.writeFileSync(dest, content)
  }

  return { dirPath: outRoot, dirUrl: pathToFileURL(outRoot).href }
}
