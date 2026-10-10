// 沙箱测试 mock — 完整复刻 @deepseek-ai/cordis 4.0.2 我们用到的最小 API
// 形态来自: C:/Users/Admin/.dsh/profiles/web/node_modules/@deepseek-ai/cordis/lib/index.d.ts

export class Context {
  constructor() {
    this._tools = {
      register: () => () => {},
      list: () => [],
      guard: () => () => {},
    }
    this._effects = []
    this.logger = { info() {}, warn() {}, error() {}, debug() {} }
  }
  effect(fn) {
    const dispose = fn()
    this._effects.push(dispose)
    return () => { if (typeof dispose === 'function') dispose() }
  }
  on() { return () => {} }
  get(k) {
    if (k === 'tools') return this._tools
    if (k === 'webServer') return { register: () => () => {} }
    if (k === 'settings') return {
      register: () => ({ watch: () => {}, dispose: () => {} })
    }
    return undefined
  }
}

export const CordisError = class extends Object{}
export const ValidationError = class extends Object{}
export function Inject() { return () => {} }
export const Service = class { constructor(ctx, name) { this.ctx = ctx; this.name = name } }
