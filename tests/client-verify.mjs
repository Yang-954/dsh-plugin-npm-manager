/**
 * client-verify.mjs — 客户端产物的真实契约验证
 *
 * 覆盖三层（对应用户报的故障根因）：
 *   层 1 §11 铁律 9/10  —— factory 返回 module.exports；加载期无 console.*
 *   层 2 §17.1         —— 注册的必须是 **React 组件**，
 *                        调用后要返回 React 元素，不能是 { render: fn } 这类普通对象
 *   层 3 §17.0/§17.2   —— 模块 id 逐字等于包名；locale 是命名空间字符串
 *   层 4 §17.3         —— 注册到 settings.section，id/order/label 齐全（独立标签页契约）
 *
 * 为什么必须真调一次组件：
 *   早期版本只做 `content.includes('return module.exports')` 这类字符串检查，
 *   结果是全绿，而线上卡片一挂载就抛
 *   "Objects are not valid as a React child"。字符串包含测不到渲染契约。
 *
 * mock 边界说明（§13.1）：react / fetch / document 属于**宿主 API 边界**，用 mock 合理；
 * 被测对象本身（client.js 的真实产物）是原样加载并真实执行的。
 */

import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CLIENT = join(ROOT, 'client', 'client.js')
const PKG_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
const NS = 'npm-manager'

let pass = 0, fail = 0

/** 同步断言器：显式拒绝 async 回调，避免断言失败变成 unhandled rejection（静默漏测）。 */
function check(label, fn) {
  let r
  try {
    r = fn()
  } catch (e) {
    console.log('  \u274c ' + label + ': ' + ((e && e.message) ? e.message : String(e)))
    fail++
    return
  }
  if (r !== undefined && typeof r.then === 'function') {
    console.log('  \u274c ' + label + ': check() 的回调不能是 async —— 请把 await 移到 check() 之外')
    fail++
    return
  }
  console.log('  \u2705 ' + label)
  pass++
}

/* ─────────────── 加载产物（真实执行，不 mock 被测对象） ─────────────── */

const content = readFileSync(CLIENT, 'utf8')

/** 去掉注释后的源码：静态检查要避免被文档里提到的字面量误伤。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 组件依赖的 SSE 流式响应 —— 这里给不带 body.getReader() 的形态，走一次性降级解析路径 */
const SSE_PAYLOAD = [
  'data: ' + JSON.stringify({ type: 'meta', scope: 'project', total: 2, cached: false }),
  '',
  'data: ' + JSON.stringify({ type: 'pkg', package: { name: 'semver', currentVersion: '^7.6.0', latestVersion: '7.8.5', description: '', isOutdated: true, updateType: 'major' } }),
  '',
  'data: ' + JSON.stringify({ type: 'done', totalCount: 1, outdatedCount: 1, cached: false, scannedAt: 1 }),
  '',
].join('\n')

function loadClient() {
  let spec = null
  // 浏览器里 fetch 是全局函数，vm 上下文必须显式提供，否则组件一渲染就 ReferenceError
  const fetchMock = (url) => Promise.resolve({
    ok: true,
    status: 200,
    // /projects 走 json()；/packages?stream=1 走 text()（降级路径）
    json: () => Promise.resolve({ projects: [], current: '' }),
    text: () => Promise.resolve(SSE_PAYLOAD),
  })
  const sandboxWindow = {
    __ModuleLoader__: { load: (s) => { spec = s } },
    fetch: fetchMock,
  }
  vm.runInNewContext(content, vm.createContext({ window: sandboxWindow, fetch: fetchMock }), { filename: 'client.js' })
  if (!spec) throw new Error('window.__ModuleLoader__.load 未被调用')
  return spec
}

/* ─────────────── 宿主 API 的 mock（react / fetch / document 边界） ─────────────── */

const REACT_ELEMENT = Symbol.for('react.element')

function makeReactMock() {
  return {
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props || {})
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { $$typeof: REACT_ELEMENT, type, props: merged }
    },
    // hooks：直接执行一次即可拿到同步渲染结果
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}] },
    useCallback(fn) { return fn },
    useEffect(fn) { return fn() },
    useRef(init) { return { current: init } },
  }
}

function makeRequire() {
  const react = makeReactMock()
  return (id) => {
    if (id === 'react') return react
    throw new Error('client.js 请求了未预期的模块: ' + id)
  }
}

/** 捕获 exports.apply 注册的 slot 条目。 */
function runApply(exportsObj) {
  const captured = { slots: [], locale: null, boundNs: null, injectedSlots: [] }

  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    locale: {
      register(ns, dicts) { captured.locale = { ns, dicts }; return () => {} },
      bind(ns) { captured.boundNs = ns; return (k) => k },
    },
    slots: {
      inject(name, cb) { captured.injectedSlots.push(name); cb() },
      register(def, component) { captured.slots.push({ def, component }); return () => {} },
    },
  }

  exportsObj.apply(ctx)
  return captured
}

