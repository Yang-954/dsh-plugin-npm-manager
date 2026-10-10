// 沙箱测试 mock — schemastery
// 形态来自 @deepseek-ai/schemastery 3.18.2
// 够 §13 测试用,不模拟全部

export const z = {
  string: (def = {}) => ({ _kind: 'string', _def: def, _required: false, _default: undefined, default(v) { this._default = v; return this }, required() { this._required = true; return this }, optional() { return this } }),
  number: (def = {}) => ({ _kind: 'number', _def: def, default(v) { this._default = v; return this }, required() { this._required = true; return this }, optional() { return this } }),
  integer: () => ({ _kind: 'integer', default(v) { this._default = v; return this }, required() { return this }, optional() { return this } }),
  boolean: () => ({ _kind: 'boolean', default(v) { this._default = v; return this }, required() { return this }, optional() { return this } }),
  union: (vals) => ({ _kind: 'union', _vals: vals, default(v) { this._default = v; return this }, required() { return this }, optional() { return this } }),
  array: (def = {}) => ({ _kind: 'array', _def: def, default(v) { this._default = v; return this }, required() { return this }, optional() { return this } }),
  object: (shape) => ({
    _kind: 'object', _shape: shape, default(v) { this._default = v; return this },
    required() { return this },
    optional() { return this },
    parse(v) {
      if (!v || typeof v !== 'object') throw new Error('expected object')
      const out = {}
      for (const k of Object.keys(this._shape)) out[k] = this._shape[k].parse(v[k])
      return out
    }
  }),
  literal: (v) => ({ _kind: 'literal', _v: v, default() { return this }, required() { return this }, optional() { return this } }),
  natural: () => ({ _kind: 'natural', default(v) { this._default = v; return this }, required() { return this }, optional() { return this } }),
  oneOf: (vals) => ({ _kind: 'oneOf', _vals: vals, default(v) { this._default = v; return this }, required() { return this }, optional() { return this } }),
}

export default z
