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
import { Config } from './config.js';
export declare const name = "npm-manager";
export declare const inject: string[];
export { Config };
export declare function apply(ctx: any, config: any): void;
//# sourceMappingURL=index.d.ts.map