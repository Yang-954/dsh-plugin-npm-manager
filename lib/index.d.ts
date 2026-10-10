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
export declare const name = "npm-manager";
export declare const inject: string[];
export { Config };
export declare function apply(ctx: any, config: any): void;
//# sourceMappingURL=index.d.ts.map