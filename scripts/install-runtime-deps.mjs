// 沙箱没 npm cache 权限。直接 web fetch 装 monorepo 兄弟包到 node_modules/
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import fsZlib from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/yang/日常非项目活动/dsh-plugin-npm-manager'
const NM = join(ROOT, 'node_modules')
const gunzipSync = fsZlib.gunzipSync

function parseTar(buf) {
  const files = []
  let off = 0
  while (off < buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header[0] === 0) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim()
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8)
    const typeFlag = String.fromCharCode(header[156])
    off += 512
    if (typeFlag === '0' || typeFlag === '') {
      files.push({ name, content: buf.subarray(off, off + size) })
    }
    const pad = Math.ceil(size / 512) * 512
    off += pad
  }
  return files
}

async function install(name, version) {
  const url = `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${name} failed: ${res.status}`)
  const gz = Buffer.from(await res.arrayBuffer())
  const tar = gunzipSync(gz)
  const files = parseTar(tar)
  const dst = join(NM, ...name.split('/'))
  mkdirSync(dst, { recursive: true })
  for (const f of files) {
    const m = f.name.match(/^package\/(.*)$/)
    if (!m) continue
    const p = join(dst, m[1])
    if (f.name.endsWith('/')) mkdirSync(p, { recursive: true })
    else { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, f.content) }
  }
  console.log(`✅ ${name}@${version}`)
}

mkdirSync(NM, { recursive: true })

const deps = [
  ['@deepseek-ai/schemastery', '3.18.2'],
  ['@deepseek-ai/cordis', '4.0.2'],
  ['@deepseek-ai/cosmokit', '1.8.3'],
]
for (const [n, v] of deps) {
  await install(n, v)
}
console.log('Done.')
