/**
 * tool-schema-verify.mjs — 服务层纯函数 + State 行为
 *
 * 用 scripts/patch-src.mjs 加载 src/(真 dsh-tools / 真 schemastery, 非 mock):
 *   - scanner 读 package.json / 三范围 / 项目归属
 *   - detectUpdateType 语义
 *   - State.listProjects / listPackages 返回形状
 */

import path from 'node:path'
import { statSync } from 'node:fs'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { buildPatchedSrc } from '../scripts/patch-src.mjs'

/*
 * ⚠️⚠️ 全局护栏：把 DSH_HOME 指到临时目录。
 *
 * 磁盘缓存默认启用，而 `new State(Config({}), ...)` 会用它。
 * 不设这道护栏，跑一次测试就会在用户真实的 `~/.dsh/npm-manager/` 下
 * 建目录、写文件、再被别的用例删掉（实测踩过：留下一个空目录）。
 * 单元测试绝不该碰真实 home。
 */
const REAL_DSH_HOME = path.join(homedir(), '.dsh')
const TEST_DSH_HOME = mkdtempSync(path.join(tmpdir(), 'npmgr-dshhome-'))
process.env.DSH_HOME = TEST_DSH_HOME

/** 记录真实缓存文件的初始状态，跑完后比对 —— 用于证明测试没碰过它 */
const REAL_CACHE_FILE = path.join(REAL_DSH_HOME, 'npm-manager', 'cache', 'registry.json')
const REAL_CACHE_BEFORE = (() => {
  try {
    const st = statSync(REAL_CACHE_FILE)
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false }
  }
})()

const ROOT = path.resolve(import.meta.dirname, '..')
const { dirUrl } = buildPatchedSrc('schema')

const scanner = await import(`${dirUrl}/services/scanner.ts`)
const registry = await import(`${dirUrl}/services/registry.ts`)
const stateMod = await import(`${dirUrl}/services/state.ts`)
const cfgMod = await import(`${dirUrl}/config.ts`)

const {
  scanPackages, scanLocalPackages, scanGlobalPackages,
  globalNodeModulesCandidates, normalizeScope, discoverNodeProjects,
} = scanner
const { detectUpdateType, RegistryClient } = registry
const { State } = stateMod
const Config = cfgMod.Config
const { SETTINGS_FIELDS, WRITABLE_SETTING_KEYS } = cfgMod

const { join, relative } = path

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

console.log('=== 层 1: 配置与纯函数 ===\n')

await test('Config(真 schemastery) parse({}) 给出全默认值', () => {
  const cfg = Config({})
  if (cfg.scope !== 'project') throw new Error('scope 默认应为 project，实际 ' + cfg.scope)
  if (cfg.registryCacheTtlMs !== 300_000) throw new Error('ttl 默认 300000')
  if (cfg.enableChangelog !== true) throw new Error('enableChangelog 默认 true')
  if (cfg.npmCommandTimeoutMs !== 60_000) throw new Error('timeout 默认 60000')
})

await test('normalizeScope 收敛旧值与非法值', () => {
  if (normalizeScope('project') !== 'project') throw new Error('project')
  if (normalizeScope('global') !== 'global') throw new Error('global')
  if (normalizeScope('system') !== 'system') throw new Error('system')
  if (normalizeScope('both') !== 'project') throw new Error('旧值 both 应回落到 project')
  if (normalizeScope(undefined) !== 'project') throw new Error('undefined 应回落到 project')
  if (normalizeScope('local') !== 'project') throw new Error('旧值 local 应回落到 project')
})

await test('detectUpdateType: same/major/minor/patch/downgrade', () => {
  if (detectUpdateType('1.0.0', '1.0.0') !== 'same') throw new Error('same')
  if (detectUpdateType('1.0.0', '2.0.0') !== 'major') throw new Error('major')
  if (detectUpdateType('1.0.0', '1.1.0') !== 'minor') throw new Error('minor')
  if (detectUpdateType('1.0.0', '1.0.1') !== 'patch') throw new Error('patch')
  if (detectUpdateType('2.0.0', '1.0.0') !== 'downgrade') throw new Error('downgrade')
})

await test('detectUpdateType: 非 semver 兜底 same 不崩', () => {
  if (detectUpdateType('not-semver', 'also-not') !== 'same') throw new Error('应兜底 same')
})

console.log('\n=== 层 2: 三范围扫描 ===\n')

/**
 * 临时项目目录：写一份 package.json + node_modules 占位，
 * 这样扫描测试不依赖仓库里实际装了什么包。
 *
 * ⚠️ 不写 node_modules/.package-lock.json —— scanLocalPackages 不读它。
 */
function makePkgDir(dependencies) {
  const tmp = mkdtempSync(join(tmpdir(), 'npmgr-pkg-'))
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    name: 'fake-project',
    version: '1.0.0',
    dependencies,
  }, null, 2))
  return tmp
}

await test('project 范围读 package.json 发现依赖', () => {
  const pkgDir = makePkgDir({ semver: '^7.0.0', 'node-fetch': '^2.7.0' })
  try {
    const pkgs = scanPackages('project', true, { cwd: pkgDir })
    if (pkgs.length === 0) throw new Error('应至少返回一个依赖')
    if (!pkgs.find((p) => p.name === 'semver')) throw new Error('应发现 semver 依赖')
    if (!pkgs.find((p) => p.name === 'node-fetch')) throw new Error('应发现 node-fetch 依赖')
    // project 范围不应带项目归属（那是 system 的事）
    if (pkgs.some((p) => p.project !== undefined)) throw new Error('project 范围不应填充 project 字段')
  } finally {
    rmSync(pkgDir, { recursive: true, force: true })
  }
})

await test('project 范围可用 projectPath 指向任意目录', () => {
  const pkgDir = makePkgDir({ semver: '^7.0.0' })
  try {
    const pkgs = scanPackages('project', true, { cwd: 'C:/definitely/not/here', projectPath: pkgDir })
    if (!pkgs.find((p) => p.name === 'semver')) throw new Error('应使用 projectPath 而非 cwd')
  } finally {
    rmSync(pkgDir, { recursive: true, force: true })
  }
})

await test('project 范围目录不存在时返回空数组而不是抛错', () => {
  const pkgs = scanPackages('project', true, { cwd: 'C:/definitely/not/here' })
  if (!Array.isArray(pkgs) || pkgs.length !== 0) throw new Error('应为空数组')
})

