/**
 * Tool #1: npm_list_packages
 *
 * defineTool 用真包 DSL(§5.1):
 * - parameters 是属性 map, 不是 { type: 'object', properties: ... }
 * - required 是属性节点上的布尔, 不是根数组
 * - additionalProperties 在 object 节点上必填字面量 false
 *
 * 三个范围与设置页一致：project(本项目) / global(全局) / system(全系统=所有已知项目)
 */
export declare function registerListPackagesTool(ctx: any, state: any): () => void;
//# sourceMappingURL=list-packages.d.ts.map