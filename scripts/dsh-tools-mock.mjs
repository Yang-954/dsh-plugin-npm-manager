// 沙箱测试用的 @deepseek-ai/dsh-tools mock
// 接口形态参考: C:/Users/Admin/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tools/lib/index.d.ts
// 但不导出全部(只够测试 defineTool 的 schema DSL 行为)

export const RUN_CODE_NAME = 'run_code'
export const TOOL_ABORTED = 'aborted'
export const TOOL_ABORTED_BEFORE_DISPATCH = 'aborted_before_dispatch'
export const TOOL_REGISTRY_SCHEDULER = 'tool/registry/scheduler'
export const ValidationError = class extends Object{}
export const JsonSchemaError = class extends Object{}
export const ToolArgsError = class extends Object{}
export const ToolNotFoundError = class extends Object{}
export const ToolOutputError = class extends Object{}
export const ToolRegistry = class {}
export const assertObjectJsonSchema = () => {}
export const assertSupportedJsonSchema = () => {}
export const renderToolsSdk = () => ''
export const renderToolsSdkPy = () => ''
export const jsonSchemaToPy = () => ({})
export const jsonSchemaToTs = () => ''
export const parameterSchemaSpecToJsonSchema = (s) => s
export const valueSchemaSpecToJsonSchema = (s) => s
export const validateJsonSchemaValue = () => []
export const validateArgs = () => []
export const defineContentToolFixture = () => ({})

/**
 * defineTool mock — 完整复刻宿主真实编译器的关键约束
 * 让沙箱测试能"§13 层 1-4" 在无宿主真包情况下跑通
 */
export function defineTool(options) {
  if (!options.name || typeof options.name !== 'string') {
    throw new TypeError('defineTool: name is required')
  }
  if (!options.description) {
    throw new TypeError('defineTool: description is required')
  }
  if (!options.parameters || typeof options.parameters !== 'object') {
    throw new TypeError('defineTool: parameters is required')
  }
  if (!options.output || typeof options.output !== 'object') {
    throw new TypeError(`defineTool("${options.name}") { schema, render, presentationMeta? }`)
  }
  if (typeof options.output.render !== 'function') {
    throw new TypeError(`defineTool("${options.name}"): output.render must be a function`)
  }
  // 模拟 host 的 schema 编译: 参数上的 required 必须是 boolean (不是数组)
  // 模拟 §5.1 关键字白名单校验
  for (const [key, def] of Object.entries(options.parameters)) {
    if (def && typeof def === 'object') {
      if ('required' in def && def.required !== true) {
        throw new Error(`schema.parameters.${key}.required must be exactly true`)
      }
      // 简化: object 节点必须有 additionalProperties 字面量
      if (def.type === 'object' && !('additionalProperties' in def)) {
        throw new Error(`schema.parameters.${key} (type object) must declare additionalProperties explicitly`)
      }
    }
  }
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: options.output,
    async execute(args, exec) { return await options.execute(args, exec) },
    timeoutMs: options.timeoutMs,
    finalizeContent: options.finalizeContent,
    presentCall: options.presentCall,
    presentResult: options.presentResult,
    isConcurrencySafe: options.isConcurrencySafe,
  }
}
