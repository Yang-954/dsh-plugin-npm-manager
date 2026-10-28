/**
 * dev-conformance-check.mjs — §13 schema 验证 4 层(真包版)
 *
 * 用 scripts/patch-src.mjs 加载 src/(真 dsh-tools / 真 schemastery, 非 mock):
 *   层 1: 4 个 defineTool 在 apply() 内编译不抛(即注册成功)
 *   层 2: 每个工具的示例返回值通过 validateJsonSchemaValue
 *   层 3: 反向断言(坏值应被 schema 拦截)
 *   层 4: 4 个工具名齐全 + 参数 schema 通过 validateArgs
 */

import path from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildPatchedSrc, PKG_URLS } from './patch-src.mjs'

/*
 * ⚠️⚠️ 全局护栏：把 DSH_HOME 指到临时目录。
 * 本脚本会真实构造 State（磁盘缓存默认启用），不设护栏就会写到用户真实的
 * `~/.dsh/npm-manager/`。单元测试/校验脚本绝不该碰真实 home。
 */
const TEST_DSH_HOME = mkdtempSync(path.join(tmpdir(), 'npmgr-conf-dshhome-'))
process.env.DSH_HOME = TEST_DSH_HOME

const ROOT = path.resolve(import.meta.dirname, '..')

// 真 dsh-tools(与 patched 源里被改写后加载的是同一份)
//
// ⚠️ 宿主包缺失时要**优雅跳过**，而不是 `import(null)` 崩掉整条测试链
//    （旧版写死 profiles/web，本机该目录已空 → npm test 跑到这里必崩）。
const dtUrl = PKG_URLS['@deepseek-ai/dsh-tools']
if (dtUrl === null) {
  console.log('跳过：未找到 @deepseek-ai/dsh-tools（peerDependency，宿主未安装或 profile 不匹配）')
  process.exit(0)
}
const dshTools = await import(dtUrl)
const { validateJsonSchemaValue } = dshTools

const { dirUrl } = buildPatchedSrc('conformance')
const indexMod = await import(`${dirUrl}/index.ts`)
const cfgMod = await import(`${dirUrl}/config.ts`)
const Config = cfgMod.Config

let pass = 0, fail = 0
const test = (label, fn) => {
  try {
    fn()
    console.log('  ✅ ' + label)
    pass++
  } catch (e) {
    console.log('  ❌ ' + label + ': ' + ((e && e.message) ? e.message : String(e)))
    fail++
  }
}

console.log('dsh-tools: ' + dtUrl + ' (HOST 真包)\n')
console.log('=== 层 1: apply() 注册 4 个 defineTool 不抛 ===\n')

const tools = []
/** 捕获 ctx.on 注册的监听器（用于验证 approval gate） */
const listeners = {}
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: {
    register: (t) => { tools.push(t); return () => {} },
    guard: () => () => {},
  },
  on: (event, handler) => { (listeners[event] || (listeners[event] = [])).push(handler); return () => {} },
  webServer: { register: () => () => {} },
  settings: { register: () => ({ watch: () => {}, dispose: () => {} }) },
  effect: (fn) => { fn(); return () => {} },
  // 刻意不调用回调 —— 模拟宿主没有 workspaceRegistry（§2 的降级边界）
  inject: (_deps, _cb) => {},
}

test('apply() 跑通, 注册到 4 个工具', () => {
  indexMod.apply(fakeCtx, Config({}))
  const names = tools.map(t => t.name).sort().join(',')
  const expected = ['npm_apply_upgrade', 'npm_get_package_info', 'npm_list_packages', 'npm_preview_upgrade'].sort().join(',')
  if (tools.length !== 4) throw new Error(`期望 4 个, 实际 ${tools.length}: ${names}`)
  if (names !== expected) throw new Error(`工具名不符: ${names}`)
})

console.log('\n=== 层 2: 示例返回值通过 validateJsonSchemaValue ===\n')

