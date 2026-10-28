/**
 * 用**真实 0.2.1 宿主包**验证插件契约（不是 mock）。
 *
 * 校验三件事：
 *   1. `apply()` 在 0.2.1 的 settings 服务面（configure/describe/update，无 register）下**不抛**
 *   2. 4 个工具 + 6 条路由真的注册上去了
 *   3. 写配置走 `update(entryId, patch, revision)` 且**响应不含 githubToken**
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HOST_PACKAGE_DIR } from '../scripts/patch-src.mjs'

// ⚠️ 用 fileURLToPath 而不是 URL.pathname：中文路径会被百分号编码成
// `%E6%97%A5...`，拼进 import 后变成双重编码（`%25E6...`）导致找不到模块
const ROOT = fileURLToPath(new URL('..', import.meta.url))

if (HOST_PACKAGE_DIR === null) {
  console.log('跳过：未找到 0.2.1 宿主包')
  process.exit(0)
}

let pass = 0, fail = 0
const test = async (label, fn) => {
  try {
    await fn()
    console.log('  ✅ ' + label)
    pass++
  } catch (e) {
    console.log('  ❌ ' + label + ': ' + ((e && e.message) ? e.message : String(e)))
    fail++
  }
}

// 0.2.1 的 settings 方法面：**静态**读宿主源码判断，不 import。
//
// ⚠️ 为什么不 import：`dsh-settings` 依赖 `yaml` 等第三方包，而 asar 解包只取了
// `@deepseek-ai` 目录（第三方依赖在 asar 里也有，但把整个 node_modules 解出来太重）。
// 本测试关心的是「方法面」而不是「实现能跑」，静态读取足够且更稳。
const settingsSrc = (() => {
  try {
    return readFileSync(join(HOST_PACKAGE_DIR, 'dsh-settings', 'lib', 'index.js'), 'utf8')
  } catch {
    return null
  }
})()

console.log('宿主 dsh-settings: ' + HOST_PACKAGE_DIR)

await test('0.2.1 的 settings 服务没有 register（证明旧代码必崩）', () => {
  if (settingsSrc === null) throw new Error('读不到宿主 dsh-settings 源码')
  // 类方法定义形如 `	register(ns, schema, options) {`
  const hasRegisterMethod = /^\t(?:async\s+)?register\s*\(/m.test(settingsSrc)
  if (hasRegisterMethod) {
    throw new Error('宿主竟然还有 register 方法 —— 本迁移的前提不成立')
  }
  for (const m of ['configure', 'describe', 'update']) {
    if (!new RegExp('^\\t(?:async\\s+)?' + m + '\\s*\\(', 'm').test(settingsSrc)) {
      throw new Error('缺少方法 ' + m)
    }
  }
})

const registered = { tools: [], routes: [] }
const writes = []

/** 按 0.2.1 真实方法面造 settings 服务（不 mock 掉不存在的 register） */
const fakeSettings = {
  configure: () => {},
  describe: () => [{ ns: 'npm-manager', revision: 3, schema: {}, value: {} }],
  update: (ns, patch, revision) => {
    writes.push({ ns, patch, revision })
    return Promise.resolve()
  },
}

const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  effect: (fn) => { const d = fn(); return () => { try { d && d() } catch {} } },
  inject: (deps, cb) => {
    if (Array.isArray(deps) && deps.includes('settings')) {
      return cb({ ...ctx, settings: fakeSettings, fiber: undefined })
    }
    return undefined
  },
  on: () => () => {},
  tools: { register: (t) => { registered.tools.push(t); return () => {} }, guard: () => () => {} },
  webServer: { register: (r) => { registered.routes.push(r); return () => {} } },
  settings: fakeSettings,
  workspaceRegistry: { list: () => [] },
}

const { Config } = await import(pathToFileURL(join(ROOT, 'lib', 'config.js')).href)
const { readConfigValue } = await import(pathToFileURL(join(ROOT, 'lib', 'config.js')).href)
const plugin = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)

await test('⭐ apply() 在 0.2.1 settings 面上不抛', () => {
  plugin.apply(ctx, Config({}))
})

await test('4 个工具都注册了', () => {
  const names = registered.tools.map((t) => t.name).sort()
  const expected = ['npm_apply_upgrade', 'npm_get_package_info', 'npm_list_packages', 'npm_preview_upgrade']
  if (names.join(',') !== expected.join(',')) throw new Error('实际: ' + names.join(','))
})

await test('6 条路由都注册了且无重复', () => {
  const keys = registered.routes.map((r) => r.kind + ' ' + r.path)
  if (new Set(keys).size !== keys.length) throw new Error('有重复路由: ' + keys.join(' | '))
  if (registered.routes.length !== 6) throw new Error('应为 6 条，实际 ' + registered.routes.length)
})