console.log('=== 层 1: §11 铁律 9/10 ===\n')

const spec = loadClient()

check('client.js 调用 window.__ModuleLoader__.load 且带 factory', () => {
  if (typeof spec.factory !== 'function') throw new Error('spec.factory 不是函数')
})

check('⭐ 模块 id 逐字等于 package.json 的 name（' + PKG_NAME + '）', () => {
  if (spec.id !== PKG_NAME) {
    throw new Error('spec.id = ' + JSON.stringify(spec.id) + '，应为 ' + JSON.stringify(PKG_NAME) +
      ' —— 对不上时 client-modules 会抛 "bundle ... loaded without registering"')
  }
})

check('factory 返回 module.exports（铁律 9）', () => {
  const ex = spec.factory(makeRequire())
  if (!ex) throw new Error('factory 返回 undefined')
  if (typeof ex.apply !== 'function') throw new Error('exports.apply 不是函数')
  if (typeof ex.name !== 'string') throw new Error('exports.name 缺失')
  if (!Array.isArray(ex.inject)) throw new Error('exports.inject 缺失')
})

check('产物加载期无 console.* 污染 stdout（铁律 10）', () => {
  const m = stripComments(content).match(/console\.(log|warn|error|info|debug)\s*\(/g)
  if (m) throw new Error('发现 ' + m.length + ' 处 console.*')
})

console.log('\n=== 层 2: §17.1 组件必须是 React 组件 ===\n')

const exportsObj = spec.factory(makeRequire())
const captured = runApply(exportsObj)

check('apply 注册了恰好 1 个 settings.section 条目', () => {
  if (captured.slots.length !== 1) throw new Error('实际 ' + captured.slots.length + ' 个')
  if (captured.slots[0].def.name !== 'settings.section') throw new Error('slot 名不对: ' + captured.slots[0].def.name)
})

check('注册的第二个参数是函数（组件）', () => {
  const c = captured.slots[0].component
  if (typeof c !== 'function') throw new Error('实际类型 ' + typeof c)
})

check('⭐ 组件调用后返回 React 元素，而不是 { render } 对象', () => {
  const c = captured.slots[0].component
  const out = c({ t: (k) => k })
  if (out === null || out === undefined) throw new Error('组件返回了空值')
  if (typeof out !== 'object') throw new Error('返回类型 ' + typeof out + '，不是元素')
  if (out.$$typeof !== REACT_ELEMENT) throw new Error('返回值不是 React 元素（缺 $$typeof）—— 这正是 "Objects are not valid as a React child" 的成因')
  if (Object.prototype.hasOwnProperty.call(out, 'render')) throw new Error('返回值是 { render } 形状的普通对象')
})

check('组件不依赖 slot kit 里不存在的 target / dom prop', () => {
  if (/props\.target|props\.dom\b|host\.dom/.test(stripComments(content))) throw new Error('仍在读取 target / dom prop')
})

check('组件根元素带稳定选择器 data-plugin（便于端到端验证）', () => {
  const out = captured.slots[0].component({ t: (k) => k })
  const attrs = (out && out.props) || {}
  if (attrs['data-plugin'] !== NS) throw new Error('根元素缺 data-plugin="' + NS + '"')
})

/* ── 加载态 / 空态：用户明确反馈过的问题 ── */

/** 把 React 元素树里的文本节点收集成数组（精确匹配，避免 'empty' 命中 'emptyFiltered'） */
function collectText(node, out) {
  out = out || []
  if (node === null || node === undefined || node === true || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) collectText(c, out); return out }
  if (typeof node === 'object' && node.props) collectText(node.props.children, out)
  return out
}

/** 收集元素树里所有 className 的 token */
function collectClasses(node, out) {
  out = out || []
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const c of node) collectClasses(c, out); return out }
  const cn = node.props && node.props.className
  if (typeof cn === 'string') for (const c of cn.split(/\s+/)) if (c) out.push(c)
  if (node.props) collectClasses(node.props.children, out)
  return out
}

console.log('\n=== 层 2.5: 加载态与空态（用户反馈过的观感问题）===\n')

check('⭐ 首次渲染（尚未收到任何包）显示加载态，绝不显示空态文案', () => {
  const out = captured.slots[0].component({ t: (k) => k })
  const tokens = collectText(out)
  if (tokens.includes('empty')) {
    throw new Error('加载中出现了空态文案 —— 用户会以为"扫描完了且没有结果"（这正是原始反馈）')
  }
  if (!tokens.includes('scanning')) {
    throw new Error('应显示 scanning 加载态，实际文本: ' + JSON.stringify(tokens.slice(0, 24)))
  }
})

