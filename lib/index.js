/**
 * dsh-plugin-npm-manager 4 件套 + apply
 *
 * 按 dsh-plugin-conformance §2:
 *   - export const name = 'npm-manager'
 *   - export const inject = ['tools', 'webServer', 'settings']  // 全是真服务名(§2 铁律 7)
 *   - export { Config } from 真包 Schema
 *   - export function apply(ctx, config): void
 *
 * apply 内部用 ctx.effect 统一管理生命周期(§10 热插拔回滚)
 */
import { Config } from './config.js';
import { State } from './services/state.js';
import { installApprovalGuard } from './services/guards.js';
import { registerListPackagesTool } from './tools/list-packages.js';
import { registerGetPackageInfoTool } from './tools/get-package-info.js';
import { registerPreviewUpgradeTool } from './tools/preview-upgrade.js';
import { registerApplyUpgradeTool } from './tools/apply-upgrade.js';
import { registerWebRoutes } from './web/routes.js';
import { installSettingsPanel } from './web/settings.js';
export const name = 'npm-manager';
export const inject = ['tools', 'webServer', 'settings'];
export { Config };
export function apply(ctx, config) {
    const state = new State(config, { cwd: process.cwd() });
    // ── 诊断探针（帮我们定位"全系统只剩当前项目"的真实原因） ──
    // A. 对照：对一个**确定存在**的服务做 inject —— 验证 inject 机制本身是否工作
    let injectControlFired = false;
    ctx.inject(['tools'], () => { injectControlFired = true; });
    // B. 目标服务
    let injectWorkspaceFired = false;
    // C. 调用时直接看 ctx 上有没有这个服务（绕过 inject）。
    // 一些宿主 ctx 上访问未注入服务会拒（`cannot get property X without inject`），
    // 包成 try/catch 把"会抛错"转成 `absent`，不要让诊断探针自己成为问题的来源。
    state.setServiceProbe(() => {
        try {
            const svc = ctx.workspaceRegistry;
            return svc === undefined || svc === null ? 'absent' : typeof svc;
        }
        catch {
            return 'restricted'; // 服务存在但未注入 —— 等 callback
        }
    });
    state.setInjectProbe(() => ({
        control: injectControlFired,
        workspace: injectWorkspaceFired,
    }));
    // DSH 工作区列表 —— 用 ctx.inject 作降级边界：
    // 没有该服务的宿主上回调不执行，插件照常工作（「全系统」范围退化为只有当前项目）。
    // ⚠️ 不要把它写进模块级 inject —— 那会让 entry 在缺该服务的宿主上永久 pending。
    ctx.inject(['workspaceRegistry'], (sctx) => {
        injectWorkspaceFired = true;
        state.setWorkspaceProvider(() => sctx.workspaceRegistry.list().map((w) => ({
            id: String(w.id),
            title: String(w.title ?? ''),
            path: String(w.path ?? ''),
        })));
    });
    ctx.effect(() => {
        // 4 件套之外的所有副作用:
        // 0. 高危工具 approval guard(§7)
        // 1. 4 个 tool
        // 2. 5 条 webServer 路由(§4)
        // 3. settings 面板(§5)
        const disposeGuard = installApprovalGuard(ctx);
        const disposeTools = [
            registerListPackagesTool(ctx, state),
            registerGetPackageInfoTool(ctx, state),
            registerPreviewUpgradeTool(ctx, state),
            registerApplyUpgradeTool(ctx, state),
        ];
        const disposeRoutes = registerWebRoutes(ctx, state);
        const disposeSettings = installSettingsPanel(ctx, state);
        ctx.logger.info('[npm-manager] loaded');
        return () => {
            disposeTools.forEach(d => d());
            disposeRoutes();
            disposeSettings();
            disposeGuard();
            ctx.logger.info('[npm-manager] disposed (hot-unplug ok)');
        };
    }, 'npm-manager: tools + web routes + settings panel');
}
//# sourceMappingURL=index.js.map