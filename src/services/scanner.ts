/**
 * Package scanner — 扫 node_modules + 读 package.json 声明的依赖
 *
 * 不用 child_process spawn 真 npm（沙箱 EPERM 限制 + 无 npm 工具链）
 * 用 fs.readFileSync 读 package.json + 走全局目录遍历
 *
 * 三个范围（2026-09-19 起）：
 *   project —— 单个项目目录（默认 dsh 进程 cwd，可指定任意项目）
 *   global  —— npm 全局安装目录
 *   system  —— 所有已知项目（DSH 工作区），每个包标注所属项目
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

export type Scope = 'project' | 'global' | 'system'

export interface InstalledPackage {
  name: string
  currentVersion: string
  isDev?: boolean
  /** 所属项目显示名 —— 仅 system 范围填充 */
  project?: string
  /** 所属项目绝对路径 —— 仅 system 范围填充 */
  projectPath?: string
}

/** 一个待扫描的项目（来自 DSH 工作区注册表） */
export interface ProjectRef {
  id?: string
  title: string
  path: string
}

/* ─────────────────────────── project ─────────────────────────── */

/** 扫描指定目录的依赖（读它的 package.json，不递归 node_modules） */
export function scanLocalPackages(cwd: string, includeDev: boolean): InstalledPackage[] {
  const result: InstalledPackage[] = []

  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return result

  let pkg: any
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return result
  }

  const sections = includeDev
    ? ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    : ['dependencies', 'optionalDependencies', 'peerDependencies']

  for (const sec of sections) {
    const deps = pkg[sec] as Record<string, string> | undefined
    if (!deps) continue
    for (const [name, version] of Object.entries(deps)) {
      result.push({ name, currentVersion: String(version), isDev: sec === 'devDependencies' })
    }
  }

  return result
}

/** 扫描一个项目并给每个包标注所属项目 */
export function scanProjectPackages(project: ProjectRef, includeDev: boolean): InstalledPackage[] {
  return scanLocalPackages(project.path, includeDev).map((p) => ({
    ...p,
    project: project.title,
    projectPath: project.path,
  }))
}

/* ─────────────────────────── global ─────────────────────────── */

/** 读一个 node_modules 目录，**包含 scoped 包**（@scope/name 需再下一层）。 */
function readNodeModulesDir(dir: string): InstalledPackage[] {
  const out: InstalledPackage[] = []
  let items: string[]
  try {
    items = readdirSync(dir)
  } catch {
    return out
  }

  for (const item of items) {
    if (item.startsWith('.')) continue // .bin / .package-lock.json 等
    const itemPath = join(dir, item)

    if (item.startsWith('@')) {
      // scoped：目录名是 scope，真正的包在下一层
      let subs: string[]
      try {
        subs = readdirSync(itemPath)
      } catch {
        continue
      }
      for (const sub of subs) {
        if (sub.startsWith('.')) continue
        const p = readPackageAt(join(itemPath, sub))
        if (p) out.push(p)
      }
      continue
    }

    const p = readPackageAt(itemPath)
    if (p) out.push(p)
  }

  return out
}

function readPackageAt(dir: string): InstalledPackage | null {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg && pkg.name && pkg.version) {
      return { name: String(pkg.name), currentVersion: String(pkg.version) }
    }
  } catch {
    /* skip */
  }
  return null
}

/**
 * npm 全局 node_modules 的候选路径，按优先级排列。
 *
 * ⚠️ 不能只认 `process.env.APPDATA` —— 实测存在 APPDATA 缺失的环境
 * （例如某些沙箱 shell 只有 LOCALAPPDATA / USERPROFILE / TEMP），
 * 那时旧实现会静默返回空列表。这里逐级兜底。
 */
