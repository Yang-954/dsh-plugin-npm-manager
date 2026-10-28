/**
 * Tool #3: npm_preview_upgrade
 *
 * 调用 `npm install --dry-run <pkg>@latest` 看会改什么
 * 不实际安装, 不修改 node_modules / package.json / package-lock.json
 * stderr 经过 sanitize(不泄露 token / 凭据)
 *
 * ## 0.2.1 适配
 * - npm 调用改走 `services/npm-cli.ts`（Windows 上裸 `spawn('npm')` 必 ENOENT）
 * - 包名过白名单（shell 与校验成对出现）
 * - **exit code 1 不再无条件当成功**：npm 的 dry-run 在「有改动」时返回 1，
 *   但网络错误/包不存在也常返回 1。现在要求 stdout 能解析出 JSON 才认，否则报错。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runNpm, assertSafePackageSpec } from '../services/npm-cli.js';
function sanitizeNpmStderr(stderr, maxLen = 200) {
    if (!stderr)
        return '';
    const cleaned = stderr
        .replace(/Bearer[\s_-]+[A-Za-z0-9._\-]+/g, 'Bearer ***')
        .replace(/_?authToken[=:]\s*[A-Za-z0-9._\-]+/gi, 'authToken=***')
        .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic ***')
        .replace(/([a-z]+:\/\/)[^@\/\s]+:[^@\/\s]+@/gi, '$1***:***@');
    return cleaned.slice(0, maxLen) + (stderr.length > maxLen ? '...(truncated)' : '');
}
async function runNpmDryRun(pkg, cwd, timeoutMs, signal) {
    const result = await runNpm(['install', '--dry-run', '--json', `${pkg}@latest`], { cwd, timeoutMs, signal });
    if (result.killed)
        throw new Error(`npm dry-run 超时/被中止（${timeoutMs}ms）`);
    // npm dry-run 在「有改动」时 exit 1；但网络错误 / 包不存在也常是 1。
    // 判据不是 exit code，而是 **stdout 能不能解析出 JSON**。
    const text = result.stdout.trim();
    if (text !== '') {
        try {
            return JSON.parse(text);
        }
        catch {
            /* 落到下面按失败处理 */
        }
    }
    if (result.code === 0)
        return {}; // 没改动：npm 输出空 stdout
    throw new Error(`npm dry-run failed = ${result.code}, stderr=${sanitizeNpmStderr(result.stderr)}`);
}
export function registerPreviewUpgradeTool(ctx, state) {
    return ctx.tools.register(defineTool({
        name: 'npm_preview_upgrade',
        description: '预览 npm 包升级 — 调 `npm install --dry-run <pkg>@latest`,返回将改动的包 + 警告。不实际安装,不动 node_modules。',
        parameters: {
            packages: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '要预览升级的包名数组,如 ["cowsay","lodash"]（至少一个）',
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
                    dryRun: { type: 'boolean' }, // 永远 true
                },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
            const rawPackages = args.packages;
            if (!Array.isArray(rawPackages) || rawPackages.length === 0) {
                throw new Error('packages 必须是非空数组');
            }
            const packages = rawPackages.map((p) => assertSafePackageSpec(String(p)));
            const result = {
                packages: [],
                totalWarnings: 0,
                dryRun: true,
            };
            const timeoutMs = state.cfg ? state.cfg('npmCommandTimeoutMs') : (state.config?.npmCommandTimeoutMs ?? 60_000);
            for (const pkg of packages) {
                try {
                    const dryRun = await runNpmDryRun(pkg, state.cwd, timeoutMs, exec?.signal);
                    const items = [
                        ...Object.entries(dryRun.added ?? {}).map(([name, info]) => ({
                            name, current: '(not installed)', target: info.version ?? '?', willChange: true, warnings: dryRun.warnings ?? [],
                        })),
                        ...Object.entries(dryRun.updated ?? {}).map(([name, info]) => ({
                            name, current: info.from ?? '?', target: info.to ?? '?', willChange: true, warnings: dryRun.warnings ?? [],
                        })),
                    ];
                    result.packages.push(...items);
                    result.totalWarnings += (dryRun.warnings ?? []).length;
                }
                catch (e) {
                    result.packages.push({
                        name: pkg, current: '?', target: '?', willChange: false,
                        warnings: [`预览失败: ${(e && e.message) ? e.message : String(e)}`],
                    });
                }
            }
            return result;
        },
    }));
}
//# sourceMappingURL=preview-upgrade.js.map