await test('模块级 inject 只声明真实存在的服务名', () => {
  const inj = plugin.inject
  if (!Array.isArray(inj)) throw new Error('inject 不是数组')
  for (const name of inj) {
    if (['register'].includes(name)) throw new Error('inject 里有非服务名: ' + name)
  }
  // settings 已从模块级 inject 移除（改由 ctx.inject 子作用域做降级边界）
  if (inj.includes('settings')) throw new Error('settings 不该在模块级 inject 里（缺该服务的宿主会永久 pending）')
})

await test('Config 的可写字段都是 volatile 引用（0.2.1 update 的前提）', () => {
  const cfg = Config({})
  const { SETTINGS_FIELDS } = plugin.Config ? { SETTINGS_FIELDS: null } : {}
  for (const key of ['scope', 'requestTimeoutMs', 'diskCache', 'diskCacheDir', 'npmCommandTimeoutMs']) {
    const v = cfg[key]
    if (v === null || typeof v !== 'object' || typeof v.get !== 'function') {
      throw new Error(key + ' 不是 volatile 引用')
    }
  }
})

await test('⭐ 写配置走 update(entryId, patch, revision) 三参数', async () => {
  // 找到 POST /settings 路由
  const route = registered.routes.find((r) => r.path === '/plugins/npm-manager/settings')
  if (!route) throw new Error('找不到 /settings 路由')
  let body = ''
  const res = {
    statusCode: 200,
    setHeader() {},
    end(b) { body = b || '' },
  }
  await route.handler(
    { method: 'POST', url: '/plugins/npm-manager/settings', headers: { 'content-type': 'application/json' }, body: { patch: { requestTimeoutMs: 20000 } } },
    res,
  )
  if (res.statusCode !== 200) throw new Error('期望 200，实际 ' + res.statusCode + ' body=' + body.slice(0, 200))
  if (writes.length !== 1) throw new Error('应写 1 次，实际 ' + writes.length)
  const w = writes[0]
  if (w.ns !== 'npm-manager') throw new Error('entryId 不对: ' + w.ns)
  if (w.patch.requestTimeoutMs !== 20000) throw new Error('patch 不对: ' + JSON.stringify(w.patch))
  if (typeof w.revision !== 'number') throw new Error('revision 应传数字，实际 ' + w.revision)
})

await test('⭐ /settings 响应不含 githubToken（凭据不外泄）', async () => {
  const secret = 'ghp_THIS_MUST_NOT_LEAK_1234567890'
  // 重新 apply 一份带 token 的实例
  registered.routes.length = 0
  registered.tools.length = 0
  const ctx2 = { ...ctx, settings: fakeSettings }
  plugin.apply(ctx2, Config({ githubToken: secret }))

  const route = registered.routes.find((r) => r.path === '/plugins/npm-manager/settings')
  let body = ''
  const res = { statusCode: 200, setHeader() {}, end(b) { body = b || '' } }
  await route.handler({ method: 'GET', url: '/plugins/npm-manager/settings', headers: {} }, res)

  if (body.includes(secret)) throw new Error('响应里出现了 githubToken 明文！')
  const j = JSON.parse(body)
  if (j.current && 'githubToken' in j.current) throw new Error('current 里出现了 githubToken 字段')
  if (!j.current || typeof j.current.scope !== 'string') throw new Error('current.scope 应为解引用后的字符串，实际 ' + JSON.stringify(j.current))
})

await test('⭐ POST /settings 缺 Content-Type 时返回 415（CSRF 防护）', async () => {
  const route = registered.routes.find((r) => r.path === '/plugins/npm-manager/settings')
  let body = ''
  const res = { statusCode: 200, setHeader() {}, end(b) { body = b || '' } }
  await route.handler({ method: 'POST', url: '/plugins/npm-manager/settings', headers: {}, body: { patch: {} } }, res)
  if (res.statusCode !== 415) throw new Error('期望 415，实际 ' + res.statusCode)
})

await test('⭐ POST /settings 跨站 Origin 时返回 403', async () => {
  const route = registered.routes.find((r) => r.path === '/plugins/npm-manager/settings')
  let body = ''
  const res = { statusCode: 200, setHeader() {}, end(b) { body = b || '' } }
  await route.handler({
    method: 'POST',
    url: '/plugins/npm-manager/settings',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', host: '127.0.0.1:63470', origin: 'https://evil.example' },
    body: { patch: { scope: 'system' } },
  }, res)
  if (res.statusCode !== 403) throw new Error('期望 403，实际 ' + res.statusCode)
})

console.log(`\n=== 共 ${pass} 通过 / ${fail} 失败 ===\n`)
process.exit(fail === 0 ? 0 : 1)
