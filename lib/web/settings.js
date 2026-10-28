/**
 * Settings 面板注册 — 0.2.1 契约
 *
 * ## 与 0.1.x 的差别（这次迁移的核心）
 *
 * | 0.1.x | 0.2.1 |
 * |---|---|
 * | `ctx.settings.register(ns, Config, {base})` | **已删除** |
 * | 返回 scope 对象，带 `.watch()` | **没有 scope，没有 watch** |
 * | `scope.update(patch)` | `settings.update(entryId, patch, revision)` |
 * | 命名空间自己起名 | **命名空间 = profile entry 的 id**（从 Config schema 派生） |
 * | 任何字段都能写 | **只有 `.volatile()` 字段能写** |
 *
 * 所以这里不再「注册命名空间」，而是：
 * 1. `configure({ auto: false }, ctx.fiber)` —— 声明本插件不用自动生成的表单页
 *    （我们有自己的 `settings.section` 页面）；
 * 2. 记住自己的 **entry id** 与 `revision`，作为写入通道交给 State；
 * 3. 写入走 `settings.update(ns, patch, revision)`。
 *
 * ⚠️ 关键降级：`settings` 服务可能不存在（老宿主或裁剪过的组合）。
 * 这时整个面板不注册，插件其余部分照常工作 —— 所以这段必须在
 * `ctx.inject(['settings'], ...)` 的**子作用域**里，而不是写进模块级 inject。
 */
/** 本插件在 profile 里的 entry id（`cordis.patch.yml` 里写的那个） */
const DEFAULT_ENTRY_ID = 'npm-manager';
/**
 * 从宿主拿到「自己这条 entry 的 id」。
 *
 * 0.2.1 的 settings 用 profile entry id 作命名空间，而不是插件自己起的名字。
 * `ctx.fiber.entry.options.id` 就是 loader 里那条 entry 的 id；取不到时
 * 退回 {@link DEFAULT_ENTRY_ID}（与 cordis.patch.yml 一致）。
 */
function resolveEntryId(ctx) {
    try {
        const id = ctx?.fiber?.entry?.options?.id;
        if (typeof id === 'string' && id !== '')
            return id;
    }
    catch {
        /* fiber.entry 在非 loader 场景下可能不存在 */
    }
    return DEFAULT_ENTRY_ID;
}
export function installSettingsPanel(ctx, state) {
    // 老宿主没有 settings 服务时，这个回调根本不会执行 —— 插件照常工作
    return ctx.inject(['settings'], (sctx) => {
        return sctx.effect(() => {
            const settings = sctx.settings;
            if (settings === null || settings === undefined)
                return;
            // 0.2.1 用 configure 声明「本插件自带页面」，而不是注册命名空间
            if (typeof settings.configure === 'function') {
                try {
                    settings.configure({ auto: false }, ctx.fiber);
                }
                catch {
                    // 重复 configure 会抛（同一 fiber 只能配置一次）；热重载时可能撞上，忽略即可
                }
            }
            const entryId = resolveEntryId(sctx);
            // 把「写入通道」交给 State：只暴露最小面，不把整个 settings 服务传出去
            state.setSettingsScope({
                update: async (patch) => {
                    // 0.2.1 的签名是 update(ns, patch, expectedRevision)
                    const revision = state.settingsRevision;
                    await settings.update(entryId, patch, revision);
                },
                get entryId() { return entryId; },
            });
            // 面板的字段清单来自 Config schema（`describe` 的投影），
            // 若宿主能 describe，就顺手把 revision 同步进来做乐观并发
            try {
                const rows = settings.describe();
                const row = Array.isArray(rows) ? rows.find((r) => r && r.ns === entryId) : undefined;
                if (row && typeof row.revision === 'number')
                    state.settingsRevision = row.revision;
            }
            catch {
                /* describe 失败不影响写入（revision 缺失时按 undefined 传，宿主自行判定） */
            }
            ctx.logger.info(`[npm-manager] settings wired (entry=${entryId})`);
            return () => {
                state.setSettingsScope(null);
            };
        }, 'npm-manager: settings panel');
    });
}
//# sourceMappingURL=settings.js.map