/**
 * Tool #4: npm_apply_upgrade
 *
 * 高危 — 配合 §7 approval guard(用户事先批准才能跑)
 * + read-back package.json sha256 对比
 * + dryRun 默认 true(必须显式 dryRun:false 才执行)
 * stderr 经过 sanitize(不泄露 npm token / 凭据)
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function hashPkg(cwd: string): string | null {
  const p = join(cwd, 'package.json')
  try {
    return createHash('sha256').update(readFileSync(p, 'utf8')).digest('hex')
  } catch {
    return null
  }
}

function sanitizeNpmStderr(stderr: string, maxLen: number = 200): string {
  if (!stderr) return ''
  const cleaned = stderr
    .replace(/Bearer[\s_-]+[A-Za-z0-9._\-]+/g, 'Bearer ***')
    .replace(/_?authToken[=:]\s*[A-Za-z0-9._\-]+/gi, 'authToken=***')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic ***')
    .replace(/([a-z]+:\/\/)[^@\/\s]+:[^@\/\s]+@/gi, '$1***:***@')
  return cleaned.slice(0, maxLen) + (stderr.length > maxLen ? '...(truncated)' : '')
}

function runNpmInstall(packages: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const args = ['install', '--json', ...packages.map(p => `${p}@latest`)]
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('npm', args, { cwd, timeout: timeoutMs, signal })
    } catch (e: any) {
      resolve({ code: -1, stderr: (e && e.message) ? e.message : String(e) })
      return
    }
    let stderr = ''
    child.stderr?.on('data', (d: any) => { stderr += d.toString('utf8') })
    child.on('close', code => resolve({ code: code ?? -1, stderr }))
    child.on('error', e => resolve({ code: -1, stderr: (e && e.message) ? e.message : String(e) }))
  })
}

export function registerApplyUpgradeTool(ctx: any, state: any): () => void {
  return ctx.tools.register(defineTool({
    name: 'npm_apply_upgrade',
    description: '真实执行 npm 包升级。必须 confirm=true 且 dryRun=false 才会改 package.json 和 node_modules。配合 approval guard,用户事先批准才能跑。',
    parameters: {
      packages: {
        type: 'array',
        items: { type: 'string' },
        description: '要升级的包名数组',
      },
      confirm: {
        type: 'boolean',
        required: true,
        description: '⚠ 必须 true, 否则报错(避免误调用)',
      },
      dryRun: {
        type: 'boolean',
        default: true,
        description: '默认 true(只预览); 只有显式 false 才执行 install',
      },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        required: true,
        description: '升级到 project (本项目 node_modules) 还是 global (npm -g)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean' },
          executed: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          packages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
              },
            },
          },
          packageJsonChanged: { type: 'boolean' },
          beforeHash: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          afterHash: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          message: { type: 'string' },
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: any, exec: any) {
      // 安全约束 1: confirm 必须 true
      if (args.confirm !== true) {
        throw new Error('confirm must be true (dry-run + confirm 强制)')
      }
      // 安全约束 2: dryRun 默认 true, 不显式 false 不执行
      if (args.dryRun !== false) {
        return {
          success: false,
          executed: false,
          dryRun: true,
          packages: (args.packages as string[]).map(n => ({ name: n, from: '?', to: '(not executed, dry-run mode)' })),
          packageJsonChanged: false,
          beforeHash: hashPkg(state.cwd),
          afterHash: hashPkg(state.cwd),
          message: 'dry-run 模式,未执行任何操作。传 dryRun:false 才会真升级',
        }
      }
      // 安全约束 3: read-back package.json sha256
      const beforeHash = hashPkg(state.cwd)
      const target = args.scope === 'global' ? ['-g', ...(args.packages as string[])] : (args.packages as string[])
      const result = await runNpmInstall(target, state.cwd, state.config.npmCommandTimeoutMs, exec.signal)
      const afterHash = hashPkg(state.cwd)
      const packageJsonChanged = beforeHash !== null && afterHash !== null && beforeHash !== afterHash

      const ok = result.code === 0
      return {
        success: ok,
        executed: true,
        dryRun: false,
        packages: (args.packages as string[]).map((n: string) => ({ name: n, from: '?', to: '?' })),
        packageJsonChanged,
        beforeHash,
        afterHash,
        message: ok
          ? `升级完成 (exitCode=${result.code})`
          : `升级失败 exitCode=${result.code}: ${sanitizeNpmStderr(result.stderr)}`,
      }
    },
  }) as any)
}
