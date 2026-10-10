/**
 * npm_apply_upgrade 的执行前门禁（approval gate）
 *
 * ## ⚠️⚠️ 为什么不用 `ctx.tools.guard()`
 *
 * 这个模块原来是 `ctx.tools.guard(exec => string | undefined)` 写的，
 * 结果是**工具 100% 不可用、且用户无法批准**。两个原因：
 *
 * 1. **`tools.guard()` 只能拒绝、没有放行通道**。
 *    官方声明（dsh-tools/lib/index.js:2813）：
 *      `@param guard - synchronous check; a returned string denies the execution.`
 *    它是同步的、返回字符串即拒绝。审批门需要"先问用户、再决定"，用它做不到。
 *
 * 2. **`exec.agent.approvals` 根本不存在**。
 *    官方 `ToolExecution` 是
 *      `{callId, rootCallId, name, arguments, agent?, parent?, signal, token}`
 *    —— 没有 `approvals`。所以 `granted` 恒为 undefined → 永远拦。
 *
 * ## 正确做法：`tools/pre-execute` 瀑布事件
 *
 * 官方审批链（dsh-tools/lib/index.js:3116 与 :3314）：
 *
 * ```
 * gate = await ctx.waterfall(carrier, 'tools/pre-execute', exec, () => ({ kind: 'allow' }))
 * if (gate.kind === 'ask') → ctx.get('approval').request({...}) → 'allowed-once' 才放行
 * ```
 *
 * 事件签名（dsh-tool-cordis 的声明）：
 *
 * ```
 * 'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution,
 *                     next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
 * ```
 *
 * 可返回：`{ kind: 'allow' }` / `{ kind: 'deny', reason }` / `{ kind: 'ask', reason? }`，
 * 或 `next()`（等价于 allow）。
 *
 * 注意：**宿主没有组合 `approval` 服务时，`ask` 会降级为拒绝**（官方注释明说）。
 * 这是有意的安全默认 —— 缺审批通道时不放行，而不是静默放行。
 */
export declare function installApprovalGuard(ctx: any): () => void;
//# sourceMappingURL=guards.d.ts.map