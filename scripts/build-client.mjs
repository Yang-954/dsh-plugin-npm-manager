/**
 * build-client.mjs — 把 client/src/index.js 打成一个 DSH 可加载的客户端 bundle
 *
 * 为什么不用 esbuild / rolldown / tsdown：
 *   本机实测（profile 与项目 node_modules）都没有安装任何打包器，而本插件只需要
 *   react 一个外部模块、且源码用 React.createElement 不需要 JSX 编译。
 *   为此引入新依赖不划算 —— 这里用一个**确定性的包装构建**：
 *   源码 → 校验 → 套 __ModuleLoader__ 外壳 → 产出 client/client.js → 复校产物。
 *   将来若换真打包器，外壳格式不变，只需替换中间那一步。
 *
 * 硬约束（dsh-plugin-conformance §11 铁律 9/10 + §17）：
 *   - 产物必须是 window.__ModuleLoader__.load({ id, factory })
 *   - **id 必须逐字等于 package.json 的 name** —— client-modules 用包名做图行 id，
 *     对不上会抛：`bundle <url> loaded without registering "<pkgName>" via __ModuleLoader__.load`
 *     （源码 dsh-client-modules/lib/client.js:248）。所以这里从 package.json 读取，
 *     不允许手写常量，避免改名后漂移。
 *   - factory 必须 return module.exports
 *   - 加载期不得出现 console.*
 *   - 注册 settings.plugin.item 时 key / locale 必须是命名空间字符串
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'client', 'src', 'index.js')
const OUT = join(ROOT, 'client', 'client.js')
const PKG = join(ROOT, 'package.json')

// ⚠️ 模块 id = 包名。不要改成别的（见文件头注释）。
const PLUGIN_ID = JSON.parse(readFileSync(PKG, 'utf8')).name

let failed = 0

/** 同步断言器。刻意拒绝 async 回调 —— 同步 check 不 await 会把失败变成静默漏测。 */
function check(label, fn) {
  let r
  try {
    r = fn()
  } catch (e) {
    console.log('  \u274c ' + label + ': ' + ((e && e.message) ? e.message : String(e)))
    failed++
    return
  }
  if (r !== undefined && typeof r.then === 'function') {
    console.log('  \u274c ' + label + ': check() 的回调不能是 async —— 请把 await 移到 check() 之外')
    failed++
    return
  }
  console.log('  \u2705 ' + label)
}

console.log('=== build-client: 源码校验 ===\n')

if (!existsSync(SRC)) {
  console.error('  \u274c 找不到源码 ' + SRC)
  process.exit(1)
}
const source = readFileSync(SRC, 'utf8')

/**
 * 剥离注释后再做静态检查。
 * 否则文档里提到的字面量（例如"不要写 return module.exports"）会被自己误判。
 * 只处理 // 与块注释，且刻意不碰字符串字面量 —— 本项目的源码里没有含
 * `//` 或 `/*` 的字符串，简单实现足够；真出现时下面的断言会报错而不是静默放过。
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
const code = stripComments(source)

check('源码非空', () => {
  if (source.trim().length < 200) throw new Error('源码过短，疑似被清空')
})

check('源码不含 console.*（§11 铁律 10）', () => {
  const m = code.match(/console\.(log|warn|error|info|debug)\s*\(/g)
  if (m) throw new Error('发现 ' + m.length + ' 处 console.*')
})

check('源码不含 ESM 语法（必须由外壳提供 module/exports）', () => {
  if (/^\s*import\s/m.test(code)) throw new Error('发现 import 语句')
  if (/^\s*export\s/m.test(code)) throw new Error('发现 export 语句')
})

check('源码不自己 return module.exports（由外壳负责）', () => {
  if (/return\s+module\.exports/.test(code)) throw new Error('源码里出现了 return module.exports')
})

check('注册 settings.section 且 id / locale 都是命名空间字符串', () => {
  if (!/name:\s*['"]settings\.section['"]/.test(source)) throw new Error("未找到 name: 'settings.section'")
  if (!/id:\s*NS\b/.test(source)) throw new Error('未找到 id: NS')
  if (!/locale:\s*NS\b/.test(source)) throw new Error('未找到 locale: NS（必须传字符串而非字典对象）')
})

check('导出四件套 name / inject / apply', () => {
  for (const k of ['exports.name', 'exports.inject', 'exports.apply']) {
    if (!source.includes(k)) throw new Error('缺少 ' + k)
  }
})

console.log('\n=== build-client: 产出 bundle ===\n')

const indented = source
  .replace(/\s+$/, '')
  .split('\n')
  .map((l) => (l.length > 0 ? '      ' + l : l))
  .join('\n')

const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN_ID)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

${indented}

    return module.exports
  },
})
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, bundle, 'utf8')

console.log('  写入 ' + OUT + '（' + Buffer.byteLength(bundle, 'utf8') + ' bytes）')

console.log('\n=== build-client: 产物复校 ===\n')

const built = readFileSync(OUT, 'utf8')
const builtCode = stripComments(built)

check('产物以 window.__ModuleLoader__.load 开头', () => {
  if (!built.trimStart().startsWith('window.__ModuleLoader__.load(')) throw new Error('外壳缺失')
})

check('产物 id 逐字等于 package.json 的 name（' + PLUGIN_ID + '）', () => {
  const m = built.match(/id:\s*(["'])(.*?)\1/)
  if (!m) throw new Error('未找到 id')
  if (m[2] !== PLUGIN_ID) {
    throw new Error('id = ' + m[2] + '，应为 ' + PLUGIN_ID + ' —— 对不上会导致 client-modules 抛 "loaded without registering"')
  }
})

check('factory 闭合前有 return module.exports（§11 铁律 9）', () => {
  const idx = builtCode.lastIndexOf('return module.exports')
  if (idx < 0) throw new Error('缺失')
  const tail = builtCode.slice(idx)
  if (tail.includes('exports.apply =') || tail.includes('function NpmManagerCard')) {
    throw new Error('return module.exports 出现在导出赋值之前')
  }
})

check('产物不含 console.*（§11 铁律 10）', () => {
  const m = builtCode.match(/console\.(log|warn|error|info|debug)\s*\(/g)
  if (m) throw new Error('发现 ' + m.length + ' 处 console.*')
})

check('产物语法合法（new Function 可解析）', () => {
  // 只解析不执行：把 window.__ModuleLoader__.load( 换成 return (
  new Function('window', built.replace(/^\s*window\.__ModuleLoader__\.load\(/, 'return ('))
})

console.log('\n=== build-client: ' + (failed === 0 ? '全部通过' : failed + ' 项失败') + ' ===\n')
process.exit(failed === 0 ? 0 : 1)
