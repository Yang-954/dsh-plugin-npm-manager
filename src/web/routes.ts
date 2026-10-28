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

import type { State } from '../services/state.js'
import { SETTINGS_FIELDS, redactConfigForClient } from '../config.js'

interface WebRes {
  statusCode: number
  setHeader(name: string, value: string): void
  /** 流式响应需要；真实的 Node http.ServerResponse 一定有 */
  write?(chunk: string): void
  flushHeaders?(): void
  end(body?: string): void
  headersSent?: boolean
}

interface WebReq {
  method: string
  url: string
  /** 真实 Node IncomingMessage 才有；用于读 body 与监听断连 */
  headers?: Record<string, string | string[] | undefined>
  on?(event: string, listener: () => void): void
  once?(event: string, listener: () => void): void
}

type Handler = (req: WebReq, res: WebRes) => Promise<void>

function sendJson(res: WebRes, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendError(res: WebRes, e: any): void {
  sendJson(res, 500, { error: (e && e.message) ? e.message : String(e) })
}

/**
 * 写接口的同源校验（CSRF 防护）。
 *
 * `dsh-host-webserver` 的 README 明确写着「**不提供** server-wide 认证或 origin 策略，
 * 由 route owner 自己负责」。我们的写接口（POST /settings、/refresh）因此必须自检：
 * 浏览器跨站请求会带 `Origin`/`Sec-Fetch-Site`，非 same-origin 一律拒绝。
 * 非浏览器客户端（curl / 测试）没有这两个头，放行 —— 它们本就不是 CSRF 的攻击面。
 */
function isSameOrigin(req: WebReq): boolean {
  const headers = req.headers ?? {}
  const pick = (name: string): string | undefined => {
    const v = headers[name] ?? headers[name.toLowerCase()]
    return Array.isArray(v) ? v[0] : v
  }
  const site = pick('sec-fetch-site')
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false

  const origin = pick('origin')
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const host = pick('host')
    if (typeof host === 'string' && host !== '') {
      try {
        if (new URL(origin).host !== host) return false
      } catch {
        return false
      }
    }
  }
  return true
}

