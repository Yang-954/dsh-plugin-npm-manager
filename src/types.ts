/**
 * 共享类型 — 给 services / tools / web 共用
 *
 * 沙箱 strip-types 兼容版: 所有 export 是 const + plain object (type-only 写在注释里)
 * 真包 dsh-tools 的 schema DSL 处理运行时类型; 这里只放运行时需要的最小形状
 *
 * ⚠️ 本文件目前**没有被任何活跃代码 import**（`src/services/scanner.ts` 自带 Scope 类型）。
 *    保留作为形状参考；改契约时请一并更新，避免误导。
 *    活跃契约的真源：src/services/scanner.ts（Scope / InstalledPackage）、
 *    src/services/state.ts（PackageListResult / ProjectInfo）、src/services/registry.ts（PackageMeta）。
 */

export const Scope = { project: 'project', global: 'global', system: 'system' }

/** @type {'project'|'global'|'system'} */
export const _ScopeType = 'project'

/** 安装的包(project 范围时含 isDev；system 范围时带项目归属) */
export const InstalledPackage = {
  /** @type {string} */ name: '',
  /** @type {string} */ currentVersion: '',
  /** @type {boolean | undefined} */ isDev: undefined,
  /** @type {string | undefined} */ project: undefined,
  /** @type {string | undefined} */ projectPath: undefined,
}

/** npm registry 返回的元数据 */
export const PackageMeta = {
  /** @type {string} */ name: '',
  /** @type {string} */ latestVersion: '',
  /** @type {string} */ currentVersion: '',
  /** @type {string} */ description: '',
  /** @type {string | undefined} */ homepage: undefined,
  /** @type {string | undefined} */ repository: undefined,
  /** @type {boolean} */ isOutdated: false,
  /** @type {'major'|'minor'|'patch'|'same'|'downgrade'} */ updateType: 'same',
}

/** @type {'major'|'minor'|'patch'|'same'|'downgrade'} */
export const UpdateType = 'same'

/** 列出包的输出 */
export const PackageListResult = {
  /** @type {} */ packages: [],
  /** @type {number} */ totalCount: 0,
  /** @type {number} */ outdatedCount: 0,
  /** @type {'project'|'global'|'system'} */ scope: 'project',
  /** @type {number | undefined} */ projectCount: undefined,
  /** @type {} */ packageNames: [],
}

/** 单包详情 */
export const PackageDetailResult = {
  ...PackageMeta,
  /** @type {} */ changelog: [],
}

/** changelog 段 */
export const ChangelogSection = {
  /** @type {string} */ version: '',
  /** @type {string | undefined} */ date: undefined,
  /** @type {string} */ notes: '',
  /** @type {'github-releases'|'changelog-md'|'none'} */ source: 'none',
}

/** 升级预览项 */
export const UpgradePreviewItem = {
  /** @type {string} */ name: '',
  /** @type {string} */ current: '',
  /** @type {string} */ target: '',
  /** @type {boolean} */ willChange: false,
  /** @type {} */ warnings: [],
}

/** 升级预览 */
export const UpgradePreviewResult = {
  /** @type {} */ packages: [],
  /** @type {number} */ totalWarnings: 0,
  /** @type {true} */ dryRun: true,
}

/** 升级结果 */
export const UpgradeResult = {
  /** @type {boolean} */ success: false,
  /** @type {boolean} */ executed: false,
  /** @type {boolean} */ dryRun: false,
  /** @type {} */ packages: [],
  /** @type {boolean} */ packageJsonChanged: false,
  /** @type {string | null} */ beforeHash: null,
  /** @type {string | null} */ afterHash: null,
  /** @type {string | undefined} */ message: undefined,
}
