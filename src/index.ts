/**
 * dsh-plugin-npm-manager 4 件套 + apply
 *
 * 按 dsh-plugin-conformance §2:
 *   - export const name = 'npm-manager'
 *   - export const inject = ['tools', 'webServer', 'settings']  // 全是真服务名
 *   - export { Config } from 真包 Schema
 *   - export function apply(ctx, config): void
 *
 * ## 0.2.1 适配要点
 *
 * 1. **`config` 里标了 `.volatile()` 的字段是引用对象**（`{ get() }`），不是普通值。
 *    State 统一走 `cfg()` 解引用，绝不直接 `config.scope`。
 * 2. **settings 服务不再有 `register`**，面板改用 `configure/describe/update`，
 *    且必须在 `ctx.inject(['settings'], ...)` 子作用域里做（缺该服务时自动降级）。
 * 3. **清理链必须调用 `state.dispose()`** —— 否则磁盘缓存的 debounce 窗口
 *    （≤1.2s）内的最后一批写入会随插件卸载一起丢掉。
 */

import { Config } from './config.js'
import { State } from './services/state.js'
import { installApprovalGuard } from './services/guards.js'
import { registerListPackagesTool } from './tools/list-packages.js'
import { registerGetPackageInfoTool } from './tools/get-package-info.js'
import { registerPreviewUpgradeTool } from './tools/preview-upgrade.js'
import { registerApplyUpgradeTool } from './tools/apply-upgrade.js'
import { registerWebRoutes } from './web/routes.js'
import { installSettingsPanel } from './web/settings.js'

export const name = 'npm-manager'
export const inject = ['tools', 'webServer']
export { Config }

export function apply(ctx: any, config: any): void {
  const state = new State(config, { cwd: process.cwd() })

  // ── 诊断探针（帮我们定位"全系统只剩当前项目"的真实原因） ──
  // A. 对照：对一个**确定存在**的服务做 inject —— 验证 inject 机制本身是否工作
  let injectControlFired = false
  ctx.inject(['tools'], () => { injectControlFired = true })

  // B. 目标服务
  let injectWorkspaceFired = false

  // C. 调用时直接看 ctx 上有没有这个服务（绕过 inject）。
  // 一些宿主 ctx 上访问未注入服务会拒（`cannot get property X without inject`），
  // 包成 try/catch 把"会抛错"转成 `absent`，不要让诊断探针自己成为问题的来源。
  state.setServiceProbe(() => {
    try {
      const svc = ctx.workspaceRegistry
      return svc === undefined || svc === null ? 'absent' : typeof svc
    } catch {
      return 'restricted'  // 服务存在但未注入 —— 等 callback
    }
  })
  state.setInjectProbe(() => ({
    control: injectControlFired,
    workspace: injectWorkspaceFired,
  }))

  // DSH 工作区列表 —— 用 ctx.inject 作降级边界：
  // 没有该服务的宿主上回调不执行，插件照常工作（「全系统」范围退化为只有当前项目）。
  // ⚠️ 不要把它写进模块级 inject —— 那会让 entry 在缺该服务的宿主上永久 pending。
  // ⚠️ 必须用 effect 包住：热重载时要把 provider 还原，否则旧闭包会指向已销毁的 sctx。
  ctx.inject(['workspaceRegistry'], (sctx: any) => {
    return sctx.effect(() => {
      injectWorkspaceFired = true
      state.setWorkspaceProvider(() =>
        sctx.workspaceRegistry.list().map((w: any) => ({
          id: String(w.id),
          title: String(w.title ?? ''),
          path: String(w.path ?? ''),
        })),
      )
      return () => {
        state.setWorkspaceProvider(null)
      }
    }, 'npm-manager: workspace registry provider')
  })

  ctx.effect(() => {
    // 4 件套之外的所有副作用:
    // 0. 高危工具 approval guard(§7)
    // 1. 4 个 tool
    // 2. 6 条 webServer 路由(§4)
    // 3. settings 面板(§5)
    const disposeGuard = installApprovalGuard(ctx)
    const disposeTools = [
      registerListPackagesTool(ctx, state),
      registerGetPackageInfoTool(ctx, state),
      registerPreviewUpgradeTool(ctx, state),
      registerApplyUpgradeTool(ctx, state),
    ]
    const disposeRoutes = registerWebRoutes(ctx, state)
    const disposeSettings = installSettingsPanel(ctx, state)

    ctx.logger.info('[npm-manager] loaded')

    return () => {
      disposeTools.forEach(d => d())
      disposeRoutes()
      disposeSettings()
      disposeGuard()
      // ⚠️ 必须最后调：磁盘缓存还有 debounce 里没落盘的条目
      state.dispose()
      ctx.logger.info('[npm-manager] disposed (hot-unplug ok)')
    }
  }, 'npm-manager: tools + web routes + settings panel')
}
