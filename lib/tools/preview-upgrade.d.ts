/**
 * Tool #3: npm_preview_upgrade
 *
 * 调用 `npm install --dry-run <pkg>@latest` 看会改什么
 * 不实际安装, 不修改 node_modules / package.json / package-lock.json
 * stderr 经过 sanitize(不泄露 token / 凭据)
 *
 * ## 0.2.1 适配
 * - npm 调用改走 `services/npm-cli.ts`（Windows 上裸 `spawn('npm')` 必 ENOENT）
 * - 包名过白名单（shell 与校验成对出现）
 * - **exit code 1 不再无条件当成功**：npm 的 dry-run 在「有改动」时返回 1，
 *   但网络错误/包不存在也常返回 1。现在要求 stdout 能解析出 JSON 才认，否则报错。
 */
export declare function registerPreviewUpgradeTool(ctx: any, state: any): () => void;
//# sourceMappingURL=preview-upgrade.d.ts.map