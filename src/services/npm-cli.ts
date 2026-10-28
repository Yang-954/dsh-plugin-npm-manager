/**
 * npm 子进程调用 —— 跨平台（0.2.1 适配 + Windows 修复）
 *
 * ## 为什么单独抽一层
 *
 * 1. **Windows 上 `spawn('npm')` 必然 ENOENT**。
 *    npm 在 Windows 只装 `npm.cmd`（没有 `npm.exe`），Node 24 裸 `spawn('npm')`
 *    直接 `ENOENT`；`spawn('npm.cmd')` 又报 `EINVAL`（Node 修了 CVE-2024-27980 后
 *    禁止无 shell 执行 `.cmd`/`.bat`）。唯一可用路径是 `shell: true` 或
 *    `cmd.exe /d /s /c`。实测：`spawn('npm', ['--version'], {shell:true})` → 0 / `11.17.0`。
 *
 * 2. **`shell: true` 会打开注入面**（Node 甚至为此发 DEP0190 警告：参数不转义、只拼接）。
 *    所以打开 shell 的同时，包名必须过 {@link assertSafePackageSpec} 白名单 ——
 *    两个措施必须成对出现，缺一个就是把安全问题换成了功能问题（或反过来）。
 *
 * 3. **`spawn` 的 `timeout` 只发 SIGTERM**，子进程若挂在网络 I/O 上可能不退出，
 *    `close` 永不到来 → Promise 永久 pending。这里额外用 `kill` 兜底。
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** Windows 上 npm 的可执行名；其他平台就是 `npm` */
function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** 是否需要 shell：Windows 的 `.cmd` 在 Node 24 下必须经 shell 才能执行 */
function needsShell(): boolean {
  return process.platform === 'win32'
}

/**
 * 包名 / spec 白名单。
 *
 * 允许：`name`、`@scope/name`、可选的 `@version`（含 `1.2.3` / `^1.2.3` / `latest` / `next`）。
 * 明确拒绝：空白、引号、`;`、`&`、`|`、`$`、反引号、`>`、`<`、`(`、`)`、换行 ——
 * 这些在 `shell: true` 下都是命令注入的原语。
 *
 * 返回规范化后的字符串（已 trim）；不合法则抛错（调用方转成工具错误，不静默降级）。
 */
export function assertSafePackageSpec(spec: string): string {
  const s = String(spec ?? '').trim()
  if (s === '') throw new Error('包名不能为空')
  // npm 包名规则（含 scope）＋ 可选版本后缀；整体必须完全匹配
  const ok = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@(?:[\^~]?[0-9]+(?:\.[0-9]+){0,2}|latest|next|beta))?$/i
  if (!ok.test(s)) throw new Error(`包名不合法（拒绝可能含 shell 元字符的输入）：${s.slice(0, 80)}`)
  return s
}

export interface NpmRunResult {
  code: number
  stdout: string
  stderr: string
  /** 是否因为超时/中止被杀（区别于 npm 自己返回非 0） */
  killed: boolean
}

export interface NpmRunOptions {
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  /** 额外参数（如 `-g`）—— 与包名分开传，绝不拼进包名字符串 */
  flags?: string[]
}

/**
 * 跑一次 npm 命令。
 *
 * ⚠️ `flags` 与 `packages` **必须分开传**：旧版把 `-g` 塞进 packages 数组再统一拼
 * `@latest`，得到 `-g@latest` 这种鬼东西，全局升级必失败。
 */
export function runNpm(args: string[], opts: NpmRunOptions): Promise<NpmRunResult> {
  return new Promise<NpmRunResult>((resolve) => {
    let settled = false
    let child: ChildProcess
    let timer: ReturnType<typeof setTimeout> | null = null
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: NpmRunResult) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (hardKillTimer !== null) clearTimeout(hardKillTimer)
      resolve(result)
    }

    const argv = [...args, ...(opts.flags ?? [])]

    try {
      child = spawn(npmExecutable(), argv, {
        cwd: opts.cwd,
        // Windows 的 npm.cmd 必须经 shell；包名已在入口处过白名单
        shell: needsShell(),
        windowsHide: true,
        signal: opts.signal,
      })
    } catch (e: any) {
      finish({ code: -1, stdout: '', stderr: (e && e.message) ? e.message : String(e), killed: false })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: any) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: any) => { stderr += d.toString('utf8') })

    child.on('error', (e: any) => {
      finish({ code: -1, stdout, stderr: stderr + ((e && e.message) ? e.message : String(e)), killed: false })
    })

    child.on('close', (code: number | null) => {
      finish({ code: code ?? -1, stdout, stderr, killed: false })
    })

    // spawn 的 timeout 只发 SIGTERM；若子进程挂在 I/O 上，close 不会来 → 自己兜底
    timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      hardKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        finish({ code: -1, stdout, stderr, killed: true })
      }, 3000)
    }, Math.max(1, opts.timeoutMs))

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        finish({ code: -1, stdout, stderr, killed: true })
      } else {
        opts.signal.addEventListener('abort', () => {
          try { child.kill('SIGTERM') } catch { /* ignore */ }
          finish({ code: -1, stdout, stderr, killed: true })
        }, { once: true })
      }
    }
  })
}
