/**
 * Tool #1: npm_list_packages
 *
 * defineTool 用真包 DSL(§5.1):
 * - parameters 是属性 map, 不是 { type: 'object', properties: ... }
 * - required 是属性节点上的布尔, 不是根数组
 * - additionalProperties 在 object 节点上必填字面量 false
 *
 * 三个范围与设置页一致：project(本项目) / global(全局) / system(全系统=所有已知项目)
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
const PKG_ITEM = {
    type: 'object',
    additionalProperties: false,
    properties: {
        name: { type: 'string', required: true },
        currentVersion: { type: 'string', required: true },
        latestVersion: { type: 'string', required: true },
        isOutdated: { type: 'boolean', required: true },
        updateType: {
            type: 'string',
            enum: ['major', 'minor', 'patch', 'same', 'downgrade'],
        },
        description: { type: 'string' },
        homepage: { type: 'string' },
        repository: { type: 'string' },
        // 仅 system 范围填充
        project: { type: 'string' },
        projectPath: { type: 'string' },
    },
};
/** 紧凑渲染：一行一个包，避免 100+ 包时 JSON 淹没上下文 */
function renderList(value) {
    const lines = [];
    const scopeLabel = value.scope === 'project' ? '本项目' : value.scope === 'global' ? '全局' : '全系统';
    const projects = typeof value.projectCount === 'number' ? `，扫描 ${value.projectCount} 个项目` : '';
    const fresh = value.cached === true ? '（来自缓存）' : '';
    lines.push(`${scopeLabel}：共 ${value.totalCount} 个包，${value.outdatedCount} 个可升级${projects}${fresh}`);
    if (value.totalCount === 0) {
        lines.push('（没有找到已安装的包）');
        return lines.join('\n');
    }
    lines.push('');
    for (const p of value.packages) {
        const flag = p.isOutdated ? `可升级(${p.updateType})` : '最新';
        const where = p.project ? `  @${p.project}` : '';
        const desc = p.description ? '  ' + String(p.description).slice(0, 60) : '';
        lines.push(`${p.name}  ${p.currentVersion} -> ${p.latestVersion}  [${flag}]${where}${desc}`);
    }
    return lines.join('\n');
}
export function registerListPackagesTool(ctx, state) {
    return ctx.tools.register(defineTool({
        name: 'npm_list_packages',
        description: '列出本机已安装的 npm 包及其版本/过期状态/描述。只读，不修改任何文件。\n' +
            '范围 scope：project=当前项目（可用 project 参数指向任意目录）、global=npm 全局安装、' +
            'system=所有已知项目（DSH 工作区，每个包会标注所属项目，适合回答"哪个项目在用这个包"）。',
        parameters: {
            scope: {
                type: 'string',
                enum: ['project', 'global', 'system'],
                default: 'project',
                description: '范围：project(本项目，默认) / global(全局) / system(全系统=所有已知项目)',
            },
            project: {
                type: 'string',
                description: '仅 scope=project 时生效：要扫描的项目目录绝对路径。省略则用当前工作目录。',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    packages: {
                        type: 'array',
                        required: true,
                        items: PKG_ITEM,
                    },
                    totalCount: { type: 'integer', required: true },
                    outdatedCount: { type: 'integer', required: true },
                    scope: { type: 'string', required: true, enum: ['project', 'global', 'system'] },
                    projectCount: { type: 'integer' },
                    packageNames: {
                        type: 'array',
                        required: true,
                        items: { type: 'string' },
                    },
                    // 结果缓存信息：同一 (scope, project) 组合在 TTL 内直接复用上次扫描结果
                    cached: { type: 'boolean' },
                    scannedAt: { type: 'integer' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderList(value) }],
        },
        async execute(args, _exec) {
            return await state.listPackages(args.scope, args.project);
        },
    }));
}
//# sourceMappingURL=list-packages.js.map