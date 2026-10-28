/**
 * extract-core-from-asar.mjs — 从 DSH 桌面版的 `app.asar` 提取核心包到临时目录
 *
 * 为什么需要：DSH 桌面版把 `@deepseek-ai/dsh-*` 打进了 `app.asar`，
 * `app.asar.unpacked/` 里只有原生模块。所以各 profile 的 node_modules 里
 * **没有** dsh-tools / dsh-settings —— 想拿真实宿主做契约测试，必须先解包。
 *
 * ⚠️ 别在块注释里写「星号紧跟斜杠」的通配路径：那个序列会提前闭合注释，
 *    后面整段代码都变成语法垃圾（本项目踩过两次）。
 *
 * 解包结果缓存到临时目录（按版本命名），同一版本只解一次。
 *
 * 用法：
 *   node scripts/extract-core-from-asar.mjs          # 提取并打印路径
 *   DSH_CORE_NODE_MODULES=那个路径 npm test           # 让测试用它
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认的 DSH 桌面版安装位置（Windows） */
function defaultAsarPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
}

/**
 * 读 asar 的 header。
 *
 * asar 格式（pickle）：
 *   [0..4)   u32 = 4
 *   [4..8)   u32 = headerSize
 *   [8..12)  u32 = headerSize - 4（payload 长度）
 *   [12..)   u32 = JSON 字符串长度，随后是 JSON 本体
 */
function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const sb = Buffer.alloc(8)
    fs.readSync(fd, sb, 0, 8, 0)
    const headerSize = sb.readUInt32LE(4)
    const hb = Buffer.alloc(headerSize)
    fs.readSync(fd, hb, 0, headerSize, 8)
    const strLen = hb.readUInt32LE(0)
    // 有些版本在 JSON 尾部带 \0 padding，解析前清掉
    const json = hb.toString('utf8', 8, 8 + strLen).replace(/[\u0000\s]+$/, '')
    return { header: JSON.parse(json), dataStart: 8 + headerSize }
  } finally {
    fs.closeSync(fd)
  }
}

/** 按 asar 内路径读一个文件的 Buffer；节点没有 offset（目录 / 符号链接）时返回 null */
function readAsarFile(fd, dataStart, node) {
  if (node === undefined || node.offset === undefined || node.size === undefined) return null
  const offset = Number(node.offset)
  const size = Number(node.size)
  if (!Number.isFinite(offset) || !Number.isFinite(size)) return null
  const buf = Buffer.alloc(size)
  if (size > 0) fs.readSync(fd, buf, 0, size, dataStart + offset)
  return buf
}

function walkFiles(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix === '' ? name : prefix + '/' + name
    if (child.files) walkFiles(child, p, out)
    else out.push({ path: p, node: child })
  }
}

/**
 * 提取核心包到 `outRoot`。
 *
 * @param opts.asarPath app.asar 路径（省略用默认安装位置）
 * @param opts.outRoot 解包目录（省略用 临时目录（按版本命名））
 * @param opts.packages 只提取这些 @deepseek-ai 包；省略 = 全部
 * @returns `{ dir, version, count }`，`dir` 是可直接当 `DSH_CORE_NODE_MODULES` 的目录
 */
export function extractCore(opts = {}) {
  const asarPath = opts.asarPath ?? defaultAsarPath()
  if (!fs.existsSync(asarPath)) throw new Error('找不到 app.asar: ' + asarPath)

  const { header, dataStart } = readAsarHeader(asarPath)

  // 定位 dsh/package.json 拿版本号
  let version = 'unknown'
  try {
    const pkgNode = header.files?.dsh?.files?.['package.json']
    if (pkgNode && pkgNode.offset !== undefined) {
      const fd = fs.openSync(asarPath, 'r')
      try {
        version = JSON.parse(readAsarFile(fd, dataStart, pkgNode).toString('utf8')).version ?? 'unknown'
      } finally {
        fs.closeSync(fd)
      }
    }
  } catch {
    /* 版本读不到不影响解包 */
  }

  const outRoot = opts.outRoot ?? path.join(os.tmpdir(), 'dsh-core-' + version.replace(/[^\w.-]/g, '_'))
  const marker = path.join(outRoot, '.extracted')

  if (fs.existsSync(marker)) {
    const count = fs.readFileSync(marker, 'utf8').trim()
    return { dir: outRoot, version, count: Number(count) || 0, cached: true }
  }

  const all = []
  const nm = header.files?.dsh?.files?.['node_modules']
  if (nm) walkFiles(nm, '', all)

  const wanted = opts.packages === undefined
    // 默认：全部 node_modules（含第三方依赖）。
    // ⚠️ 只取 @deepseek-ai 是不够的 —— dsh-app-boot 依赖 js-yaml、dsh-settings 依赖 yaml，
    //    缺了它们连 import 都过不去（契约测试会变成「模块找不到」而不是「契约不符」）。
    ? all
    : all.filter((f) => opts.packages.some((p) => f.path.startsWith('@deepseek-ai/' + p + '/') || f.path === '@deepseek-ai/' + p))

  const fd = fs.openSync(asarPath, 'r')
  let written = 0
  try {
    for (const f of wanted) {
      const buf = readAsarFile(fd, dataStart, f.node)
      // 目录项 / 符号链接 / 无 offset 的节点没有实体内容，跳过（不要写出空文件）
      if (buf === null) continue
      const dest = path.join(outRoot, 'node_modules', f.path)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf)
      written++
    }
  } finally {
    fs.closeSync(fd)
  }

  fs.writeFileSync(marker, String(written))
  return { dir: outRoot, version, count: written, cached: false }
}

// 作为脚本直接运行时：打印解包目录，供 `DSH_CORE_NODE_MODULES` 使用
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('extract-core-from-asar.mjs')) {
  try {
    const r = extractCore()
    console.log(`dsh 核心版本: ${r.version}`)
    console.log(`解包目录: ${r.dir}`)
    console.log(`文件数: ${r.count}${r.cached ? '（复用缓存）' : ''}`)
    console.log(`\n用法: DSH_CORE_NODE_MODULES=${r.dir} npm test`)
  } catch (e) {
    console.error('解包失败: ' + ((e && e.message) ? e.message : String(e)))
    process.exit(1)
  }
}
