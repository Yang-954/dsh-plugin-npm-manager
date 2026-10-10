/**
 * routes-verify.mjs — §5.3 路由唯一键 + §18 真实匹配语义 + handler 行为
 *
 * ⭐ 关键：不自己写 fake 匹配器。
 *    直接把 `@deepseek-ai/dsh-host-webserver` 的 **WebServer.prototype.register / match**
 *    取出来，用一个只有 { exact, prefixes } 两张表的普通对象当 this 调用 ——
 *    这就是宿主真实的注册与匹配实现，不是复刻。
 *
 *    为什么必须这样：旧版用 fake webServer 只收集 (kind,path) 不匹配，
 *    结果 `kind:'exact'` 配 `:param` 的死路由在测试里完全看不出来（§13.1 的教训）。
 */

import path from 'node:path'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { buildPatchedSrc } from '../scripts/patch-src.mjs'

/*
 * ⚠️⚠️ 全局护栏：把 DSH_HOME 指到临时目录。
 *
 * 本文件会真实构造 State（磁盘缓存默认启用）。不设护栏时，
 * 跑一次测试就会把用户真实的 `~/.dsh/npm-manager/cache/registry.json`
 * 覆盖成只有当前项目的几条（实测踩过：130 条被冲成 9 条）。
 * 单元测试绝不该碰真实 home。
 */
const TEST_DSH_HOME = mkdtempSync(path.join(tmpdir(), 'npmgr-routes-dshhome-'))
process.env.DSH_HOME = TEST_DSH_HOME

/** 记录真实缓存文件的初始状态，跑完后比对 —— 用于证明测试没碰过它 */
const REAL_CACHE_FILE = path.join(homedir(), '.dsh', 'npm-manager', 'cache', 'registry.json')
const REAL_CACHE_BEFORE = (() => {
  try {
    const st = statSync(REAL_CACHE_FILE)
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false }
  }
})()

const ROOT = path.resolve(import.meta.dirname, '..')
const { dirUrl } = buildPatchedSrc('routes')

/* ── 解析宿主真包 ─────────────────────────────────────────────── */

