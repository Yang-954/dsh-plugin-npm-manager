/**
 * 本地类型垫片 — 项目 node_modules 没有 @deepseek-ai/dsh-tools(宿主 profile 才有)
 * 运行时由 scripts/patch-src.mjs 重定向到宿主真包; 这里只给 tsc 编译用最小类型。
 */
declare module '@deepseek-ai/dsh-tools' {
  export interface ToolDefinition {
    name: string
    parameters: any
    output: { schema: any; render: (...args: any[]) => any }
  }
  export function defineTool(options: any): ToolDefinition
  export function validateJsonSchemaValue(schema: any, value: any, path?: string): any[]
  export function validateArgs(spec: any, args: any): any[]
}
