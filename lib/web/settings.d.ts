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
import type { State } from '../services/state.js';
export declare function installSettingsPanel(ctx: any, state: State): () => void;
//# sourceMappingURL=settings.d.ts.map