/** 写接口必须是 JSON —— 跨站的 `text/plain` 表单提交因此被挡在门外 */
function isJsonContentType(req: WebReq): boolean {
  const headers = req.headers ?? {}
  const raw = headers['content-type'] ?? headers['Content-Type']
  const ct = Array.isArray(raw) ? raw[0] : raw
  if (typeof ct !== 'string' || ct === '') return false
  return ct.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** 从请求 URL 取查询参数 */
function queryOf(req: WebReq): URLSearchParams {
  return new URL(req.url ?? '/', 'http://x').searchParams
}

/**
 * 读请求体并解析 JSON。
 *
 * 真实宿主里 `req` 是 Node 的 `IncomingMessage`（可异步迭代）。
 * 单测的 fake req 不是流，所以额外支持 `req.body` 已预解析的形态 ——
 * ⚠️ 但预解析分支**也要受同一个体积上限约束**，否则它可以绕过 64KB 限制。
 */
async function readJsonBody(req: any, limitBytes = 64 * 1024): Promise<any> {
  if (req && typeof req.body === 'object' && req.body !== null && typeof req.body[Symbol.asyncIterator] !== 'function') {
    // 预解析形态（测试 / 某些框架）：先序列化量一下体积，再放行
    let size: number
    try {
      size = Buffer.byteLength(JSON.stringify(req.body), 'utf8')
    } catch {
      throw new Error('请求体不可序列化')
    }
    if (size > limitBytes) throw new Error(`请求体过大（> ${limitBytes} 字节）`)
    return req.body
  }
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {}
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buf.length
    if (size > limitBytes) throw new Error(`请求体过大（> ${limitBytes} 字节）`)
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/**
 * 把扫描结果**逐条**推给前端（SSE 帧格式）。
 *
 * 为什么用 `text/event-stream`：宿主的压缩中间件在 `createGzipMiddleware` 的
 * filter 里显式排除了这个 content-type（`dsh-host-webserver/lib/index.js:113`），
 * 所以即使 profile 开了 gzip 也不会把流缓冲到最后一并发送。
 *
 * 没有 `write()` 的响应对象（例如单测里的 fake res）退化为一次性输出，行为等价。
 */
async function streamPackagesTo(req: WebReq, res: WebRes, state: State, scope?: string, project?: string): Promise<void> {
  const canStream = typeof res.write === 'function'

  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 反向代理不要缓冲
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  /**
   * 客户端断连信号。
   *
   * 浏览器关标签/切页时 `req` 会 emit 'close'。不监听它的话，16 个 worker
   * 会把 220+ 个 registry 请求全部跑完 —— 白烧几十秒和几百次网络请求。
   */
  let aborted = false
  const onClose = () => { aborted = true }
  try {
    req.once?.('close', onClose)
    req.on?.('aborted', onClose)
  } catch {
    /* 老 req 没有事件接口时退化为不取消 */
  }

  let buffered = ''
  const emit = (payload: unknown) => {
    if (aborted) return
    const frame = 'data: ' + JSON.stringify(payload) + '\n\n'
    if (canStream) {
      try { res.write!(frame) } catch { aborted = true }
    } else buffered += frame
  }

  try {
    for await (const event of state.streamPackages(scope, project)) {
      if (aborted) break
      emit(event)
    }
  } catch (e: any) {
    emit({ type: 'error', error: (e && e.message) ? e.message : String(e) })
  } finally {
    try {
      req.once?.('close', onClose)
    } catch { /* ignore */ }
    // 真实 IncomingMessage 用 removeListener；没有就跳过
    try { (req as any).removeListener?.('close', onClose); (req as any).removeListener?.('aborted', onClose) } catch { /* ignore */ }
  }
  if (!aborted) res.end(canStream ? undefined : buffered)
  else res.end()
}

export function registerWebRoutes(ctx: any, state: State): () => void {
  return ctx.effect(() => {
    const disposers: Array<() => void> = []

    // ── 路由 #1: 已知项目列表（「本项目」下拉 + 「全系统」筛选用） ──────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/projects',
      handler: (async (_req: WebReq, res: WebRes) => {
        try {
          sendJson(res, 200, {
            projects: state.listProjects(),
            current: state.cwd,
          })
        } catch (e: any) {
          sendError(res, e)
        }
      }) as Handler,
    }))

    // ── 路由 #2: 包列表（stream=1 时逐条推，否则一次性 JSON） ────────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/packages',
      handler: (async (req: WebReq, res: WebRes) => {
        try {
          const q = queryOf(req)
          const scope = q.get('scope') ?? undefined
          const project = q.get('project') ?? undefined
          if (q.get('stream') === '1') {
            await streamPackagesTo(req, res, state, scope, project)
            return
          }
          const data = await state.listPackages(scope, project)
          sendJson(res, 200, data)
        } catch (e: any) {
          sendError(res, e)
        }
      }) as Handler,
    }))

    // ── 路由 #3: 过期包（exact，先于下面的 prefix 命中） ──────────────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/packages/outdated',
      handler: (async (req: WebReq, res: WebRes) => {
        try {
          const q = queryOf(req)
          const all = await state.listPackages(q.get('scope') ?? undefined, q.get('project') ?? undefined)
          const outdated = all.packages.filter(p => p.isOutdated)
          sendJson(res, 200, {
            packages: outdated,
            totalCount: outdated.length,
            scope: all.scope,
            projectCount: all.projectCount,
          })
        } catch (e: any) {
          sendError(res, e)
        }
      }) as Handler,
    }))

    // ── 路由 #4: 单包详情（prefix —— 不能用 exact + :name，见文件头） ──
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: '/plugins/npm-manager/packages',
      handler: (async (req: WebReq, res: WebRes) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const match = url.pathname.match(/^\/plugins\/npm-manager\/packages\/(.+)$/)
          if (!match) {
            // 裸 /packages 由 exact 路由处理，正常不会走到这里
            sendJson(res, 404, { error: 'not found' })
            return
          }
          const name = decodeURIComponent(match[1])
          const version = url.searchParams.get('version') || '0.0.0'
          const detail = await state.getPackageDetail(name, version)
          if (!detail) {
            sendJson(res, 404, { error: 'not found' })
            return
          }
          sendJson(res, 200, detail)
        } catch (e: any) {
          sendError(res, e)
        }
      }) as Handler,
    }))

    // ── 路由 #5: 刷新缓存（POST） ──────────────────────────────────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/refresh',
      handler: (async (req: WebReq, res: WebRes) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        // 与 /settings 同一套同源校验：清缓存虽是低危写操作，
        // 但被跨站反复触发会让用户每次都白等几十秒重扫。
        if (!isSameOrigin(req)) {
          sendJson(res, 403, { error: '拒绝跨站请求（Origin / Sec-Fetch-Site 校验未通过）' })
          return
        }
        state.invalidate()
        sendJson(res, 200, { ok: true, invalidatedAt: state.cacheInvalidatedAt })
      }) as Handler,
    }))

    // ── 路由 #6: 设置面板元数据（GET）+ 写入配置（POST） ────────────
    // 同一 (kind, path) 只能注册一次（§5.3 铁律 14），所以按 method 分支
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/npm-manager/settings',
      handler: (async (req: WebReq, res: WebRes) => {
        // ── POST：写入配置 ──
        if (req.method === 'POST') {
          // 写接口三道门：同源 / 必须是 JSON / 体积上限
          if (!isSameOrigin(req)) {
            sendJson(res, 403, { ok: false, error: '拒绝跨站写入（Origin / Sec-Fetch-Site 校验未通过）' })
            return
          }
          if (!isJsonContentType(req)) {
            sendJson(res, 415, { ok: false, error: '写接口只接受 Content-Type: application/json' })
            return
          }
          try {
            const body = await readJsonBody(req as any)
            const patch = (body && typeof body.patch === 'object' && body.patch !== null) ? body.patch : body
            if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
              sendJson(res, 400, { ok: false, error: '请求体应为 { patch: { ... } } 或直接是配置对象' })
              return
            }
            const result = await state.applySettingsPatch(patch as Record<string, unknown>)
            if (!result.ok) {
              sendJson(res, 400, result)
              return
            }
            // ⚠️ 只回投影后的字段 —— 绝不 dump state.config（含 githubToken）
            sendJson(res, 200, { ok: true, current: redactConfigForClient(state.config) })
          } catch (e: any) {
            const msg = (e && e.message) ? e.message : String(e)
            const status = /过大/.test(msg) ? 413 : 400
            sendJson(res, status, { ok: false, error: msg })
          }
          return
        }

        // ── GET：读配置 + 字段描述 + 诊断 ──
        sendJson(res, 200, {
          // ⚠️ 只下发白名单字段；凭据（githubToken）永不出现在响应里
          current: redactConfigForClient(state.config),
          namespace: 'npm-manager',
          currentProject: state.cwd,
          // 字段描述由服务端下发 —— 前端按它渲染表单，两边不会漂移
          fields: SETTINGS_FIELDS,
          writable: state.settingsWritable,
          settingsDocument: '~/.dsh/settings.yaml',
          // 诊断：workspaceRegistry 是否接上、项目发现结果、缓存位置
          // （这几个字段帮我们定位过"全系统只剩当前项目"和"缓存不落盘"两类问题）
          diagnostics: {
            workspaceProviderReady: state.hasWorkspaceProvider(),
            workspaceError: state.lastWorkspaceError,
            projectCount: state.listProjects().length,
            ...state.probeSnapshot(),
            diskCachePath: state.diskCache ? state.diskCache.path : null,
            diskCacheDisabled: state.diskCache ? state.diskCache.isDisabled : null,
            diskCacheEntries: state.registryClient.diskCacheSize(),
            diskCacheError: state.diskCache ? state.diskCache.lastError : null,
          },
        })
      }) as Handler,
    }))

    return () => {
      for (const d of disposers) {
        try { d() } catch { /* ignore */ }
      }
    }
  }, 'npm-manager: web routes')
}