await test('⭐ system 范围给每个包标注所属项目，且不跨项目去重', () => {
  const pkgA = makePkgDir({ semver: '^7.0.0' })
  const pkgB = makePkgDir({ semver: '^7.0.0' })
  try {
    const projects = [
      { id: 'a', title: '项目A', path: pkgA },
      { id: 'b', title: '项目B', path: pkgB },
    ]
    const pkgs = scanPackages('system', true, { cwd: pkgA, projects })
    const semvers = pkgs.filter((p) => p.name === 'semver')
    if (semvers.length !== 2) throw new Error('同名包出现在两个项目里应产生 2 行，实际 ' + semvers.length)
    if (!semvers.every((p) => p.project && p.projectPath)) throw new Error('每行都应带 project / projectPath')
    const titles = semvers.map((p) => p.project).sort()
    if (titles.join(',') !== '项目A,项目B') throw new Error('项目名不对: ' + titles.join(','))
  } finally {
    rmSync(pkgA, { recursive: true, force: true })
    rmSync(pkgB, { recursive: true, force: true })
  }
})

await test('system 范围目录不存在时跳过而不崩', () => {
  const pkgs = scanPackages('system', true, { cwd: ROOT, projects: [{ id: 'x', title: 'X', path: 'C:/nope' }] })
  if (!Array.isArray(pkgs) || pkgs.length !== 0) throw new Error('应为空数组')
})

console.log('\n=== 层 3: 全局扫描（含两个已修缺陷）===\n')

await test('⭐ 全局候选路径含 USERPROFILE 兜底（不只认 APPDATA）', () => {
  const saved = { APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE }
  try {
    delete process.env.APPDATA
    process.env.USERPROFILE = 'C:\\Users\\TestUser'
    const c = globalNodeModulesCandidates()
    if (!c.some(p => p.toLowerCase().includes('appdata\\roaming\\npm\\node_modules'))) {
      throw new Error('APPDATA 缺失时未回退到 USERPROFILE，候选: ' + JSON.stringify(c))
    }
  } finally {
    if (saved.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.APPDATA
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE
  }
})

await test('⭐ 全局扫描包含 scoped 包（@scope/name 需下钻一层）', () => {
  const found = scanGlobalPackages()
  if (found.length === 0) {
    console.log('     （本机全局目录为空或不可达，跳过 scoped 断言）')
    return
  }
  const scoped = found.filter(p => p.name.startsWith('@'))
  if (scoped.length === 0) {
    throw new Error('全局目录非空却一个 scoped 包都没扫到 —— 说明 @scope 分支被跳过了。找到: ' +
      found.map(p => p.name).join(', '))
  }
  if (!scoped.every(p => p.name.includes('/'))) throw new Error('scoped 包名格式应为 @scope/name')
})

await test('全局扫描结果字段完整', () => {
  for (const p of scanGlobalPackages()) {
    if (typeof p.name !== 'string' || p.name === '') throw new Error('name 缺失')
    if (typeof p.currentVersion !== 'string' || p.currentVersion === '') throw new Error('version 缺失: ' + p.name)
  }
})

await test('scanLocalPackages 对无 package.json 的目录返回空数组', () => {
  const r = scanLocalPackages('C:/definitely/not/here', true)
  if (!Array.isArray(r) || r.length !== 0) throw new Error('应为空数组')
})

console.log('\n=== 层 4: 项目发现 ===\n')

/** 造一棵临时目录树当夹具 */
function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'npmgr-proj-'))
  const mk = (rel, name) => {
    const dir = rel ? join(tmp, rel) : tmp
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  mk('', 'root')
  mk('sub', 'sub')
  mk('sub/deep', 'deep')
  mk('sub/deep/too-far', 'too-far')
  mk('node_modules/dep', 'dep')
  mk('_backup-old', 'backup')
  mk('.hidden', 'hidden')
  mk('dist', 'dist')
  return tmp
}

