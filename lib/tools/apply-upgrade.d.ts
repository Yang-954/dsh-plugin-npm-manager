/**
 * Tool #4: npm_apply_upgrade
 *
 * 高危 — 配合 §7 approval guard(用户事先批准才能跑)
 * + read-back package.json sha256 对比
 * + dryRun 默认 true(必须显式 dryRun:false 才执行)
 * stderr 经过 sanitize(不泄露 npm token / 凭据)
 *
 * ## 0.2.1 适配
 * - npm 调用改走 `services/npm-cli.ts`：Windows 用 `npm.cmd` + shell（裸 `spawn('npm')`
 *   在 Windows 必 ENOENT，实测两个升级工具 100% 不可用）
 * - `-g` 与包名**分开**传（旧版把 `-g` 塞进 packages 再拼 `@latest` → `-g@latest`）
 * - 包名过白名单（开了 shell 就必须校验，两者是成对的）
 */
export declare function registerApplyUpgradeTool(ctx: any, state: any): () => void;
//# sourceMappingURL=apply-upgrade.d.ts.map