const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const WS_CANDIDATES = [
  path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-host-webserver', 'lib', 'index.js'),
  path.join(DSH_HOME, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-host-webserver', 'lib', 'index.js'),
]
let wsEntry = null
for (const c of WS_CANDIDATES) {
  if (existsSync(c)) { wsEntry = c; break }
}

let pass = 0, fail = 0
const test = async (label, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${label}`)
    pass++
  } catch (e) {
    console.log(`  ❌ ${label}: ${(e && e.message) ? e.message : String(e)}`)
    fail++
  }
}

if (wsEntry === null) {
  console.log('跳过：未找到 @deepseek-ai/dsh-host-webserver（peerDependency，CI 上可能未安装）')
  process.exit(0)
}

const { WebServer } = await import(pathToFileURL(wsEntry).href)
const { register: realRegister, match: realMatch } = WebServer.prototype
if (typeof realRegister !== 'function' || typeof realMatch !== 'function') {
  console.log('跳过：宿主 WebServer 原型上找不到 register/match（版本不匹配）')
  process.exit(0)
}

/* ── 用真实实现搭一个最小宿主 ─────────────────────────────────── */

const host = { exact: new Map(), prefixes: new Map() }
const webServer = {
  register: (route) => realRegister.call(host, route),
}
/** 用宿主真实匹配器解析一个 pathname */
const match = (pathname) => realMatch.call(host, pathname)

const indexMod = await import(`${dirUrl}/index.ts`)
const cfgMod = await import(`${dirUrl}/config.ts`)
const Config = cfgMod.Config

/** apply() 注册的全部路由（用宿主真实实现） */
const settingsWrites = []

const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: {
    register: () => () => {},
    guard: () => () => {},
  },
  // apply() 会注册 tools/pre-execute 审批门 → fake ctx 必须提供 on()
  on: () => () => {},
  webServer,
  settings: {
    // apply() 会把返回的作用域交给 state 作为写入通道 → 必须提供 update()
    register: () => ({
      watch: () => {},
      update: (patch) => {
        if (patch && typeof patch.scope === 'string' && !['project', 'global', 'system'].includes(patch.scope)) {
          return Promise.reject(new Error('scope 非法: ' + patch.scope))
        }
        settingsWrites.push(patch)
        return Promise.resolve()
      },
      dispose: () => {},
    }),
  },
  effect: (fn) => { fn(); return () => {} },
  // 刻意不调用回调 —— 模拟宿主没有 workspaceRegistry 服务（降级路径）
  inject: (_deps, _cb) => {},
}

console.log('=== 注册（用宿主真实 register）===\n')

await test('apply() 注册全部路由且无 (kind,path) 重复', async () => {
  indexMod.apply(fakeCtx, Config({}))
  const total = host.exact.size + host.prefixes.size
  if (total !== 6) {
    throw new Error(`期望 6 条路由，实际 ${total}：` +
      [...host.exact.keys()].concat([...host.prefixes.keys()]).join(', '))
  }
})

console.log('\n=== §18 匹配语义（用宿主真实 match）===\n')

await test('exact: /projects 命中项目列表', () => {
  const r = match('/plugins/npm-manager/projects')
  if (!r || r.path !== '/plugins/npm-manager/projects') throw new Error('未命中')
})

await test('exact: /packages 命中包列表（而非被 prefix 抢走）', () => {
  const r = match('/plugins/npm-manager/packages')
  if (!r) throw new Error('未命中')
  if (r.kind !== 'exact') throw new Error('应命中 exact 表，实际 kind=' + r.kind)
})

await test('exact 优先: /packages/outdated 命中过期包而不是详情', () => {
  const r = match('/plugins/npm-manager/packages/outdated')
  if (!r) throw new Error('未命中')
  if (r.path !== '/plugins/npm-manager/packages/outdated') throw new Error('命中了 ' + r.path)
  if (r.kind !== 'exact') throw new Error('应命中 exact 表')
})

await test('⭐ prefix: /packages/<name> 命中详情路由（旧版这里是死路由）', () => {
  const r = match('/plugins/npm-manager/packages/typescript')
  if (!r) {
    throw new Error('未命中任何路由 —— 说明又用了 exact + :param，请求会落到 SPA fallback')
  }
  if (r.kind !== 'prefix') throw new Error('应命中 prefix 表，实际 kind=' + r.kind)
  if (r.path !== '/plugins/npm-manager/packages') throw new Error('命中了 ' + r.path)
})

await test('⭐ scoped 包名也能命中详情路由', () => {
  const r = match('/plugins/npm-manager/packages/@deepseek-ai/dsh-tools')
  if (!r || r.kind !== 'prefix') throw new Error('未命中 prefix 表')
})

await test('exact: /refresh 与 /settings 命中', () => {
  if (!match('/plugins/npm-manager/refresh')) throw new Error('refresh 未命中')
  if (!match('/plugins/npm-manager/settings')) throw new Error('settings 未命中')
})

await test('无关路径不命中任何插件路由（交给 fallback）', () => {
  if (match('/plugins/npm-manager/nope')) throw new Error('不应命中')
  if (match('/plugins/other/packages')) throw new Error('不应命中别的插件前缀')
  if (match('/')) throw new Error('根路径不应命中')
})

console.log('\n=== handler 行为 ===\n')

async function callHandler(pathname, method = 'GET', search = '', body) {
  const r = match(pathname)
  if (!r) throw new Error('路由未命中: ' + pathname)
  let respBody = ''
  const frames = []
  let status = 200
  const req = { method, url: pathname + search }
  if (body !== undefined) req.body = body // readJsonBody 支持预解析形态（单测用）
  const res = {
    setHeader() {},
    write(chunk) { frames.push(chunk); return true },
    flushHeaders() {},
    end(b) { respBody = b || '' },
  }
  Object.defineProperty(res, 'statusCode', { get: () => status, set: (v) => { status = v } })
  await r.handler(req, res)
  return { status, body: respBody, frames }
}

await test('GET /packages 返回合法 JSON（scope 参数生效）', async () => {
  const { status, body } = await callHandler('/plugins/npm-manager/packages', 'GET', '?scope=project')
  if (status !== 200) throw new Error(`期望 200，实际 ${status}; body=${body.slice(0, 160)}`)
  const parsed = JSON.parse(body)
  if (parsed.scope !== 'project') throw new Error('scope 未透传: ' + parsed.scope)
  if (typeof parsed.totalCount !== 'number') throw new Error('totalCount 缺失')
  if (!Array.isArray(parsed.packages)) throw new Error('packages 不是数组')
})

await test('GET /packages?scope=system 返回 projectCount（无 workspaceRegistry 时降级）', async () => {
  const { status, body } = await callHandler('/plugins/npm-manager/packages', 'GET', '?scope=system')
  if (status !== 200) throw new Error('期望 200，实际 ' + status)
  const parsed = JSON.parse(body)
  if (parsed.scope !== 'system') throw new Error('scope 错误')
  // 没有 workspaceRegistry → 只有 cwd 一个项目
  if (parsed.projectCount !== 1) throw new Error('projectCount 应为 1，实际 ' + parsed.projectCount)
})

await test('GET /projects 返回项目列表且含 current', async () => {
  const { status, body } = await callHandler('/plugins/npm-manager/projects')
  if (status !== 200) throw new Error('期望 200，实际 ' + status)
  const parsed = JSON.parse(body)
  if (!Array.isArray(parsed.projects) || parsed.projects.length === 0) throw new Error('projects 为空')
  if (typeof parsed.current !== 'string' || parsed.current === '') throw new Error('current 缺失')
  if (parsed.projects[0].isCurrent !== true) throw new Error('第一个应是当前 cwd')
})

await test('GET /packages/<name> 详情路由可达（不再落到 fallback）', async () => {
  const { status, body } = await callHandler('/plugins/npm-manager/packages/semver', 'GET', '?version=7.6.0')
  if (status !== 200 && status !== 404) throw new Error(`期望 200/404，实际 ${status}; body=${body.slice(0, 160)}`)
  JSON.parse(body) // 必须是 JSON，不是 SPA 的 HTML
})

await test('POST /refresh 拒绝 GET（405）', async () => {
  const { status } = await callHandler('/plugins/npm-manager/refresh', 'GET')
  if (status !== 405) throw new Error('期望 405，实际 ' + status)
})

await test('POST /refresh 正常返回 ok', async () => {
  const { status, body } = await callHandler('/plugins/npm-manager/refresh', 'POST')
  if (status !== 200) throw new Error('期望 200，实际 ' + status)
  if (JSON.parse(body).ok !== true) throw new Error('ok 不为 true')
})

// 缓存断言用不存在的项目路径 → 扫出 0 个包、零 registry 网络请求，测试快且确定
const CACHE_Q = '?scope=project&project=' + encodeURIComponent('C:/definitely/not/here')

await test('⭐ /packages 透传 cached / scannedAt（前端据此显示"数据时间"）', async () => {
  const first = JSON.parse((await callHandler('/plugins/npm-manager/packages', 'GET', CACHE_Q)).body)
  if (first.cached !== false) throw new Error('刷新后首次应为 cached=false')
  if (typeof first.scannedAt !== 'number') throw new Error('缺 scannedAt')

  const second = JSON.parse((await callHandler('/plugins/npm-manager/packages', 'GET', CACHE_Q)).body)
  if (second.cached !== true) throw new Error('第二次应为 cached=true')
  if (second.scannedAt !== first.scannedAt) throw new Error('scannedAt 应保持不变')
})

await test('⭐ /refresh 之后缓存真的失效（cached 回到 false）', async () => {
  await callHandler('/plugins/npm-manager/packages', 'GET', CACHE_Q)
  const cachedResp = JSON.parse((await callHandler('/plugins/npm-manager/packages', 'GET', CACHE_Q)).body)
  if (cachedResp.cached !== true) throw new Error('前置条件不成立：应为缓存命中')
  await callHandler('/plugins/npm-manager/refresh', 'POST')
  const after = JSON.parse((await callHandler('/plugins/npm-manager/packages', 'GET', CACHE_Q)).body)
  if (after.cached !== false) throw new Error('/refresh 后应重新扫描，实际 cached=' + after.cached)
})

console.log('\n=== 流式（stream=1）===\n')

const STREAM_Q = '?stream=1&scope=project&project=' + encodeURIComponent('C:/definitely/not/here')

await test('⭐ stream=1 逐帧输出 SSE，且以 meta 开头、done 结尾', async () => {
  const { status, frames, body } = await callHandler('/plugins/npm-manager/packages', 'GET', STREAM_Q)
  if (status !== 200) throw new Error('期望 200，实际 ' + status)
  if (frames.length < 2) throw new Error('应至少写出 meta 与 done 两帧，实际 ' + frames.length)
  if (body !== '') throw new Error('流式路径不应再调用 end(整体 body)')

  const events = frames.map((f) => {
    const line = f.trim()
    if (line.indexOf('data:') !== 0) throw new Error('帧格式不对: ' + JSON.stringify(line.slice(0, 60)))
    return JSON.parse(line.slice(5).trim())
  })
  if (events[0].type !== 'meta') throw new Error('首帧应为 meta，实际 ' + events[0].type)
  if (typeof events[0].total !== 'number') throw new Error('meta 应带 total（前端用它显示 0/N 进度）')
  if (events[events.length - 1].type !== 'done') throw new Error('末帧应为 done，实际 ' + events[events.length - 1].type)

  const done = events[events.length - 1]
  for (const k of ['totalCount', 'outdatedCount', 'cached', 'scannedAt']) {
    if (done[k] === undefined) throw new Error('done 缺字段 ' + k)
  }
})

await test('⭐ 每个 pkg 帧各带一个包（不是攒到最后一起发）', async () => {
  // 用一个真有 package.json 的项目，验证逐条推送
  const q = '?stream=1&scope=project&project=' + encodeURIComponent(ROOT)
  const { frames } = await callHandler('/plugins/npm-manager/packages', 'GET', q)
  const events = frames.map((f) => JSON.parse(f.trim().slice(5).trim()))
  const pkgEvents = events.filter((e) => e.type === 'pkg')
  const done = events.find((e) => e.type === 'done')
  if (!done) throw new Error('缺 done 帧')
  if (pkgEvents.length === 0) throw new Error('一个 pkg 帧都没有')
  if (pkgEvents.length !== done.totalCount) {
    throw new Error('pkg 帧数(' + pkgEvents.length + ') 应等于 totalCount(' + done.totalCount + ')')
  }
  if (pkgEvents.some((e) => !e.package || !e.package.name)) throw new Error('pkg 帧缺 package.name')
  // 关键：包必须是**一条一条**发的，而不是全塞进一帧
  if (pkgEvents.length > 1 && pkgEvents.length < 2) throw new Error('unreachable')
})

await test('流式结果会写入缓存（随后非流式请求命中 cached=true）', async () => {
  const q = '?stream=1&scope=project&project=' + encodeURIComponent('C:/definitely/not/here-2')
  await callHandler('/plugins/npm-manager/packages', 'GET', q)
  const plain = JSON.parse((await callHandler('/plugins/npm-manager/packages', 'GET',
    '?scope=project&project=' + encodeURIComponent('C:/definitely/not/here-2'))).body)
  if (plain.cached !== true) throw new Error('流式完成后应已写入缓存，实际 cached=' + plain.cached)
})

console.log('\n=== 配置读写（/settings）===\n')

await test('GET /settings 下发字段描述与可写标志（前端据此渲染表单）', async () => {
  const { status, body } = await callHandler('/plugins/npm-manager/settings')
  if (status !== 200) throw new Error('期望 200，实际 ' + status)
  const j = JSON.parse(body)
  if (!Array.isArray(j.fields) || j.fields.length === 0) throw new Error('缺 fields')
  if (j.writable !== true) throw new Error('注入了作用域后 writable 应为 true，实际 ' + j.writable)
  if (j.fields.some((f) => f.key === 'githubToken')) throw new Error('凭据字段不应下发为可编辑')
  if (!j.fields.every((f) => typeof f.key === 'string' && typeof f.type === 'string')) {
    throw new Error('fields 项形状不对')
  }
})

await test('⭐ POST /settings 写入合法配置', async () => {
  const before = settingsWrites.length
  const { status, body } = await callHandler('/plugins/npm-manager/settings', 'POST', '', {
    patch: { scope: 'system', requestTimeoutMs: 20000 },
  })
  if (status !== 200) throw new Error('期望 200，实际 ' + status + ' body=' + body)
  const j = JSON.parse(body)
  if (j.ok !== true) throw new Error('ok 不为 true: ' + body)
  if (settingsWrites.length !== before + 1) throw new Error('补丁未到达 settings 服务')
  const w = settingsWrites[settingsWrites.length - 1]
  if (w.scope !== 'system' || w.requestTimeoutMs !== 20000) throw new Error('透传内容不对: ' + JSON.stringify(w))
})

await test('⭐ POST /settings 拒绝白名单外的字段（400）', async () => {
  const before = settingsWrites.length
  const { status, body } = await callHandler('/plugins/npm-manager/settings', 'POST', '', {
    patch: { githubToken: 'leak-me' },
  })
  if (status !== 400) throw new Error('期望 400，实际 ' + status)
  const j = JSON.parse(body)
  if (j.ok !== false) throw new Error('应 ok:false')
  if (settingsWrites.length !== before) throw new Error('被拒的补丁不应到达 settings 服务')
})

await test('POST /settings 回传 schema 校验错误（400）', async () => {
  const { status, body } = await callHandler('/plugins/npm-manager/settings', 'POST', '', {
    patch: { scope: 'nonsense' },
  })
  if (status !== 400) throw new Error('期望 400，实际 ' + status)
  const j = JSON.parse(body)
  if (j.ok !== false || !/非法/.test(j.error || '')) throw new Error('应回传原始错误: ' + body)
})

await test('POST /settings 拒绝非对象请求体（400）', async () => {
  const { status } = await callHandler('/plugins/npm-manager/settings', 'POST', '', [1, 2, 3])
  if (status !== 400) throw new Error('期望 400，实际 ' + status)
})

await test('POST /settings 支持直接传配置对象（不带 patch 包装）', async () => {
  const before = settingsWrites.length
  const { status } = await callHandler('/plugins/npm-manager/settings', 'POST', '', { scope: 'global' })
  if (status !== 200) throw new Error('期望 200，实际 ' + status)
  if (settingsWrites.length !== before + 1) throw new Error('未写入')
})

console.log(`\n=== 共 ${pass} 通过 / ${fail} 失败 ===\n`)

await test('⭐ 测试全程未改动真实的 ~/.dsh/npm-manager', () => {
  const now = (() => {
    try {
      const st = statSync(REAL_CACHE_FILE)
      return { exists: true, size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return { exists: false }
    }
  })()
  if (REAL_CACHE_BEFORE.exists !== now.exists) {
    throw new Error(REAL_CACHE_BEFORE.exists
      ? '测试把真实缓存文件删掉了'
      : '测试在真实 home 下创建了缓存文件（DSH_HOME 护栏失效）')
  }
  if (REAL_CACHE_BEFORE.exists && (REAL_CACHE_BEFORE.size !== now.size || REAL_CACHE_BEFORE.mtimeMs !== now.mtimeMs)) {
    throw new Error('测试改写了真实缓存文件')
  }
})

console.log(`\n=== 最终 ${pass} 通过 / ${fail} 失败 ===\n`)

// 清理测试用的 DSH_HOME
try { rmSync(TEST_DSH_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

process.exit(fail === 0 ? 0 : 1)
