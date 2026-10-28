/**
 * Tool #4: npm_apply_upgrade
 *
 * 高危 — 配合 §7 approval guard(用户事先批准才能跑)
 * + read-back package.json sha256 对比
 * + dryRun 默认 true(必须显式 dryRun:false 才执行)
 * stderr 经过 sanitize(不泄露 npm token / 凭据)
 *
 * ## 0.2.1 适配
 * - npm 调用改走 `services/npm-cli.ts`：Windows 用 `npm.cmd` + shell（裸 `spawn('npm')`
 *   在 Windows 必 ENOENT，实测两个升级工具 100% 不可用）
 * - `-g` 与包名**分开**传（旧版把 `-g` 塞进 packages 再拼 `@latest` → `-g@latest`）
 * - 包名过白名单（开了 shell 就必须校验，两者是成对的）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runNpm, assertSafePackageSpec } from '../services/npm-cli.js'

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

export function registerApplyUpgradeTool(ctx: any, state: any): () => void {
  return ctx.tools.register(defineTool({
    name: 'npm_apply_upgrade',
    description: '真实执行 npm 包升级。必须 confirm=true 且 dryRun=false 才会改 package.json 和 node_modules。配合 approval guard,用户事先批准才能跑。',
    parameters: {
      packages: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '要升级的包名数组（至少一个）',
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
      const rawPackages: unknown = args.packages
      if (!Array.isArray(rawPackages) || rawPackages.length === 0) {
        throw new Error('packages 必须是非空数组')
      }
      // 安全约束 1.5: 包名白名单（开了 shell 就必须校验，两者成对）
      const packages = rawPackages.map((p: unknown) => assertSafePackageSpec(String(p)))
      const isGlobal = args.scope === 'global'

      // 安全约束 2: dryRun 默认 true, 不显式 false 不执行
      if (args.dryRun !== false) {
        return {
          success: false,
          executed: false,
          dryRun: true,
          packages: packages.map((n: string) => ({ name: n, from: '?', to: '(not executed, dry-run mode)' })),
          packageJsonChanged: false,
          beforeHash: hashPkg(state.cwd),
          afterHash: hashPkg(state.cwd),
          message: 'dry-run 模式,未执行任何操作。传 dryRun:false 才会真升级',
        }
      }

      // 安全约束 3: read-back package.json sha256（仅 project 范围有意义；
      // global 装到 npm 前缀目录，不会动本项目的 package.json）
      const beforeHash = hashPkg(state.cwd)
      const result = await runNpm(
        ['install', '--json', ...packages.map((n: string) => `${n}@latest`)],
        {
          cwd: state.cwd,
          timeoutMs: state.cfg ? state.cfg('npmCommandTimeoutMs') : state.config?.npmCommandTimeoutMs ?? 60_000,
          signal: exec?.signal,
          // ⚠️ flags 与包名分开：旧版把 '-g' 拼进包名列表得到 '-g@latest'
          flags: isGlobal ? ['--global'] : [],
        },
      )
      const afterHash = hashPkg(state.cwd)
      const packageJsonChanged = !isGlobal && beforeHash !== null && afterHash !== null && beforeHash !== afterHash

      const ok = result.code === 0
      return {
        success: ok,
        executed: true,
        dryRun: false,
        packages: packages.map((n: string) => ({ name: n, from: '?', to: '?' })),
        packageJsonChanged,
        beforeHash,
        afterHash,
        message: ok
          ? `升级完成 (exitCode=${result.code})`
          : result.killed
            ? `升级超时/被中止（${state.cfg ? state.cfg('npmCommandTimeoutMs') : 60000}ms）`
            : `升级失败 exitCode=${result.code}: ${sanitizeNpmStderr(result.stderr)}`,
      }
    },
  }) as any)
}