const sampleByName = {
  // 刻意带一个"全系统"形态的包（含 project / projectPath），覆盖新增 schema 字段
  npm_list_packages: {
    packages: [{
      name: 'semver', currentVersion: '^7.6.0', latestVersion: '7.8.5',
      isOutdated: true, updateType: 'major', description: 'x', homepage: 'https://x', repository: 'git+x',
      project: '项目A', projectPath: 'D:\\p\\a',
    }],
    totalCount: 1,
    outdatedCount: 1,
    scope: 'system',
    projectCount: 2,
    packageNames: ['semver'],
    cached: true,
    scannedAt: 1789812261546,
  },
  npm_get_package_info: { found: true, name: 'x', latestVersion: '1.0.0', currentVersion: '1.0.0', description: '', isOutdated: false, updateType: 'same', changelog: [] },
  npm_preview_upgrade: { packages: [], totalWarnings: 0, dryRun: true },
  npm_apply_upgrade: { success: false, executed: false, dryRun: true, packages: [], packageJsonChanged: false, beforeHash: null, afterHash: null, message: 'dry-run 模式' },
}
for (const t of tools) {
  test(t.name + ' 示例返回值校验过', () => {
    const sample = sampleByName[t.name]
    if (!sample) throw new Error('缺示例')
    const violations = validateJsonSchemaValue(t.output.schema, sample, 'value')
    if (violations.length > 0) throw new Error('violations: ' + JSON.stringify(violations))
  })
}

console.log('\n=== 层 3: 反向断言 — 坏值应被 schema 拦截 ===\n')
for (const t of tools) {
  test(t.name + ' 坏值应报错(防 schema 失效)', () => {
    const violations = validateJsonSchemaValue(t.output.schema, { WRONG_KEY: 'bad' }, 'value')
    if (violations.length === 0) throw new Error('坏值未被拦截 — schema 可能无效')
  })
}

console.log('\n=== 层 4: 参数 schema 通过 validateArgs ===\n')
const goodArgsByName = {
  npm_list_packages: { scope: 'system' },
  npm_get_package_info: { name: 'typescript' },
  npm_preview_upgrade: { packages: ['lodash'] },
  npm_apply_upgrade: { packages: ['lodash'], confirm: true, dryRun: true, scope: 'project' },
}
for (const t of tools) {
  test(t.name + ' 合法参数通过 compiled schema 无违规', () => {
    const violations = validateJsonSchemaValue(t.parameters, goodArgsByName[t.name], 'args')
    if (violations.length > 0) throw new Error('violations: ' + JSON.stringify(violations))
  })
}

console.log('\n=== 层 5: npm_apply_upgrade 的审批门（tools/pre-execute）===\n')

/** 调一次 pre-execute 监听器 */
async function gate(exec) {
  const handlers = listeners['tools/pre-execute'] || []
  if (handlers.length === 0) throw new Error('没有注册 tools/pre-execute 监听器')
  let nextCalled = false
  const next = async () => { nextCalled = true; return { kind: 'allow' } }
  const decision = await handlers[0](exec, next)
  return { decision, nextCalled }
}

await test('⭐ 用 tools/pre-execute 注册（不是只能拒绝的 tools.guard）', () => {
  if (!listeners['tools/pre-execute'] || listeners['tools/pre-execute'].length === 0) {
    throw new Error('未注册 tools/pre-execute —— 审批门不会生效')
  }
})

