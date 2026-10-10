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
export type Scope = 'project' | 'global' | 'system';
export interface InstalledPackage {
    name: string;
    currentVersion: string;
    isDev?: boolean;
    /** 所属项目显示名 —— 仅 system 范围填充 */
    project?: string;
    /** 所属项目绝对路径 —— 仅 system 范围填充 */
    projectPath?: string;
}
/** 一个待扫描的项目（来自 DSH 工作区注册表） */
export interface ProjectRef {
    id?: string;
    title: string;
    path: string;
}
/** 扫描指定目录的依赖（读它的 package.json，不递归 node_modules） */
export declare function scanLocalPackages(cwd: string, includeDev: boolean): InstalledPackage[];
/** 扫描一个项目并给每个包标注所属项目 */
export declare function scanProjectPackages(project: ProjectRef, includeDev: boolean): InstalledPackage[];
/**
 * npm 全局 node_modules 的候选路径，按优先级排列。
 *
 * ⚠️ 不能只认 `process.env.APPDATA` —— 实测存在 APPDATA 缺失的环境
 * （例如某些沙箱 shell 只有 LOCALAPPDATA / USERPROFILE / TEMP），
 * 那时旧实现会静默返回空列表。这里逐级兜底。
 */
export declare function globalNodeModulesCandidates(): string[];
/** 扫描全局 node_modules —— 第一个存在且非空的候选路径胜出 */
export declare function scanGlobalPackages(): InstalledPackage[];
export interface DiscoverOptions {
    /** 从 root 往下最多走几层（root 自身为 0 层）。默认 3。 */
    maxDepth?: number;
    /** 最多返回多少个项目，防止病态目录树。默认 200。 */
    limit?: number;
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
export declare function discoverNodeProjects(root: string, opts?: DiscoverOptions): string[];
export interface ScanOptions {
    /** project 范围的默认目录（dsh 进程 cwd） */
    cwd: string;
    /** project 范围显式指定的目录 */
    projectPath?: string;
    /** system 范围要扫的项目列表 */
    projects?: ProjectRef[];
}
/**
 * 按范围扫。
 *
 * ⚠️ system 范围**不按包名去重** —— 同一个包出现在多个项目里就应当出现多行，
 * 否则用户无法回答"这个包是哪个项目在用"。
 */
export declare function scanPackages(scope: Scope, includeDev: boolean, opts: ScanOptions): InstalledPackage[];
/** 把任意输入收敛成合法的 Scope（配置里可能是旧值）。 */
export declare function normalizeScope(value: unknown, fallback?: Scope): Scope;
/** 从路径推导项目显示名 */
export declare function projectTitleOf(path: string): string;
//# sourceMappingURL=scanner.d.ts.map