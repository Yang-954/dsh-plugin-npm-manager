/**
 * Tool #3: npm_preview_upgrade
 *
 * 调用 `npm install --dry-run <pkg>@latest` 看会改什么
 * 不实际安装, 不修改 node_modules / package.json / package-lock.json
 * stderr 经过 sanitize(不泄露 token / 凭据)
 */
export declare function registerPreviewUpgradeTool(ctx: any, state: any): () => void;
//# sourceMappingURL=preview-upgrade.d.ts.map