export function globalNodeModulesCandidates(): string[] {
  const out: string[] = []

  const prefix = process.env.NPM_CONFIG_PREFIX
  if (prefix) {
    out.push(join(prefix, 'lib', 'node_modules'))
    out.push(join(prefix, 'node_modules'))
  }

  const roaming =
    process.env.APPDATA ||
    (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Roaming') : '') ||
    (() => { try { return join(homedir(), 'AppData', 'Roaming') } catch { return '' } })()
  if (roaming) out.push(join(roaming, 'npm', 'node_modules'))

  out.push('/usr/local/lib/node_modules') // POSIX 兜底

  return [...new Set(out.filter(Boolean))]
}

/** 扫描全局 node_modules —— 第一个存在且非空的候选路径胜出 */
export function scanGlobalPackages(): InstalledPackage[] {
  for (const dir of globalNodeModulesCandidates()) {
    if (!existsSync(dir)) continue
    const found = readNodeModulesDir(dir)
    if (found.length > 0) return found
  }
  return []
}

/* ─────────────────────────── 项目发现 ─────────────────────────── */

/**
 * 发现子项目时要跳过的目录名。
 * 只放"确定不是独立 Node 项目"的：依赖目录、VCS、构建产物、虚拟环境、IDE 目录。
 * 刻意**不**按 `_` 前缀或 backup 之类启发式过滤 —— 那是猜测，不是事实。
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.bzr',
  'dist', 'build', 'out', 'output', 'release',
  'coverage', '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache',
  '.venv', 'venv', 'env', '__pycache__', 'target', 'vendor', 'Pods',
  '.idea', '.vscode', '.vs', 'tmp', 'temp',
])

export interface DiscoverOptions {
  /** 从 root 往下最多走几层（root 自身为 0 层）。默认 3。 */
  maxDepth?: number
  /** 最多返回多少个项目，防止病态目录树。默认 200。 */
  limit?: number
}

/**
 * 在 root 下发现所有含 package.json 的目录（含 root 自身）。
 *
 * 为什么需要：DSH 工作区往往是个"容器目录"，真正的 Node 项目在它下面
 * （例如 `web插件/dsh-manager`、`day05/TencentDB-Agent-Memory/MemoryCore`）。
 * 只扫工作区根目录会几乎什么都找不到。
 *
 * 跳过规则（都写在 SKIP_DIRS / 下面的判断里，不做隐藏启发式）：
 *   - `.` 开头（.git / .venv / .next …）
 *   - `_` 开头 —— 本机实测这些是备份目录（`_dsh-uninstalled-backup-*`、
 *     `_backup-redesign-*`）。扫"已卸载的备份"会报出并未在用的包，是误导。
 *   - SKIP_DIRS 里的依赖/构建/虚拟环境目录名
 *   ⚠️ 代价：名字以 `_` 开头的**真实**项目不会被发现，用「自定义路径」可绕过。
 *
 * ⚠️ 不跟随符号链接 —— 避免环。代价是符号链接指向的项目不会被发现。
 *
 * @returns 绝对路径数组，深度优先、父先于子。
 */
export function discoverNodeProjects(root: string, opts: DiscoverOptions = {}): string[] {
  const maxDepth = opts.maxDepth ?? 3
  const limit = opts.limit ?? 200
  const out: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit) return
    if (existsSync(join(dir, 'package.json'))) out.push(dir)
    if (depth >= maxDepth) return

    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= limit) return
      if (!e.isDirectory()) continue // 符号链接在这里返回 false → 天然不跟随
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue
      if (SKIP_DIRS.has(e.name)) continue
      walk(join(dir, e.name), depth + 1)
    }
  }

  if (existsSync(root)) walk(root, 0)
  return out
}

/* ─────────────────────────── 主入口 ─────────────────────────── */

export interface ScanOptions {
  /** project 范围的默认目录（dsh 进程 cwd） */
  cwd: string
  /** project 范围显式指定的目录 */
  projectPath?: string
  /** system 范围要扫的项目列表 */
  projects?: ProjectRef[]
}

/**
 * 按范围扫。
 *
 * ⚠️ system 范围**不按包名去重** —— 同一个包出现在多个项目里就应当出现多行，
 * 否则用户无法回答"这个包是哪个项目在用"。
 */
export function scanPackages(scope: Scope, includeDev: boolean, opts: ScanOptions): InstalledPackage[] {
  if (scope === 'project') {
    return scanLocalPackages(opts.projectPath ?? opts.cwd, includeDev)
  }
  if (scope === 'global') {
    return scanGlobalPackages()
  }

  // system：逐项目扫，每个包带上项目归属
  const out: InstalledPackage[] = []
  for (const project of opts.projects ?? []) {
    out.push(...scanProjectPackages(project, includeDev))
  }
  return out
}

/** 把任意输入收敛成合法的 Scope（配置里可能是旧值）。 */
export function normalizeScope(value: unknown, fallback: Scope = 'project'): Scope {
  if (value === 'project' || value === 'global' || value === 'system') return value
  return fallback
}

/** 从路径推导项目显示名 */
export function projectTitleOf(path: string): string {
  return basename(path.replace(/[\\/]+$/, '')) || path
}
