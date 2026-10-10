/**
 * Tool #4: npm_apply_upgrade
 *
 * 高危 — 配合 §7 approval guard(用户事先批准才能跑)
 * + read-back package.json sha256 对比
 * + dryRun 默认 true(必须显式 dryRun:false 才执行)
 * stderr 经过 sanitize(不泄露 npm token / 凭据)
 */
export declare function registerApplyUpgradeTool(ctx: any, state: any): () => void;
//# sourceMappingURL=apply-upgrade.d.ts.map