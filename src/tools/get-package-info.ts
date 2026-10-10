/**
 * Tool #2: npm_get_package_info
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export function registerGetPackageInfoTool(ctx: any, state: any): () => void {
  return ctx.tools.register(defineTool({
    name: 'npm_get_package_info',
    description: '查询单个 npm 包的详细信息:当前版本、最新版本、是否过期、主页、GitHub 仓库、可选 changelog。只读。',
    parameters: {
      name: { type: 'string', required: true, description: '包名,如 "typescript"' },
      currentVersion: { type: 'string', default: '0.0.0', description: '当前已装版本(自动从 node_modules 推断)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          latestVersion: { type: 'string' },
          currentVersion: { type: 'string' },
          description: { type: 'string' },
          homepage: { type: 'string' },
          repository: { type: 'string' },
          isOutdated: { type: 'boolean' },
          updateType: {
            type: 'string',
            enum: ['major', 'minor', 'patch', 'same', 'downgrade'],
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
      render: (_args: any, value: any) => [{ type: 'text', text: renderDetail(value) }],
    },
    async execute(args: any, _exec: any) {
      return await state.getPackageDetail(args.name, args.currentVersion)
    },
  }) as any)
}

/** 单条 release notes 在渲染里最多占多少行 / 多少字符 */
const NOTES_MAX_LINES = 12
const NOTES_MAX_CHARS = 900

/**
 * 紧凑渲染：整段 JSON 会把 release notes 原样倒出来，轻易淹没上下文。
 * 这里只保留判断"要不要升级"需要的信息。
 */
function renderDetail(v: any): string {
  const lines: string[] = []
  const flag = v.isOutdated ? `可升级(${v.updateType})` : '已是最新'
  lines.push(`${v.name}  ${v.currentVersion} → ${v.latestVersion}  [${flag}]`)
  if (v.description) lines.push(v.description)
  if (v.homepage) lines.push(`主页: ${v.homepage}`)
  if (v.repository) lines.push(`仓库: ${v.repository}`)

  const cl = Array.isArray(v.changelog) ? v.changelog : []
  if (cl.length === 0) return lines.join('\n')

  const source = cl[0].source
  if (source === 'none') {
    lines.push('')
    lines.push(`更新日志: ${cl[0].notes || '（未找到）'}`)
    return lines.join('\n')
  }

  const label = source === 'github-releases' ? 'GitHub Releases' : 'CHANGELOG.md'
  lines.push('')
  lines.push(`更新日志（来源：${label}，最近 ${cl.length} 条）:`)
  for (const s of cl) {
    const head = '  ' + (s.version || '(未标注版本)') + (s.date ? '  ' + s.date : '')
    lines.push(head)
    const notes = String(s.notes || '').trim()
    if (notes === '') continue
    const kept = notes.split(/\r?\n/).slice(0, NOTES_MAX_LINES).join('\n').slice(0, NOTES_MAX_CHARS)
    for (const l of kept.split('\n')) lines.push('    ' + l)
    if (notes.length > kept.length) lines.push('    …（已截断）')
  }
  return lines.join('\n')
}