check('⭐ 加载态带旋转动画与进度条（不是静止文本）', () => {
  const out = captured.slots[0].component({ t: (k) => k })
  const classes = collectClasses(out)
  if (!classes.includes('npmgr-spin')) throw new Error('缺旋转指示器 .npmgr-spin')
  if (!classes.includes('npmgr-track')) throw new Error('缺进度条 .npmgr-track')
})

check('⭐ 空态文案只在 status==="ready" 分支出现（源码级断言）', () => {
  const code = stripComments(content)
  // 空态必须被 `view.status === 'ready' && !hasRows` 守卫
  if (!/view\.status === 'ready' && !hasRows/.test(code)) {
    throw new Error("未找到 \"view.status === 'ready' && !hasRows\" 守卫 —— 空态可能又会在加载中显示")
  }
  const emptyIdx = code.indexOf("emptyState(t)")
  if (emptyIdx < 0) throw new Error('未找到 emptyState 调用')
})

check('加载中清空上一批行（避免"看到旧数据以为已加载完"）', () => {
  const code = stripComments(content)
  if (!/status: 'loading', packages: \[\]/.test(code)) {
    throw new Error('切换到 loading 时没有清空 packages —— 会残留上一批行')
  }
})

check('刷新按钮的忙碌态要等扫描真正结束才收回', () => {
  const code = stripComments(content)
  // refresh() 里不应在 load(true) 之前 setBusy(false)
  const refreshBlock = code.slice(code.indexOf('var refresh = react.useCallback'))
  const head = refreshBlock.slice(0, refreshBlock.indexOf('}, [load])'))
  if (/setBusy\(false\)[\s\S]*load\(true/.test(head)) {
    throw new Error('refresh() 在 load(true) 之前就 setBusy(false) —— 重扫期间界面会毫无指示')
  }
  if (!/load\(true, function \(\) \{ setBusy\(false\) \}\)/.test(head)) {
    throw new Error('refresh() 应把 setBusy(false) 作为 load 的完成回调')
  }
})

console.log('\n=== 层 3: §17.0 / §17.2 命名空间契约 ===\n')

check('locale 是字符串（不是字典对象）', () => {
  const l = captured.slots[0].def.locale
  if (typeof l !== 'string') throw new Error('locale 类型 ' + typeof l + ' —— 渲染器会把它当命名空间用，传对象会导致界面显示裸 key')
  if (l !== NS) throw new Error('locale = ' + l)
})

check('字典通过 ctx.locale.register(命名空间, {zh, en}) 单独注册', () => {
  if (!captured.locale) throw new Error('未调用 ctx.locale.register')
  if (captured.locale.ns !== NS) throw new Error('注册的命名空间 = ' + captured.locale.ns)
  const d = captured.locale.dicts
  if (!d || !d.zh || !d.en) throw new Error('缺少 zh / en 字典')
  if (typeof d.zh.title !== 'string') throw new Error('zh 字典缺 title')
  if (typeof d.zh.nav !== 'string') throw new Error('zh 字典缺 nav（导航项标签要用）')
})

check('label 用绑定到命名空间的 t（可随语言切换）', () => {
  if (captured.boundNs !== NS) throw new Error('ctx.locale.bind 的命名空间 = ' + captured.boundNs)
})

console.log('\n=== 层 4: §17.3 独立标签页（settings.section）契约 ===\n')

check('注册进的是 settings.section 槽位（不是 settings.plugin.item 卡片）', () => {
  if (!captured.injectedSlots.includes('settings.section')) {
    throw new Error('注入的槽位 = ' + JSON.stringify(captured.injectedSlots))
  }
  if (captured.injectedSlots.includes('settings.plugin.item')) {
    throw new Error('不应再注册 settings.plugin.item 卡片')
  }
})

check('条目 id 是命名空间字符串', () => {
  const id = captured.slots[0].def.id
  if (typeof id !== 'string' || id !== NS) throw new Error('id = ' + JSON.stringify(id))
})

check('order 是数字（决定导航项排序）', () => {
  const o = captured.slots[0].def.order
  if (typeof o !== 'number' || !Number.isFinite(o)) throw new Error('order = ' + JSON.stringify(o))
})

check('label 是函数且返回非空字符串', () => {
  const l = captured.slots[0].def.label
  if (typeof l !== 'function') throw new Error('label 类型 ' + typeof l + '（需要函数才能随语言切换）')
  const v = l()
  if (typeof v !== 'string' || v.length === 0) throw new Error('label() 返回 ' + JSON.stringify(v))
})

check('模块级 inject 只声明真实存在的服务名', () => {
  for (const s of exportsObj.inject) {
    if (s.startsWith('@')) throw new Error('inject 里出现包名（应为服务名）: ' + s)
  }
  if (!exportsObj.inject.includes('slots')) throw new Error('缺 slots')
})

console.log('\n=== 共 ' + pass + ' 通过 / ' + fail + ' 失败 ===\n')
process.exit(fail === 0 ? 0 : 1)