await test('⭐ 源码不再读不存在的 exec.agent.approvals', () => {
  const src = readFileSync(path.join(ROOT, 'src', 'services', 'guards.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  if (/\.approvals/.test(code)) {
    throw new Error('仍在读 exec.agent.approvals —— ToolExecution 上没有这个字段，会导致永久拒绝')
  }
  if (/tools\.guard\(/.test(code)) {
    throw new Error('仍在用 tools.guard() —— 它同步且只能拒绝，没有放行通道')
  }
})

await test('非目标工具直接放行', async () => {
  const { decision, nextCalled } = await gate({ name: 'npm_list_packages', arguments: {} })
  if (decision.kind !== 'allow') throw new Error('应放行，实际 ' + JSON.stringify(decision))
  if (!nextCalled) throw new Error('应调用 next()')
})

await test('confirm 不为 true → 拒绝', async () => {
  for (const args of [{}, { confirm: false }, { confirm: true, dryRun: false, packages: [] }]) {
    const { decision } = await gate({ name: 'npm_apply_upgrade', arguments: args })
    if (args.confirm !== true && decision.kind !== 'deny') {
      throw new Error('confirm 缺失/为 false 时应拒绝，实际 ' + JSON.stringify(decision))
    }
  }
})

await test('⭐ dry-run（默认）直接放行，不打扰用户', async () => {
  const a = await gate({ name: 'npm_apply_upgrade', arguments: { confirm: true } })
  if (a.decision.kind !== 'allow' || !a.nextCalled) {
    throw new Error('dry-run 应放行，实际 ' + JSON.stringify(a.decision))
  }
  const b = await gate({ name: 'npm_apply_upgrade', arguments: { confirm: true, dryRun: true } })
  if (b.decision.kind !== 'allow') throw new Error('dryRun:true 应放行，实际 ' + JSON.stringify(b.decision))
})

await test('⭐ confirm + dryRun:false → 返回 ask（走官方审批链）', async () => {
  const { decision, nextCalled } = await gate({
    name: 'npm_apply_upgrade',
    arguments: { confirm: true, dryRun: false, packages: ['semver'] },
  })
  if (decision.kind !== 'ask') {
    throw new Error('真实升级应返回 {kind:"ask"}，实际 ' + JSON.stringify(decision))
  }
  if (typeof decision.reason !== 'string' || decision.reason.length === 0) {
    throw new Error('ask 应带 reason 供用户判断')
  }
  if (nextCalled) throw new Error('ask 不应再调 next()')
})

console.log('\n=== 层 6: 渲染输出（防止整段 JSON 淹没上下文）===\n')

await test('⭐ npm_list_packages 渲染成逐行文本，不是 JSON', () => {
  const t = tools.find((x) => x.name === 'npm_list_packages')
  if (!t) throw new Error('缺该工具')
  const text = t.output.render({}, sampleByName.npm_list_packages)[0].text
  if (text.trimStart().startsWith('{')) throw new Error('不应是 JSON: ' + text.slice(0, 80))
  if (!/共 1 个包/.test(text)) throw new Error('缺统计行: ' + text.slice(0, 120))
  if (!/semver/.test(text)) throw new Error('缺包名')
})

await test('⭐ npm_get_package_info 渲染 changelog 且会截断超长 notes', () => {
  const t = tools.find((x) => x.name === 'npm_get_package_info')
  if (!t) throw new Error('缺该工具')
  const longNotes = Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n')
  const value = {
    name: 'demo', currentVersion: '1.0.0', latestVersion: '2.0.0',
    description: 'd', isOutdated: true, updateType: 'major',
    changelog: [{ version: '2.0.0', date: '2024-01-01', notes: longNotes, source: 'github-releases' }],
  }
  const text = t.output.render({}, value)[0].text
  if (text.trimStart().startsWith('{')) throw new Error('不应是 JSON')
  if (!/2\.0\.0/.test(text) || !/2024-01-01/.test(text)) throw new Error('缺版本/日期')
  if (!/GitHub Releases/.test(text)) throw new Error('缺来源标注')
  if (!/已截断/.test(text)) throw new Error('超长 notes 应标注已截断')
  if (text.split('\n').length > 40) throw new Error('渲染过长: ' + text.split('\n').length + ' 行')
})

await test('changelog 为空数组时渲染不崩且不显示空标题', () => {
  const t = tools.find((x) => x.name === 'npm_get_package_info')
  const text = t.output.render({}, {
    name: 'demo', currentVersion: '1.0.0', latestVersion: '1.0.0',
    description: '', isOutdated: false, updateType: 'same', changelog: [],
  })[0].text
  if (/更新日志/.test(text)) throw new Error('空 changelog 不应显示更新日志标题')
  if (!/demo/.test(text)) throw new Error('应至少显示包名')
})

await test('changelog source=none 时渲染出说明文字', () => {
  const t = tools.find((x) => x.name === 'npm_get_package_info')
  const text = t.output.render({}, {
    name: 'demo', currentVersion: '1.0.0', latestVersion: '1.0.0',
    description: '', isOutdated: false, updateType: 'same',
    changelog: [{ version: '', notes: '没有找到更新日志', source: 'none' }],
  })[0].text
  if (!/没有找到更新日志/.test(text)) throw new Error('应渲染出占位说明: ' + text)
})

console.log('\n=== 共 ' + pass + ' 通过 / ' + fail + ' 失败 ===\n')

// 清理测试用的 DSH_HOME
try { rmSync(TEST_DSH_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

process.exit(fail === 0 ? 0 : 1)
