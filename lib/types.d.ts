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
export declare const Scope: {
    project: string;
    global: string;
    system: string;
};
/** @type {'project'|'global'|'system'} */
export declare const _ScopeType = "project";
/** 安装的包(project 范围时含 isDev；system 范围时带项目归属) */
export declare const InstalledPackage: {
    /** @type {string} */ name: string;
    /** @type {string} */ currentVersion: string;
    /** @type {boolean | undefined} */ isDev: undefined;
    /** @type {string | undefined} */ project: undefined;
    /** @type {string | undefined} */ projectPath: undefined;
};
/** npm registry 返回的元数据 */
export declare const PackageMeta: {
    /** @type {string} */ name: string;
    /** @type {string} */ latestVersion: string;
    /** @type {string} */ currentVersion: string;
    /** @type {string} */ description: string;
    /** @type {string | undefined} */ homepage: undefined;
    /** @type {string | undefined} */ repository: undefined;
    /** @type {boolean} */ isOutdated: boolean;
    /** @type {'major'|'minor'|'patch'|'same'|'downgrade'} */ updateType: string;
};
/** @type {'major'|'minor'|'patch'|'same'|'downgrade'} */
export declare const UpdateType = "same";
/** 列出包的输出 */
export declare const PackageListResult: {
    /** @type {} */ packages: never[];
    /** @type {number} */ totalCount: number;
    /** @type {number} */ outdatedCount: number;
    /** @type {'project'|'global'|'system'} */ scope: string;
    /** @type {number | undefined} */ projectCount: undefined;
    /** @type {} */ packageNames: never[];
};
/** 单包详情 */
export declare const PackageDetailResult: {
    /** @type {} */ changelog: never[];
    /** @type {string} */ name: string;
    /** @type {string} */ latestVersion: string;
    /** @type {string} */ currentVersion: string;
    /** @type {string} */ description: string;
    /** @type {string | undefined} */ homepage: undefined;
    /** @type {string | undefined} */ repository: undefined;
    /** @type {boolean} */ isOutdated: boolean;
    /** @type {'major'|'minor'|'patch'|'same'|'downgrade'} */ updateType: string;
};
/** changelog 段 */
export declare const ChangelogSection: {
    /** @type {string} */ version: string;
    /** @type {string | undefined} */ date: undefined;
    /** @type {string} */ notes: string;
    /** @type {'github-releases'|'changelog-md'|'none'} */ source: string;
};
/** 升级预览项 */
export declare const UpgradePreviewItem: {
    /** @type {string} */ name: string;
    /** @type {string} */ current: string;
    /** @type {string} */ target: string;
    /** @type {boolean} */ willChange: boolean;
    /** @type {} */ warnings: never[];
};
/** 升级预览 */
export declare const UpgradePreviewResult: {
    /** @type {} */ packages: never[];
    /** @type {number} */ totalWarnings: number;
    /** @type {true} */ dryRun: boolean;
};
/** 升级结果 */
export declare const UpgradeResult: {
    /** @type {boolean} */ success: boolean;
    /** @type {boolean} */ executed: boolean;
    /** @type {boolean} */ dryRun: boolean;
    /** @type {} */ packages: never[];
    /** @type {boolean} */ packageJsonChanged: boolean;
    /** @type {string | null} */ beforeHash: null;
    /** @type {string | null} */ afterHash: null;
    /** @type {string | undefined} */ message: undefined;
};
//# sourceMappingURL=types.d.ts.map