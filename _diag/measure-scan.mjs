/** 测量一次 stream=1 全系统扫描：首包时间 + 总耗时 + 包数 */
const t0 = Date.now()
const res = await fetch('http://127.0.0.1:3099/plugins/npm-manager/packages?stream=1&scope=system')
const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = '', n = 0, first = null, done = null, meta = null
for (;;) {
  const c = await reader.read()
  if (c.done) break
  buf += dec.decode(c.value, { stream: true })
  let i
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const f = buf.slice(0, i).trim(); buf = buf.slice(i + 2)
    if (!f.startsWith('data:')) continue
    const ev = JSON.parse(f.slice(5).trim())
    if (ev.type === 'meta') meta = ev
    else if (ev.type === 'pkg') { n++; if (first === null) first = Date.now() - t0 }
    else if (ev.type === 'done') done = { ms: Date.now() - t0, ...ev }
  }
}
console.log(JSON.stringify({ firstPkgMs: first, totalMs: done.ms, pkgs: n, metaTotal: meta && meta.total, cached: meta && meta.cached }))
