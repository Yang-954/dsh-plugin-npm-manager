/**
 * 改写提交历史里的作者/提交者邮箱（local part），并清理 AI 归属尾行。
 *
 * 背景一：DSH 工作空间给各 Agent 分配形如 `<name>@agent.local` 的虚拟邮箱。
 * GitHub 归属提交时，除「已验证邮箱」外还有一条路径：**邮箱 `@` 前缀若与某个
 * 账号的登录名相同，就直接归属到该账号**（不看域名）。于是 `claude@agent.local`
 * 会被算作 Anthropic 官方账号 `claude` 的贡献，页面上冒出 Claude 头像。
 * 本脚本把 local part 换成 `yjh-agent-<name>` 这类不会撞真实账号的形式。
 *
 * 背景二：提交消息正文里的 `Co-Authored-By: <某人> <邮箱>` 尾行会让 GitHub
 * 在提交旁渲染**共创头像** —— 这与邮箱归属是**两条独立路径**，只改邮箱无效。
 * 且按 [git-rule.md §1.3](rules/git-rule.md)，提交消息里不应出现 AI 归属尾行。
 * 本脚本把这些尾行整行删除。
 *
 * 用法：node scripts/rewrite-agent-emails.mjs <repo-dir> [--dry]
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const repoDir = process.argv[2]
const dry = process.argv.includes('--dry')

if (!repoDir) {
  console.error('用法: node scripts/rewrite-agent-emails.mjs <repo-dir> [--dry]')
  process.exit(1)
}

const git = (...args) =>
  execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' })

/** local part → 新的 local part（保留 @agent.local 域名） */
const RENAMES = {
  claude: 'yjh-agent-claude',
  deepseek: 'yjh-agent-deepseek',
  codex: 'yjh-agent-codex',
  antigravity: 'yjh-agent-antigravity',
  mavis: 'yjh-agent-mavis',
  workbuddy: 'yjh-agent-workbuddy',
  // 已被 dsh-agent-* 改写过的，再统一到 yjh-agent-*
  'dsh-agent-claude': 'yjh-agent-claude',
  'dsh-agent-deepseek': 'yjh-agent-deepseek',
  'dsh-agent-codex': 'yjh-agent-codex',
  'dsh-agent-antigravity': 'yjh-agent-antigravity',
  'dsh-agent-mavis': 'yjh-agent-mavis',
  'dsh-agent-workbuddy': 'yjh-agent-workbuddy',
}

const rename = (email) => {
  const at = email.lastIndexOf('@')
  if (at < 0) return email
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const next = RENAMES[local]
  return next ? `${next}@${domain}` : email
}

const raw = (s) => {
  const buf = Buffer.from(s, 'utf8')
  let len = 0
  while (buf[len] !== 0) len++
  return buf.slice(0, len)
}

const commitFields = (sha) => {
  const out = git('cat-file', 'commit', sha)
  const headerEnd = out.indexOf('\n\n')
  const body = out.slice(headerEnd + 2)
  const headers = out.slice(0, headerEnd).split('\n')
  const get = (k) => {
    const h = headers.find((x) => x.startsWith(k + ' '))
    return h ? h.slice(k.length + 1) : null
  }
  return {
    tree: get('tree'),
    parents: headers.filter((x) => x.startsWith('parent ')).map((x) => x.slice(7)),
    author: get('author'),
    committer: get('committer'),
    message: body,
  }
}

/** 拆解 'Name <email> 1699999999 +0800' 形式的 header */
const parseHeader = (header) => {
  const m = /^([^<]*)<([^>]*)>(\s.*)$/.exec(header)
  if (!m) return null
  const [, name, email, rest] = m
  const tm = /(\d+ [+-]\d{4})$/.exec(rest)
  return { name: name.trim(), email, date: tm ? tm[1] : '' }
}

/** 改写 'Name <email> 1699999999 +0800' 形式的 header */
const rewriteHeader = (header) => {
  const p = parseHeader(header)
  if (!p) return header
  return `${p.name} <${rename(p.email)}> ${p.date}`
}

/**
 * 删掉提交消息里的 AI 归属尾行。
 *
 * `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` 这类尾行会让
 * GitHub 在提交旁渲染共创头像，与邮箱归属是两条独立路径。整行删除，
 * 同时收掉尾部多余空行。
 */
const stripCoAuthorTrailers = (message) => {
  const lines = message.split('\n')
  const kept = lines.filter((l) => !/^\s*co-authored-by\s*:/i.test(l))
  if (kept.length === lines.length) return { message, changed: false }
  // 去掉被删行留下的尾部空行
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  return { message: kept.join('\n') + '\n', changed: true }
}

const branches = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')
  .trim()
  .split('\n')
  .filter(Boolean)

console.log(`仓库: ${repoDir}`)
console.log(`分支: ${branches.map((b) => b.split(' ')[0].replace('refs/heads/', '')).join(', ')}\n`)

for (const line of branches) {
  const [ref, head] = line.split(' ')
  const short = ref.replace('refs/heads/', '')
  const commits = git('rev-list', '--reverse', head).trim().split('\n').filter(Boolean)

  const map = new Map()
  let rewritten = 0
  let unchanged = 0

  for (const sha of commits) {
    const f = commitFields(sha)
    const newAuthor = rewriteHeader(f.author)
    const newCommitter = rewriteHeader(f.committer)
    const stripped = stripCoAuthorTrailers(f.message)
    const newParents = f.parents.map((p) => map.get(p) ?? p)
    // ⚠️ 父提交被改写时，**本提交也必须重建** —— 否则它的父指针仍指向旧提交，
    //    新旧两条链会混在一起，HEAD 可能压根不在新链上（表现为「改写了但没生效」）。
    const parentsChanged =
      newParents.length !== f.parents.length ||
      newParents.some((p, i) => p !== f.parents[i])
    const contentChanged =
      newAuthor !== f.author || newCommitter !== f.committer || stripped.changed
    if (!contentChanged && !parentsChanged) {
      map.set(sha, sha)
      unchanged++
      continue
    }
    const args = ['commit-tree', f.tree]
    for (const p of newParents) args.push('-p', p)
    // commit-tree 没有 --author 选项，作者与提交者都走环境变量
    const a = parseHeader(newAuthor) ?? { name: '', email: '', date: '' }
    const c = parseHeader(newCommitter) ?? { name: '', email: '', date: '' }
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: a.name,
      GIT_AUTHOR_EMAIL: a.email,
      GIT_AUTHOR_DATE: a.date,
      GIT_COMMITTER_NAME: c.name,
      GIT_COMMITTER_EMAIL: c.email,
      GIT_COMMITTER_DATE: c.date,
    }
    const newSha = execFileSync('git', ['-C', repoDir, ...args], {
      encoding: 'utf8',
      env,
      input: stripped.message,
    }).trim()
    map.set(sha, newSha)
    rewritten++
  }

  const newHead = map.get(head)
  console.log(`[${short}] ${commits.length} 个提交：改写 ${rewritten}，未变 ${unchanged}`)
  console.log(`  ${head.slice(0, 7)} -> ${newHead.slice(0, 7)}`)

  if (!dry && newHead !== head) {
    git('update-ref', ref, newHead)
    console.log(`  已更新 ${ref}`)
  }
}

if (dry) console.log('\n[dry] 未实际写入')
