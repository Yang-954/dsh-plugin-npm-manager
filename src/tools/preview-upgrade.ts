/**
 * Tool #3: npm_preview_upgrade
 *
 * 调用 `npm install --dry-run <pkg>@latest` 看会改什么
 * 不实际安装, 不修改 node_modules / package.json / package-lock.json
 * stderr 经过 sanitize(不泄露 token / 凭据)
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'

interface PreviewItem {
  name: string
  current: string
  target: string
  willChange: boolean
  warnings: string[]
}

interface NpmDryRunOutput {
  added?: Record<string, { version?: string }>
  updated?: Record<string, { from?: string; to?: string }>
  removed?: Record<string, unknown>
  warnings?: string[]
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

function runNpmDryRun(pkg: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<NpmDryRunOutput> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('npm', ['install', '--dry-run', '--json', `${pkg}@latest`], {
        cwd,
        timeout: timeoutMs,
        signal,
      })
    } catch (e: any) {
      reject(e as Error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: any) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: any) => { stderr += d.toString('utf8') })
    child.on('close', (code: any) => {
      if (code === 0 || code === 1) {  // npm dry-run exits 1 if there are changes
        try {
          resolve(JSON.parse(stdout) as NpmDryRunOutput)
        } catch {
          // stdout 可能是空(没变化) — 视为空结果
          resolve({})
        }
      } else {
        reject(new Error(`npm dry-run failed = ${code}, stderr=${sanitizeNpmStderr(stderr)}`))
      }
    })
    child.on('error', reject)
  })
}

export function registerPreviewUpgradeTool(ctx: any, state: any): () => void {
  return ctx.tools.register(defineTool({
    name: 'npm_preview_upgrade',
    description: '预览 npm 包升级 — 调 `npm install --dry-run <pkg>@latest`,返回将改动的包 + 警告。不实际安装,不动 node_modules。',
    parameters: {
      packages: {
        type: 'array',
        items: { type: 'string' },
        description: '要预览升级的包名数组,如 ["cowsay","lodash"]',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          packages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                current: { type: 'string' },
                target: { type: 'string' },
                willChange: { type: 'boolean' },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          totalWarnings: { type: 'integer' },
          dryRun: { type: 'boolean' },  // 永远 true
        },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: any, exec: any) {
      const result: { packages: PreviewItem[]; totalWarnings: number; dryRun: boolean } = {
        packages: [],
        totalWarnings: 0,
        dryRun: true,
      }
      for (const pkg of args.packages as string[]) {
        try {
          const dryRun = await runNpmDryRun(pkg, state.cwd, state.config.npmCommandTimeoutMs, exec.signal)
          const items: PreviewItem[] = [
            ...Object.entries(dryRun.added ?? {}).map(([name, info]) => ({
              name, current: '(not installed)', target: info.version ?? '?', willChange: true, warnings: dryRun.warnings ?? [],
            })),
            ...Object.entries(dryRun.updated ?? {}).map(([name, info]) => ({
              name, current: info.from ?? '?', target: info.to ?? '?', willChange: true, warnings: dryRun.warnings ?? [],
            })),
          ]
          result.packages.push(...items)
          result.totalWarnings += (dryRun.warnings ?? []).length
        } catch (e: any) {
          result.packages.push({
            name: pkg, current: '?', target: '?', willChange: false,
            warnings: [`预览失败: ${(e && e.message) ? e.message : String(e)}`],
          })
        }
      }
      return result
    },
  }) as any)
}
