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
import { SETTINGS_FIELDS } from '../config.js'

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
}

type Handler = (req: WebReq, res: WebRes) => Promise<void>

function sendJson(res: WebRes, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function sendError(res: WebRes, e: any): void {
  sendJson(res, 500, { error: (e && e.message) ? e.message : String(e) })
}

/** 从请求 URL 取查询参数 */
function queryOf(req: WebReq): URLSearchParams {
  return new URL(req.url ?? '/', 'http://x').searchParams
}

/**
 * 读请求体并解析 JSON。
 *
 * 真实宿主里 `req` 是 Node 的 `IncomingMessage`（可异步迭代）。
 * 单测的 fake req 不是流，所以额外支持 `req.body` 已预解析的形态。
 */
async function readJsonBody(req: any, limitBytes = 64 * 1024): Promise<any> {
  if (req && typeof req.body === 'object' && req.body !== null && typeof req.body[Symbol.asyncIterator] !== 'function') {
    return req.body // 预解析（测试 / 某些框架）
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
async function streamPackagesTo(res: WebRes, state: State, scope?: string, project?: string): Promise<void> {
  const canStream = typeof res.write === 'function'

  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 反向代理不要缓冲
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  let buffered = ''
  const emit = (payload: unknown) => {
    const frame = 'data: ' + JSON.stringify(payload) + '\n\n'
    if (canStream) res.write!(frame)
    else buffered += frame
  }

  try {
    for await (const event of state.streamPackages(scope, project)) {
      emit(event)
    }
  } catch (e: any) {
    emit({ type: 'error', error: (e && e.message) ? e.message : String(e) })
  }
  res.end(canStream ? undefined : buffered)
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
            await streamPackagesTo(res, state, scope, project)
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
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end('{"error":"method not allowed"}')
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
            // 写入成功后 watch 已触发 → state.config 是最新值
            sendJson(res, 200, { ok: true, current: state.config })
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: (e && e.message) ? e.message : String(e) })
          }
          return
        }

        // ── GET：读配置 + 字段描述 + 诊断 ──
        sendJson(res, 200, {
          current: state.config,
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
