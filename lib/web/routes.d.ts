/**
 * webServer 路由 — 给人看的 REST API + 给 client.js fetch 的端点
 *
 * 按 dsh-plugin-conformance §5.3 (kind, path) 唯一键:
 * 同 kind 同 path 重复注册会抛 duplicate route, 所以 (req.method) 在 handler 内分支
 *
 * ⚠️ §18: `kind: 'exact'` 的 path **不支持 `:param`** —— exact 表是字面量 Map 查找。
 *    带参数的资源必须用 `kind: 'prefix'` 并在 handler 里自己解析 pathname。
 *
 * 路由清单：
 *   GET  /plugins/npm-manager/projects                已知项目列表（DSH 工作区 + cwd）
 *   GET  /plugins/npm-manager/packages                包列表（scope=project|global|system）
 *                                                     `&stream=1` → SSE 逐条推送（渐进式渲染）
 *   GET  /plugins/npm-manager/packages/outdated       仅过期包          （exact，优先）
 *   GET  /plugins/npm-manager/packages/<name>         单包详情          （prefix，兜底）
 *   POST /plugins/npm-manager/refresh                 清缓存
 *   GET  /plugins/npm-manager/settings                当前配置
 */
import type { State } from '../services/state.js';
export declare function registerWebRoutes(ctx: any, state: State): () => void;
//# sourceMappingURL=routes.d.ts.map