await test('⭐ discoverNodeProjects：含 root 自身、下钻子项目、跳过依赖/隐藏/备份/构建目录', () => {
  const tmp = makeFixture()
  try {
    const found = discoverNodeProjects(tmp, { maxDepth: 2 })
      .map((d) => relative(tmp, d).replace(/\\/g, '/'))
      .sort()
    const expect = ['', 'sub', 'sub/deep'].sort()
    if (found.join('|') !== expect.join('|')) {
      throw new Error('发现结果不符。实际: [' + found.join(', ') + '] 期望: [' + expect.join(', ') + ']')
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

await test('discoverNodeProjects：maxDepth 生效（0 = 只看 root）', () => {
  const tmp = makeFixture()
  try {
    const found = discoverNodeProjects(tmp, { maxDepth: 0 }).map((d) => relative(tmp, d).replace(/\\/g, '/'))
    if (found.join('|') !== '') throw new Error('maxDepth=0 应只返回 root，实际: ' + JSON.stringify(found))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

await test('discoverNodeProjects：limit 生效', () => {
  const tmp = makeFixture()
  try {
    const found = discoverNodeProjects(tmp, { maxDepth: 3, limit: 2 })
    if (found.length !== 2) throw new Error('limit=2 应只返回 2 个，实际 ' + found.length)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

await test('discoverNodeProjects：目录不存在返回空数组', () => {
  const r = discoverNodeProjects('C:/definitely/not/here')
  if (!Array.isArray(r) || r.length !== 0) throw new Error('应为空数组')
})

console.log('\n=== 层 5: State 的项目列表与包列表形状 ===\n')

await test('⭐ listProjects：cwd 排第一，工作区子项目标题为「工作区/相对路径」', () => {
  const tmp = makeFixture()
  try {
    const state = new State(Config({}), { cwd: tmp })
    state.setWorkspaceProvider(() => [{ id: 'w', title: '测试工作区', path: tmp }])
    const list = state.listProjects()
    // cwd(=tmp 自身) 排第一；工作区发现到的 sub / sub/deep 追加在后（root 与 cwd 重复 → 去掉）
    const titles = list.map((p) => p.title)
    if (list[0].isCurrent !== true) throw new Error('第一个应是当前 cwd')
    if (!titles.includes('测试工作区/sub')) throw new Error('缺 测试工作区/sub，实际: ' + titles.join(', '))
    if (!titles.includes('测试工作区/sub/deep')) throw new Error('缺 测试工作区/sub/deep，实际: ' + titles.join(', '))
    if (titles.filter((t) => t === 'dsh-plugin-npm-manager').length > 1) throw new Error('cwd 不应重复')
    const sub = list.find((p) => p.title === '测试工作区/sub')
    if (sub.workspace !== '测试工作区') throw new Error('应带 workspace 归属')
    if (sub.isCurrent !== false) throw new Error('子项目 isCurrent 应为 false')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

await test('listProjects：没有 workspaceRegistry 时降级为只有 cwd', () => {
  const state = new State(Config({}), { cwd: ROOT })
  const list = state.listProjects()
  if (list.length !== 1) throw new Error('期望只有 cwd，实际 ' + list.length)
  if (list[0].isCurrent !== true) throw new Error('应是当前 cwd')
})

await test('listProjects：workspaceProvider 抛错时不崩', () => {
  const state = new State(Config({}), { cwd: ROOT })
  state.setWorkspaceProvider(() => { throw new Error('boom') })
  const list = state.listProjects()
  if (list.length !== 1) throw new Error('应降级为只有 cwd')
})

await test('listProjects：结果被缓存，invalidate() 后失效', () => {
  const state = new State(Config({}), { cwd: ROOT })
  let calls = 0
  state.setWorkspaceProvider(() => { calls++; return [{ id: 'w', title: 'W', path: ROOT }] })
  state.listProjects()
  state.listProjects()
  if (calls !== 1) throw new Error('第二次应命中缓存，provider 被调用 ' + calls + ' 次')
  state.invalidate()
  state.listProjects()
  if (calls !== 2) throw new Error('invalidate 后应重新发现，实际 ' + calls + ' 次')
})

await test('State.listPackages(project) 形状字段齐全', async () => {
  const state = new State(Config({}), { cwd: ROOT })
  const result = await state.listPackages('project')
  if (typeof result.totalCount !== 'number') throw new Error('totalCount 缺失')
  if (typeof result.outdatedCount !== 'number') throw new Error('outdatedCount 缺失')
  if (result.scope !== 'project') throw new Error('scope 错误: ' + result.scope)
  if (!Array.isArray(result.packages)) throw new Error('packages 不是数组')
  if (!Array.isArray(result.packageNames)) throw new Error('packageNames 不是数组')
  if (result.projectCount !== undefined) throw new Error('project 范围不应有 projectCount')
})

await test('State.listPackages(system) 带 projectCount 且 packageNames 去重', async () => {
  const state = new State(Config({}), { cwd: ROOT })
  state.setWorkspaceProvider(() => [{ id: 'w', title: 'W', path: ROOT }])
  const result = await state.listPackages('system')
  if (result.scope !== 'system') throw new Error('scope 错误')
  if (result.projectCount !== 1) throw new Error('projectCount 应为 1，实际 ' + result.projectCount)
  const names = result.packageNames
  if (new Set(names).size !== names.length) throw new Error('packageNames 应去重')
})

await test('State.listPackages 非法 scope 回落到配置值', async () => {
  const state = new State(Config({}), { cwd: ROOT })
  const result = await state.listPackages('nonsense')
  if (result.scope !== 'project') throw new Error('应回落到 project，实际 ' + result.scope)
})

console.log('\n=== 层 6: 结果缓存 ===\n')

/*
 * 缓存测试一律用**不存在的项目路径**：scanLocalPackages 会立刻返回 []，
 * 因此零 registry 网络请求 —— 测试既快又确定（不受网络影响）。
 * 缓存键、cached 标记、scannedAt、invalidate 语义全都能覆盖到。
 */
const NOWHERE = 'C:/definitely/not/here'
const NOWHERE2 = 'C:/definitely/not/here-either'

await test('⭐ 同一 (scope, project) 第二次调用命中缓存，scannedAt 不变', async () => {
  const state = new State(Config({}), { cwd: ROOT })
  const a = await state.listPackages('project', NOWHERE)
  if (a.cached !== false) throw new Error('首次调用不应标 cached')
  if (typeof a.scannedAt !== 'number') throw new Error('首次调用应带 scannedAt')

  const b = await state.listPackages('project', NOWHERE)
  if (b.cached !== true) throw new Error('第二次调用应标 cached=true')
  if (b.scannedAt !== a.scannedAt) throw new Error('缓存命中时 scannedAt 应保持原始扫描时间')
  if (b.totalCount !== a.totalCount) throw new Error('缓存命中时结果应一致')
})

await test('⭐ 不同 scope / 不同 project 各自独立缓存', async () => {
  const state = new State(Config({}), { cwd: ROOT })
  const p1 = await state.listPackages('project', NOWHERE)
  const g1 = await state.listPackages('project', NOWHERE2)
  const s1 = await state.listPackages('global')
  if (p1.cached !== false || g1.cached !== false || s1.cached !== false) {
    throw new Error('三个不同 key 的首次调用都应是 cached=false')
  }
  if (state.listCacheSize() !== 3) throw new Error('应有 3 个缓存条目，实际 ' + state.listCacheSize())
  const p2 = await state.listPackages('project', NOWHERE)
  if (p2.cached !== true) throw new Error('同 key 第二次应命中')
})

await test('⭐ 缓存键区分 scope：project 与 system 不串味', async () => {
  const state = new State(Config({}), { cwd: ROOT })
  const a = await state.listPackages('project', NOWHERE)
  const b = await state.listPackages('global')
  if (a.scope !== 'project' || b.scope !== 'global') throw new Error('scope 串味')
  if (state.listCacheSize() !== 2) throw new Error('应为 2 个独立条目')
})

await test('⭐ invalidate() 清空结果缓存（「刷新缓存」按钮的语义）', async () => {
  const state = new State(Config({}), { cwd: ROOT })
  await state.listPackages('project', NOWHERE)
  await state.listPackages('project', NOWHERE)
  if (state.listCacheSize() === 0) throw new Error('应已有缓存')
  state.invalidate()
  if (state.listCacheSize() !== 0) throw new Error('invalidate 后结果缓存应清空')
  const again = await state.listPackages('project', NOWHERE)
  if (again.cached !== false) throw new Error('清空后应重新扫描')
})

await test('⭐ invalidate() 同时清空 registry 元数据缓存（否则刷新是假的）', async () => {
  const state = new State(Config({}), { cwd: ROOT })
  // 直接往 registry 客户端里塞一个条目，验证 invalidate 会清掉它
  state.registryClient.cacheSet('pkg:__probe__', { name: '__probe__' }, 60_000)
  if (state.registryClient.cacheSize() < 1) throw new Error('预置缓存失败')
  state.invalidate()
  if (state.registryClient.cacheSize() !== 0) {
    throw new Error('invalidate 未清 registry 缓存 → 「刷新缓存」按钮不会真的刷新元数据')
  }
})

await test('缓存 TTL 到期后重新扫描', async () => {
  const state = new State(Config({ listCacheTtlMs: 1 }), { cwd: ROOT })
  const a = await state.listPackages('project', NOWHERE)
  if (a.cached !== false) throw new Error('首次应是新扫描')
  await new Promise((r) => setTimeout(r, 15))
  const b = await state.listPackages('project', NOWHERE)
  if (b.cached !== false) throw new Error('TTL 到期后应重新扫描，实际 cached=' + b.cached)
})

await test('listCacheTtlMs 非法值（0）回落到默认，不变成"禁用缓存"', async () => {
  const state = new State(Config({ listCacheTtlMs: 0 }), { cwd: ROOT })
  await state.listPackages('project', NOWHERE)
  const b = await state.listPackages('project', NOWHERE)
  if (b.cached !== true) throw new Error('0 应被当作"用默认值"，而非禁用缓存')
})

await test('缓存结果可 JSON 序列化（字段都是 JSON 安全的）', async () => {
  const state = new State(Config({}), { cwd: ROOT })
  const r = await state.listPackages('project', NOWHERE)
  const round = JSON.parse(JSON.stringify(r))
  if (round.scope !== r.scope) throw new Error('scope 丢失')
  if (round.totalCount !== r.totalCount) throw new Error('totalCount 丢失')
  if (round.cached !== r.cached) throw new Error('cached 丢失')
  if (round.scannedAt !== r.scannedAt) throw new Error('scannedAt 丢失')
})

console.log('\n=== 层 7: 磁盘缓存（跨进程存活）===\n')

const diskMod = await import(`${dirUrl}/services/disk-cache.ts`)
const { DiskCache, resolveDshHome } = diskMod

/** 每个用例一个独立临时目录，绝不碰真实的 ~/.dsh */
function tempCacheDir() {
  return mkdtempSync(join(tmpdir(), 'npmgr-cache-'))
}

await test('resolveDshHome：DSH_HOME 覆盖与 ~/ 前缀', () => {
  if (resolveDshHome({ DSH_HOME: 'D:\\custom' }, 'C:\\Users\\X') !== 'D:\\custom') {
    throw new Error('绝对路径应原样返回')
  }
  const tilde = resolveDshHome({ DSH_HOME: '~/dshhome' }, 'C:\\Users\\X')
  if (!tilde.includes('dshhome')) throw new Error('~/ 前缀未展开: ' + tilde)
  if (resolveDshHome({}, 'C:\\Users\\X').includes('npm-manager')) {
    throw new Error('默认应返回 <home>/.dsh')
  }
  if (!resolveDshHome({}, 'C:\\Users\\X').endsWith('.dsh')) throw new Error('默认应为 ~/.dsh')
})

await test('⭐ 缓存落在 <root>/cache/ 子目录（与将来的持久数据分开）', () => {
  const root = tempCacheDir()
  try {
    const dc = new DiskCache({ dir: root })
    const p = dc.path.replace(/\\/g, '/')
    if (!/\/cache\/registry\.json$/.test(p)) {
      throw new Error('路径应为 <root>/cache/registry.json，实际 ' + p)
    }
    if (dc.cacheDir.replace(/\\/g, '/') !== root.replace(/\\/g, '/') + '/cache') {
      throw new Error('cacheDir 不对: ' + dc.cacheDir)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('⭐ 落盘后新实例能读到（模拟 dsh 重启）', () => {
  const root = tempCacheDir()
  try {
    const a = new DiskCache({ dir: root, flushDelayMs: 10 })
    a.set('pkg:semver', { name: 'semver', 'dist-tags': { latest: '7.8.5' } }, 60_000)
    a.flush()

    const b = new DiskCache({ dir: root })
    const got = b.get('pkg:semver')
    if (!got || got.name !== 'semver') throw new Error('新实例未读到磁盘缓存: ' + JSON.stringify(got))
    if (b.size() !== 1) throw new Error('size 应为 1，实际 ' + b.size())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('过期条目在 load 时被丢弃', () => {
  const root = tempCacheDir()
  try {
    const a = new DiskCache({ dir: root })
    a.set('k-fresh', 'v1', 60_000)
    a.set('k-stale', 'v2', -1) // 负数 TTL → set 直接忽略
    a.flush()

    // 手工塞一条已过期的（绕过 set 的 TTL 校验）
    const file = a.path
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.entries['k-expired'] = { value: 'old', expiresAt: Date.now() - 1000 }
    writeFileSync(file, JSON.stringify(raw), 'utf8')

    const b = new DiskCache({ dir: root })
    if (b.get('k-expired') !== undefined) throw new Error('过期条目应被丢弃')
    if (b.get('k-fresh') !== 'v1') throw new Error('未过期条目应保留')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('⭐ 文件损坏时降级为空缓存且不崩', () => {
  const root = tempCacheDir()
  try {
    const a = new DiskCache({ dir: root })
    mkdirSync(join(root, 'cache'), { recursive: true })
    writeFileSync(a.path, '{ this is not json', 'utf8')

    const b = new DiskCache({ dir: root })
    if (b.get('anything') !== undefined) throw new Error('损坏文件不应给出数据')
    if (b.size() !== 0) throw new Error('损坏后应为空')
    if (!b.isDisabled) throw new Error('损坏后应标记 disabled，避免反复重试')
    // disabled 状态下写入应被忽略，但不抛错
    b.set('k', 'v', 1000)
    b.flush()
    if (b.size() !== 0) throw new Error('disabled 时不应写入')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('文件超过体积上限时整体丢弃重建', () => {
  const root = tempCacheDir()
  try {
    const a = new DiskCache({ dir: root, maxBytes: 64 })
    mkdirSync(join(root, 'cache'), { recursive: true })
    writeFileSync(a.path, JSON.stringify({ entries: { k: { value: 'x'.repeat(500), expiresAt: Date.now() + 60000 } } }), 'utf8')
    const b = new DiskCache({ dir: root, maxBytes: 64 })
    if (b.size() !== 0) throw new Error('超大文件应被丢弃')
    if (existsSync(a.path)) throw new Error('超大文件应被删除')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('⭐ 单条 entry 超 512KB 直接跳过（防巨型包毁掉整个缓存）', () => {
  const root = tempCacheDir()
  try {
    const dc = new DiskCache({ dir: root })
    // 模拟一个巨型包（实际是 eslint-plugin-react-hooks 的尺寸量级）
    const huge = { name: 'pkg-huge', readme: 'x'.repeat(600 * 1024) }
    const normal = { name: 'pkg-normal', description: 'small' }
    dc.set('pkg:huge', huge, 60_000)
    dc.set('pkg:normal', normal, 60_000)
    dc.flush()
    if (!existsSync(dc.path)) throw new Error('应已落盘')
    const j = JSON.parse(readFileSync(dc.path, 'utf8'))
    const keys = Object.keys(j.entries)
    if (keys.includes('pkg:huge')) throw new Error('巨型包应被跳过（实际没跳过）')
    if (!keys.includes('pkg:normal')) throw new Error('正常包不应被跳过')
    if (dc.get('pkg:huge') !== undefined) throw new Error('set() 就应拒绝巨型包，不该进内存')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('⭐ 巨型包不拖累整体：混合大小写文件落盘后整体未超 maxBytes', () => {
  const root = tempCacheDir()
  try {
    const dc = new DiskCache({ dir: root, maxBytes: 8 * 1024 * 1024 })
    // 50 个普通 + 1 个巨型 —— 文件应能装下其余 50 条
    for (let i = 0; i < 50; i++) dc.set('k' + i, { name: 'p' + i, desc: 'small' }, 60_000 + i)
    dc.set('k-huge', { name: 'h', readme: 'x'.repeat(800 * 1024) }, 60_000)
    dc.flush()
    const sz = statSync(dc.path).size
    if (sz > 8 * 1024 * 1024) throw new Error('整体超 maxBytes: ' + sz)
    const j = JSON.parse(readFileSync(dc.path, 'utf8'))
    if (Object.keys(j.entries).length !== 50) {
      throw new Error('期望 50 条普通包，实际 ' + Object.keys(j.entries).length)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('条目数超上限时淘汰最旧的一批', () => {
  const root = tempCacheDir()
  try {
    const dc = new DiskCache({ dir: root, maxEntries: 10 })
    for (let i = 0; i < 30; i++) dc.set('k' + i, i, 60_000 + i) // expiresAt 递增
    if (dc.size() > 10) throw new Error('应被裁剪到 <=10，实际 ' + dc.size())
    // 保留的应该是较晚过期的
    if (dc.get('k0') !== undefined) throw new Error('最旧的应被淘汰')
    if (dc.get('k29') === undefined) throw new Error('最新的应保留')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('clear() 同时清空内存与文件', () => {
  const root = tempCacheDir()
  try {
    const dc = new DiskCache({ dir: root })
    dc.set('k', 'v', 60_000)
    dc.flush()
    if (!existsSync(dc.path)) throw new Error('前置条件：文件应已生成')
    dc.clear()
    if (dc.size() !== 0) throw new Error('内存未清空')
    if (existsSync(dc.path)) throw new Error('文件未删除')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('写入的文件带 note 字段（打开就知道能删）', () => {
  const root = tempCacheDir()
  try {
    const dc = new DiskCache({ dir: root })
    dc.set('k', 'v', 60_000)
    dc.flush()
    const parsed = JSON.parse(readFileSync(dc.path, 'utf8'))
    if (typeof parsed.note !== 'string' || !/safe to delete/i.test(parsed.note)) {
      throw new Error('缺 note 或措辞不对: ' + JSON.stringify(parsed.note))
    }
    if (typeof parsed.savedAt !== 'number') throw new Error('缺 savedAt')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('⭐ RegistryClient：新实例（新内存）能从磁盘命中', () => {
  const root = tempCacheDir()
  try {
    const diskA = new DiskCache({ dir: root })
    const clientA = new RegistryClient({ diskCache: diskA, diskTtlMs: 60_000 })
    // 直接写进缓存层，模拟"上一次进程拉过这个包"
    clientA.cacheSet('pkg:__probe__', { name: '__probe__' }, 60_000)
    clientA.flushDiskCache()

    // 新进程：新内存缓存 + 同一个磁盘目录
    const diskB = new DiskCache({ dir: root })
    const clientB = new RegistryClient({ diskCache: diskB, diskTtlMs: 60_000 })
    if (clientB.cacheSize() !== 0) throw new Error('前置条件：新客户端内存应为空')
    const hit = clientB.cacheGet('pkg:__probe__')
    if (!hit || hit.name !== '__probe__') throw new Error('未从磁盘命中: ' + JSON.stringify(hit))
    if (clientB.cacheSize() !== 1) throw new Error('磁盘命中后应回填内存')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('⭐ clearCache() 连磁盘一起清（否则重启后旧数据又回来）', () => {
  const root = tempCacheDir()
  try {
    const disk = new DiskCache({ dir: root })
    const client = new RegistryClient({ diskCache: disk, diskTtlMs: 60_000 })
    client.cacheSet('pkg:x', { name: 'x' }, 60_000)
    client.flushDiskCache()
    if (!existsSync(disk.path)) throw new Error('前置条件：应已落盘')

    client.clearCache()
    if (client.cacheSize() !== 0) throw new Error('内存未清')
    if (client.diskCacheSize() !== 0) throw new Error('磁盘未清')
    if (existsSync(disk.path)) throw new Error('文件未删除')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('⭐ 只缓存精简投影：完整 packument 不落盘', async () => {
  const orig = globalThis.fetch
  const root = tempCacheDir()
  try {
    // 模拟一个巨大的 packument（react 的量级）
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        name: 'big-pkg',
        'dist-tags': { latest: '2.0.0' },
        description: 'a big one',
        readme: 'x'.repeat(500 * 1024),
        versions: { '1.0.0': {}, '2.0.0': {} },
      }),
    })
    const disk = new DiskCache({ dir: root })
    const client = new RegistryClient({ diskCache: disk, diskTtlMs: 60_000 })
    const meta = await client.getPackageMeta('big-pkg', '1.0.0')
    if (!meta || meta.latestVersion !== '2.0.0') throw new Error('meta 解析失败: ' + JSON.stringify(meta))
    client.flushDiskCache()

    const j = JSON.parse(readFileSync(disk.path, 'utf8'))
    const keys = Object.keys(j.entries)
    if (keys.some((k) => k.startsWith('pkg:'))) {
      throw new Error('完整 packument 不应落盘（会撑爆缓存）: ' + keys.join(','))
    }
    if (!keys.includes('meta:big-pkg')) throw new Error('精简投影应落盘: ' + keys.join(','))
    const sz = statSync(disk.path).size
    if (sz > 4096) throw new Error('落盘内容过大，说明存了完整 packument: ' + sz + ' 字节')
  } finally {
    globalThis.fetch = orig
    rmSync(root, { recursive: true, force: true })
  }
})

await test('⭐ 同一包重复调用命中精简缓存，只请求一次（跨项目去重靠它）', async () => {
  const orig = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = () => {
      calls++
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ name: 'p', 'dist-tags': { latest: '1.0.0' }, description: '' }),
      })
    }
    const client = new RegistryClient({})
    const a = await client.getPackageMeta('p', '1.0.0')
    const b = await client.getPackageMeta('p', '1.0.0')
    const c = await client.getPackageMeta('p', '0.9.0') // 同一包、不同当前版本 → 仍复用缓存
    if (calls !== 1) throw new Error('应只请求 1 次，实际 ' + calls)
    if (a.isOutdated !== false) throw new Error('1.0.0 对 1.0.0 不应过期')
    if (c.isOutdated !== true) throw new Error('0.9.0 对 1.0.0 应过期')
    if (b.latestVersion !== '1.0.0') throw new Error('缓存复用结果不对')
  } finally {
    globalThis.fetch = orig
  }
})

await test('diskCache:false 时不创建磁盘缓存', () => {  const root = tempCacheDir()
  try {
    const st = new State(Config({ diskCache: false, diskCacheDir: root }), { cwd: ROOT })
    if (st.diskCache !== null) throw new Error('应禁用磁盘缓存')
    if (st.registryClient.diskCacheSize() !== 0) throw new Error('不应有磁盘条目')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 用根 tempdir 覆盖默认 DSH_HOME 路径，确保 State 不会写真实 home */
const SAFE_ROOT = tempCacheDir() + '/dsh-root'

await test('State 用配置的 diskCacheDir，并落在其 cache/ 下', () => {
  const root = tempCacheDir()
  try {
    const st = new State(Config({ diskCacheDir: root }), { cwd: ROOT })
    if (st.diskCache === null) throw new Error('应启用磁盘缓存')
    const p = st.diskCache.path.replace(/\\/g, '/')
    if (!p.startsWith(root.replace(/\\/g, '/') + '/cache/')) {
      throw new Error('未落在配置目录的 cache/ 下: ' + p)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

console.log('\n=== 层 8: 配置写入（applySettingsPatch）===\n')

await test('⭐ 没有 settings 作用域时拒绝写入（只读降级）', async () => {
  const state = new State(Config({ diskCache: false }), { cwd: ROOT })
  if (state.settingsWritable) throw new Error('未注入作用域时不应可写')
  const r = await state.applySettingsPatch({ scope: 'system' })
  if (r.ok !== false) throw new Error('应拒绝，实际 ' + JSON.stringify(r))
  if (!/作用域不可用/.test(r.error || '')) throw new Error('错误信息应说明原因: ' + r.error)
})

await test('⭐ 白名单拒绝凭据类与未知字段', async () => {
  const state = new State(Config({ diskCache: false }), { cwd: ROOT })
  const applied = []
  state.setSettingsScope({ update: (p) => { applied.push(p); return Promise.resolve() } })

  for (const bad of [{ githubToken: 'x' }, { scope: 'system', evil: 1 }, { __proto__: { a: 1 } }]) {
    const r = await state.applySettingsPatch(bad)
    if (r.ok !== false) throw new Error('应拒绝 ' + JSON.stringify(bad) + '，实际 ' + JSON.stringify(r))
  }
  if (applied.length !== 0) throw new Error('被拒的补丁不应传到 settings 服务')
  if (!state.settingsWritable) throw new Error('注入后应为可写')
})

await test('空补丁被拒（避免无意义写入）', async () => {
  const state = new State(Config({ diskCache: false }), { cwd: ROOT })
  state.setSettingsScope({ update: () => Promise.resolve() })
  const r = await state.applySettingsPatch({})
  if (r.ok !== false) throw new Error('应拒绝空补丁')
})

await test('⭐ 合法补丁透传给 settings 服务（只含白名单字段）', async () => {
  const state = new State(Config({ diskCache: false }), { cwd: ROOT })
  let got = null
  state.setSettingsScope({ update: (p) => { got = p; return Promise.resolve() } })
  const r = await state.applySettingsPatch({ scope: 'system', requestTimeoutMs: 20000 })
  if (r.ok !== true) throw new Error('应成功，实际 ' + JSON.stringify(r))
  if (!got || got.scope !== 'system' || got.requestTimeoutMs !== 20000) {
    throw new Error('透传内容不对: ' + JSON.stringify(got))
  }
})

await test('settings 服务抛错时原样回传（不吞）', async () => {
  const state = new State(Config({ diskCache: false }), { cwd: ROOT })
  state.setSettingsScope({ update: () => Promise.reject(new Error('schema 校验失败: scope 非法')) })
  const r = await state.applySettingsPatch({ scope: 'nonsense' })
  if (r.ok !== false) throw new Error('应失败')
  if (!/schema 校验失败/.test(r.error || '')) throw new Error('应回传原始错误: ' + r.error)
})

await test('字段描述表与白名单一致（单一事实来源）', () => {
  const keys = SETTINGS_FIELDS.map((f) => f.key)
  if (keys.length === 0) throw new Error('字段表为空')
  if (keys.includes('githubToken')) throw new Error('凭据字段不应出现在可编辑字段表里')
  for (const k of keys) {
    if (!WRITABLE_SETTING_KEYS.has(k)) throw new Error('字段 ' + k + ' 不在白名单里')
  }
  if (WRITABLE_SETTING_KEYS.size !== keys.length) throw new Error('白名单与字段表数量不一致')
  // 每个字段都要有合法 type
  for (const f of SETTINGS_FIELDS) {
    if (!['select', 'number', 'boolean', 'text'].includes(f.type)) {
      throw new Error('字段 ' + f.key + ' 的 type 非法: ' + f.type)
    }
    if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
      throw new Error('select 字段 ' + f.key + ' 缺 options')
    }
  }
})

await test('⭐ 改配置按影响面失效：改扫描深度不清 registry 缓存', async () => {
  const root = tempCacheDir()
  try {
    const st = new State(Config({ diskCacheDir: root }), { cwd: ROOT })
    // 预置 registry 缓存（内存 + 磁盘）
    st.registryClient.cacheSet('pkg:__probe__', { name: '__probe__' }, 60_000)
    if (st.registryClient.cacheSize() === 0) throw new Error('前置条件失败')

    // 改一个与 registry 缓存无关的设置
    st.updateConfig(Config({ diskCacheDir: root, projectScanDepth: 5 }))
    if (st.registryClient.cacheSize() === 0) {
      throw new Error('改 projectScanDepth 不应清 registry 缓存（否则要重新拉 200+ 个包）')
    }
    // 结果缓存与项目缓存仍应作废
    if (st.listCacheSize() !== 0) throw new Error('结果缓存应作废')

    // 改一个确实影响 registry 缓存的设置 → 应清
    st.registryClient.cacheSet('pkg:__probe2__', { name: '__probe2__' }, 60_000)
    st.updateConfig(Config({ diskCacheDir: root, projectScanDepth: 5, registryCacheTtlMs: 12345 }))
    if (st.registryClient.cacheSize() !== 0) {
      throw new Error('改 registryCacheTtlMs 应清 registry 缓存')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('显式 invalidate() 仍然清全部缓存（「刷新缓存」的语义）', async () => {
  const root = tempCacheDir()
  try {
    const st = new State(Config({ diskCacheDir: root }), { cwd: ROOT })
    st.registryClient.cacheSet('pkg:__probe__', { name: '__probe__' }, 60_000)
    await st.listPackages('project', 'C:/definitely/not/here')
    st.invalidate()
    if (st.registryClient.cacheSize() !== 0) throw new Error('registry 缓存未清')
    if (st.listCacheSize() !== 0) throw new Error('结果缓存未清')
    if (st.registryClient.diskCacheSize() !== 0) throw new Error('磁盘缓存未清')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

console.log('\n=== 层 9: changelog（GitHub Releases → CHANGELOG.md → none）===\n')

const { parseGitHubSlug, parseMarkdownChangelog } = registry

await test('parseGitHubSlug 覆盖 npm 上的各种 repository 写法', () => {
  const ok = [
    ['git+https://github.com/npm/node-semver.git', 'npm/node-semver'],
    ['https://github.com/expressjs/express', 'expressjs/express'],
    ['git://github.com/lodash/lodash.git', 'lodash/lodash'],
    ['github:isaacs/rimraf', 'isaacs/rimraf'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
    ['git+https://github.com/o/r.git#main', 'o/r'],
  ]
  for (const [inp, want] of ok) {
    const got = parseGitHubSlug(inp)
    if (!got || got.owner + '/' + got.repo !== want) {
      throw new Error(JSON.stringify(inp) + ' → ' + JSON.stringify(got) + '，期望 ' + want)
    }
  }
  for (const bad of ['https://gitlab.com/foo/bar', '', undefined, 'not a url', 'https://github.com/onlyowner']) {
    if (parseGitHubSlug(bad) !== null) {
      throw new Error(JSON.stringify(bad) + ' 应解析为 null，实际 ' + JSON.stringify(parseGitHubSlug(bad)))
    }
  }
})

await test('parseMarkdownChangelog 识别常见标题写法', () => {
  const md = [
    '# Changelog', '',
    '## Unreleased', '- wip', '',
    '## 1.2.3', '- fix a', '### Fixed', '- fix b', '',
    '## [1.2.2] - 2024-01-15', '- fix c', '',
    '## Migration guide', '- read this', '',
    '## v1.2.1 (2024-01-01)', '- fix d',
  ].join('\n')
  const secs = parseMarkdownChangelog(md)
  if (secs.length !== 3) throw new Error('应 3 段，实际 ' + secs.length + ': ' + JSON.stringify(secs.map((s) => s.version)))
  if (secs[0].version !== '1.2.3') throw new Error('首段版本不对: ' + secs[0].version)
  if (!secs[0].notes.includes('### Fixed')) throw new Error('三级标题应保留在段内')
  if (secs[1].date !== '2024-01-15') throw new Error('日期未解析: ' + JSON.stringify(secs[1]))
  if (secs[2].version !== '1.2.1') throw new Error('第三段版本不对: ' + secs[2].version)
  for (const s of secs) {
    if (s.source !== 'changelog-md') throw new Error('source 应为 changelog-md')
    if (/Unreleased|Migration guide/.test(s.notes)) throw new Error('非版本二级标题不应混入段内容: ' + s.notes)
  }
})

await test('parseMarkdownChangelog 尊重 limit 且不崩于空输入', () => {
  const md = Array.from({ length: 20 }, (_, i) => '## 1.0.' + i + '\n- x').join('\n')
  if (parseMarkdownChangelog(md, 3).length !== 3) throw new Error('limit 未生效')
  if (parseMarkdownChangelog('').length !== 0) throw new Error('空输入应返回空数组')
  if (parseMarkdownChangelog(null).length !== 0) throw new Error('null 不应抛错')
})

await test('⭐ getChangelog 优先走 GitHub Releases', async () => {
  const orig = globalThis.fetch
  try {
    globalThis.fetch = (url) => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve([
        { tag_name: 'v2.0.0', published_at: '2024-03-01T10:00:00Z', body: 'big release' },
        { tag_name: 'v1.9.0', published_at: '2024-01-01T00:00:00Z', body: 'small' },
      ]),
      text: () => Promise.resolve(''),
    })
    const c = new RegistryClient({})
    const cl = await c.getChangelog('demo', 'git+https://github.com/o/r.git')
    if (cl.length !== 2) throw new Error('应 2 段，实际 ' + cl.length)
    if (cl[0].version !== '2.0.0') throw new Error('v 前缀应被去掉: ' + cl[0].version)
    if (cl[0].date !== '2024-03-01') throw new Error('日期应取前 10 位: ' + cl[0].date)
    if (cl[0].source !== 'github-releases') throw new Error('source 不对')
  } finally {
    globalThis.fetch = orig
  }
})

await test('⭐ Releases 失败时降级到 CHANGELOG.md', async () => {
  const orig = globalThis.fetch
  try {
    globalThis.fetch = (url) => {
      if (String(url).includes('api.github.com')) {
        return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}), text: () => Promise.resolve('') })
      }
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve('## 3.1.0\n- md path\n## 3.0.0\n- older'),
        json: () => Promise.resolve({}),
      })
    }
    const c = new RegistryClient({})
    const cl = await c.getChangelog('demo', 'https://github.com/o/r')
    if (cl.length !== 2) throw new Error('应 2 段，实际 ' + cl.length)
    if (cl[0].source !== 'changelog-md') throw new Error('source 应为 changelog-md: ' + cl[0].source)
    if (cl[0].version !== '3.1.0') throw new Error('版本不对: ' + cl[0].version)
  } finally {
    globalThis.fetch = orig
  }
})

await test('⭐ 两条路都失败时给 source:none 占位（而不是空数组）', async () => {
  const orig = globalThis.fetch
  try {
    globalThis.fetch = () => Promise.resolve({
      ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve(''),
    })
    const c = new RegistryClient({})
    const cl = await c.getChangelog('demo', 'https://github.com/o/r')
    if (cl.length !== 1) throw new Error('应 1 条占位，实际 ' + cl.length)
    if (cl[0].source !== 'none') throw new Error('source 应为 none')
    if (typeof cl[0].notes !== 'string' || cl[0].notes === '') throw new Error('占位应带说明文字')
  } finally {
    globalThis.fetch = orig
  }
})

await test('非 GitHub 仓库直接给 none 占位（不发请求）', async () => {
  const orig = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = () => { calls++; return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') }) }
    const c = new RegistryClient({})
    const cl = await c.getChangelog('demo', 'https://gitlab.com/o/r')
    if (calls !== 0) throw new Error('非 GitHub 仓库不应发请求，实际 ' + calls)
    if (cl[0].source !== 'none') throw new Error('source 应为 none')
  } finally {
    globalThis.fetch = orig
  }
})

await test('changelog 结果被缓存（第二次不再请求）', async () => {
  const orig = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = () => {
      calls++
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve([{ tag_name: 'v1.0.0', body: 'x' }]),
        text: () => Promise.resolve(''),
      })
    }
    const c = new RegistryClient({})
    await c.getChangelog('demo', 'https://github.com/o/r')
    await c.getChangelog('demo', 'https://github.com/o/r')
    if (calls !== 1) throw new Error('应只请求 1 次，实际 ' + calls)
  } finally {
    globalThis.fetch = orig
  }
})

await test('⭐ 改 diskCache 开关热生效（不用重启）', () => {
  const rootA = tempCacheDir()
  try {
    const st = new State(Config({ diskCache: false, diskCacheDir: rootA }), { cwd: ROOT })
    if (st.diskCache !== null) throw new Error('前置条件：应禁用')

    st.updateConfig(Config({ diskCache: true, diskCacheDir: rootA }))
    if (st.diskCache === null) throw new Error('打开 diskCache 后应立刻有磁盘缓存（无需重启）')
    if (st.registryClient.diskCacheSize() !== 0) throw new Error('新块应为空')

    st.updateConfig(Config({ diskCache: false, diskCacheDir: rootA }))
    if (st.diskCache !== null) throw new Error('关掉后应立刻置空')
  } finally {
    rmSync(rootA, { recursive: true, force: true })
  }
})

await test('⭐ 改 diskCacheDir 热切换且旧块先落盘', () => {
  const rootA = tempCacheDir()
  const rootB = tempCacheDir()
  try {
    const st = new State(Config({ diskCacheDir: rootA }), { cwd: ROOT })
    st.registryClient.cacheSet('pkg:__probe__', { name: '__probe__' }, 60_000)
    if (st.registryClient.diskCacheSize() === 0) throw new Error('前置条件：应已写入旧块')

    st.updateConfig(Config({ diskCacheDir: rootB }))

    const pathA = st.diskCache.path.replace(/\\/g, '/')
    if (!pathA.startsWith(rootB.replace(/\\/g, '/') + '/cache/')) {
      throw new Error('切换后应指向新目录，实际 ' + pathA)
    }
    // 旧块在切换前被 flush 过 → 文件应已落盘（不丢数据）
    const oldFile = pathA.replace(rootB.replace(/\\/g, '/'), rootA.replace(/\\/g, '/'))
    if (!existsSync(oldFile)) {
      throw new Error('旧目录的缓存文件不存在 —— 说明切换时没先 flush，会丢待写内容')
    }
    // 旧目录**不应被删**（用户可能切回来）
    if (!existsSync(rootA)) throw new Error('旧目录被删了 —— 用户切回来时缓存就没了')
  } finally {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  }
})

await test('切到不可用目录时降级为纯内存缓存（不崩）', () => {
  const rootA = tempCacheDir()
  try {
    const st = new State(Config({ diskCacheDir: rootA }), { cwd: ROOT })
    // 指向一个不可能建成的路径（Windows 上文件名含非法字符）
    st.updateConfig(Config({ diskCacheDir: 'Z:\\definitely\\not\\writable\\\u0000bad' }))
    // 不崩即可；要么拿到一个（惰性建目录的）实例，要么为 null
    if (st.diskCache !== null) {
      st.diskCache.set('k', 'v', 1000)
      st.diskCache.flush() // 不应抛错
    }
  } finally {
    rmSync(rootA, { recursive: true, force: true })
  }
})

console.log('\n=== 层 10: 反向/降级断言 ===\n')

await test('RegistryClient 公开 API 完整(不崩)', () => {
  const client = new RegistryClient({})
  if (typeof client.getPackage !== 'function') throw new Error('getPackage 缺失')
  if (typeof client.getPackageMeta !== 'function') throw new Error('getPackageMeta 缺失')
  if (typeof client.batchGetPackageMeta !== 'function') throw new Error('batchGetPackageMeta 缺失')
  if (typeof client.clearCache !== 'function') throw new Error('clearCache 缺失')
  if (typeof client.flushDiskCache !== 'function') throw new Error('flushDiskCache 缺失')
})

await test('⭐ 请求挂起时必须超时中止并重试（否则整次扫描永久卡住）', async () => {
  const orig = globalThis.fetch
  let calls = 0
  try {
    // 模拟"网络半死"：连接建立但永不返回，只在被 abort 时拒绝
    globalThis.fetch = (_url, opts) => {
      calls++
      return new Promise((_resolve, reject) => {
        const sig = opts && opts.signal
        if (!sig) return // 没有 signal 就真的永远挂着（这正是要防的情况）
        if (sig.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        sig.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      })
    }
    const client = new RegistryClient({ requestTimeoutMs: 150 })
    const t0 = Date.now()
    let threw = null
    try { await client.getPackage('__hang__') } catch (e) { threw = e }
    const ms = Date.now() - t0

    if (threw === null) throw new Error('挂起请求应抛错而不是永远等待')
    if (calls !== 2) throw new Error('应重试 1 次（共 2 次请求），实际 ' + calls)
    if (ms > 3000) throw new Error('超时未生效，耗时 ' + ms + 'ms（应约 300ms）')
  } finally {
    globalThis.fetch = orig
  }
})

await test('⭐ 超时后该包被跳过，不阻塞其余包（流式扫描不会卡住）', async () => {
  const orig = globalThis.fetch
  try {
    let n = 0
    globalThis.fetch = (url, opts) => {
      n++
      // 第一个包永远挂起，其余正常返回
      if (String(url).includes('__hang__')) {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ name: 'ok-pkg', 'dist-tags': { latest: '1.0.0' }, description: '' }),
      })
    }
    const client = new RegistryClient({ requestTimeoutMs: 120 })
    const t0 = Date.now()
    const results = await Promise.all([
      client.getPackageMeta('__hang__', '1.0.0').catch(() => null),
      client.getPackageMeta('fine-a', '1.0.0'),
      client.getPackageMeta('fine-b', '1.0.0'),
    ])
    const ms = Date.now() - t0
    if (results[0] !== null) throw new Error('挂起的包应降级为 null')
    if (!results[1] || results[1].name !== 'ok-pkg') throw new Error('正常包应成功')
    if (!results[2] || results[2].name !== 'ok-pkg') throw new Error('正常包应成功')
    if (ms > 3000) throw new Error('正常包被挂起请求拖住了，耗时 ' + ms + 'ms')
  } finally {
    globalThis.fetch = orig
  }
})

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

console.log(`\n=== 共 ${pass} 通过 / ${fail} 失败 ===\n`)

// 清理测试用的 DSH_HOME
try { rmSync(TEST_DSH_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

process.exit(fail === 0 ? 0 : 1)
