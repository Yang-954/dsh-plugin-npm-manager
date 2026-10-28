/**
 * Tool #2: npm_get_package_info
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
export function registerGetPackageInfoTool(ctx, state) {
    return ctx.tools.register(defineTool({
        name: 'npm_get_package_info',
        description: '查询单个 npm 包的详细信息:当前版本、最新版本、是否过期、主页、GitHub 仓库、可选 changelog。只读。',
        parameters: {
            name: { type: 'string', required: true, description: '包名,如 "typescript"' },
            currentVersion: {
                type: 'string',
                description: '当前已装版本；省略时自动从本机 node_modules/package.json 推断（推断不到才按 latest 比较）',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    /** 包是否查到；false 时其余字段可省略 —— 0.2.1 的输出 schema 校验不接受 null */
                    found: { type: 'boolean', required: true },
                    name: { type: 'string' },
                    latestVersion: { type: 'string' },
                    currentVersion: { type: 'string' },
                    description: { type: 'string' },
                    homepage: { type: 'string' },
                    repository: { type: 'string' },
                    isOutdated: { type: 'boolean' },
                    updateType: {
                        type: 'string',
                        enum: ['major', 'minor', 'patch', 'same', 'downgrade', 'unknown'],
                    },
                    changelog: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                version: { type: 'string' },
                                date: { type: 'string' },
                                notes: { type: 'string' },
                                source: {
                                    type: 'string',
                                    enum: ['github-releases', 'changelog-md', 'none'],
                                },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderDetail(value) }],
        },
        async execute(args, _exec) {
            // ⚠️ 0.2.1 的 ToolRuntime 会对输出做 schema 校验（`createSuccessResult`），
            // 返回 null 直接抛 `ToolOutputError`。所以查不到时返回结构化 `found:false`，
            // 而不是把 null 甩给宿主。
            //
            // 另外：没传 currentVersion 时**真的去推断**（旧版声明「自动从 node_modules 推断」
            // 但实际 default 成 '0.0.0'，于是所有包都显示过期）。
            const version = typeof args.currentVersion === 'string' && args.currentVersion.trim() !== ''
                ? args.currentVersion.trim()
                : await state.inferInstalledVersion(args.name);
            const detail = await state.getPackageDetail(args.name, version ?? '0.0.0');
            if (!detail)
                return { found: false, name: String(args.name) };
            return { found: true, ...detail };
        },
    }));
}
/** 单条 release notes 在渲染里最多占多少行 / 多少字符 */
const NOTES_MAX_LINES = 12;
const NOTES_MAX_CHARS = 900;
/**
 * 紧凑渲染：整段 JSON 会把 release notes 原样倒出来，轻易淹没上下文。
 * 这里只保留判断"要不要升级"需要的信息。
 */
function renderDetail(v) {
    if (v.found === false)
        return `未找到包 ${v.name}（npm registry 上没有这个包，或名字拼错了）`;
    const lines = [];
    const flag = v.isOutdated ? `可升级(${v.updateType})` : '已是最新';
    lines.push(`${v.name}  ${v.currentVersion} → ${v.latestVersion}  [${flag}]`);
    if (v.description)
        lines.push(v.description);
    if (v.homepage)
        lines.push(`主页: ${v.homepage}`);
    if (v.repository)
        lines.push(`仓库: ${v.repository}`);
    const cl = Array.isArray(v.changelog) ? v.changelog : [];
    if (cl.length === 0)
        return lines.join('\n');
    const source = cl[0].source;
    if (source === 'none') {
        lines.push('');
        lines.push(`更新日志: ${cl[0].notes || '（未找到）'}`);
        return lines.join('\n');
    }
    const label = source === 'github-releases' ? 'GitHub Releases' : 'CHANGELOG.md';
    lines.push('');
    lines.push(`更新日志（来源：${label}，最近 ${cl.length} 条）:`);
    for (const s of cl) {
        const head = '  ' + (s.version || '(未标注版本)') + (s.date ? '  ' + s.date : '');
        lines.push(head);
        const notes = String(s.notes || '').trim();
        if (notes === '')
            continue;
        const kept = notes.split(/\r?\n/).slice(0, NOTES_MAX_LINES).join('\n').slice(0, NOTES_MAX_CHARS);
        for (const l of kept.split('\n'))
            lines.push('    ' + l);
        if (notes.length > kept.length)
            lines.push('    …（已截断）');
    }
    return lines.join('\n');
}
//# sourceMappingURL=get-package-info.js.map