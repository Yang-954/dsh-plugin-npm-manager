/**
 * browser-check.mjs — 用真实浏览器验证「NPM 管理器」标签页的三个范围
 *
 * 用法：node browser-check.mjs "<token URL>"
 *
 * 覆盖：
 *   1. 标签页在导航里、整页渲染、默认「本项目」有数据
 *   2. 切「全局」→ 有数据且无「项目」列
 *   3. 切「全系统」→ 有数据、出现「项目」列、每行标注所属项目
 *   4. 全系统的项目筛选生效（行数下降）
 *   5. 本项目的项目选择器可切换项目并重新加载
 *   6. 全程零 pageerror / 零失败请求
 */

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PUPPETEER_ROOT = process.env.PUPPETEER_ROOT
  || 'C:/Users/Admin/.workbuddy/skills/fireworks-tech-graph/node_modules'
const req = createRequire(pathToFileURL(PUPPETEER_ROOT + '/_resolve_.js').href)
const puppeteer = req('puppeteer')

const URL_WITH_TOKEN = process.argv[2]
if (!URL_WITH_TOKEN) {
  console.error('缺少 token URL')
  process.exit(2)
}

const OUT = 'D:/yang/日常非项目活动/dsh-plugin-npm-manager/_diag'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const logs = []
const errors = []
const failedRequests = []

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,1000'],
})

/** 按可见文本点击（真实鼠标事件；只挑可见候选） */
async function clickByText(page, text, exact = true) {
  const handles = await page.$$('button, a, [role="button"], [role="menuitem"], [role="tab"]')
  const matches = []
  for (const h of handles) {
    const info = await h.evaluate((n) => ({
      t: (n.innerText || n.getAttribute('aria-label') || '').trim(),
      visible: n.offsetParent !== null,
    }))
    if (exact ? info.t === text : info.t.includes(text)) matches.push({ h, ...info })
  }
  const pick = matches.find((m) => m.visible) || matches[0]
  if (!pick) return false
  try {
    await pick.h.evaluate((n) => n.scrollIntoView({ block: 'center' }))
    await pick.h.click()
    return true
  } catch {
    await pick.h.evaluate((n) => n.click())
    return true
  }
}

/** 读当前面板状态 */
async function readPanel(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-plugin="npm-manager"]')
    if (!root) return { found: false }
    const headers = Array.from(root.querySelectorAll('thead th')).map((th) => th.innerText.trim())
    const rows = Array.from(root.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.trim()))
    const seg = Array.from(root.querySelectorAll('.npmgr-seg button')).map((b) => ({
      label: b.innerText.trim(),
      pressed: b.getAttribute('aria-pressed') === 'true',
    }))
    const selects = Array.from(root.querySelectorAll('select')).map((s) => ({
      value: s.value,
      options: Array.from(s.options).map((o) => o.text.trim()),
    }))
    const statsEl = root.querySelector('.npmgr-stats')
    return {
      found: true,
      headers,
      rowCount: rows.length,
      rows: rows.slice(0, 4),
      seg,
      selects,
      stats: statsEl ? statsEl.innerText.trim() : '',
    }
  })
}

/** 轮询直到表格出现（或进入明确的终态） */
async function waitRows(page, min = 1, tries = 16) {
  for (let i = 1; i <= tries; i++) {
    const p = await readPanel(page)
    if (p.found && p.rowCount >= min) return p
    await sleep(3000)
  }
  return readPanel(page)
}

/**
 * 轮询直到统计行变化（重新加载期间组件会保留上一批行，只等 rowCount 会读到 stale 数据）。
 * @param baseline 切换前的统计文本
 */
async function waitStatsChange(page, baseline, tries = 30) {
  for (let i = 1; i <= tries; i++) {
    await sleep(3000)
    const p = await readPanel(page)
    if (p.found && p.stats && p.stats !== baseline) return p
    if (i % 5 === 0) console.log('    等待中… ' + (p.found ? p.stats : '未找到面板'))
  }
  return readPanel(page)
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }))
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
  page.on('requestfailed', (r) => failedRequests.push(r.url() + ' :: ' + (r.failure()?.errorText || '')))

  console.log('→ 打开 ' + URL_WITH_TOKEN.replace(/token=.*/, 'token=***'))
  await page.goto(URL_WITH_TOKEN, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(6000)

  console.log('\n### 步骤 1：打开设置 → NPM 管理器')
  const okSettings = await clickByText(page, '设置')
  await sleep(2500)
  const okTab = await clickByText(page, 'NPM 管理器')
  console.log('  设置=' + okSettings + '  标签页=' + okTab)
  await sleep(2000)

  console.log('\n### 步骤 2：默认「本项目」')
  let p = await waitRows(page, 1)
  console.log('  表头: ' + JSON.stringify(p.headers))
  console.log('  分段: ' + JSON.stringify(p.seg))
  console.log('  统计: ' + p.stats)
  console.log('  行数: ' + p.rowCount)
  console.log('  首行: ' + JSON.stringify(p.rows[0]))
  console.log('  下拉: ' + JSON.stringify(p.selects))
  await page.screenshot({ path: OUT + '/scopes-1-project.png' })

  console.log('\n### 步骤 3：切「全局」')
  const baselineGlobal = p.stats
  await clickByText(page, '全局')
  p = await waitStatsChange(page, baselineGlobal)
  console.log('  表头: ' + JSON.stringify(p.headers))
  console.log('  统计: ' + p.stats + '  行数: ' + p.rowCount)
  console.log('  前 3 行: ' + JSON.stringify(p.rows.slice(0, 3)))
  await page.screenshot({ path: OUT + '/scopes-2-global.png' })

  console.log('\n### 步骤 4：切「全系统」')
  await clickByText(page, '全系统')
  // ⚠️ 不能只等 rowCount>=1 —— 重新加载期间组件会保留上一批行（stale）。
  // 必须等到统计行出现「N 个项目」（只有 system 范围才有 projectCount）。
  let sysPanel = null
  for (let i = 1; i <= 40; i++) {
    await sleep(3000)
    const q = await readPanel(page)
    if (q.found && /个项目|projects/.test(q.stats) && q.rowCount > 0) { sysPanel = q; break }
    if (i % 5 === 0) console.log('    等待中… ' + (q.found ? q.stats + ' / ' + q.rowCount + ' 行' : '未找到面板'))
  }
  p = sysPanel || await readPanel(page)
  console.log('  表头: ' + JSON.stringify(p.headers))
  console.log('  统计: ' + p.stats + '  行数: ' + p.rowCount)
  console.log('  前 3 行: ' + JSON.stringify(p.rows.slice(0, 3)))
  console.log('  下拉: ' + JSON.stringify(p.selects))
  await page.screenshot({ path: OUT + '/scopes-3-system.png' })

  const distinctProjects = await page.evaluate(() => {
    const root = document.querySelector('[data-plugin="npm-manager"]')
    const idx = Array.from(root.querySelectorAll('thead th')).findIndex((th) => th.innerText.trim() === '项目')
    if (idx < 0) return null
    const set = new Set()
    for (const tr of root.querySelectorAll('tbody tr')) {
      const td = tr.querySelectorAll('td')[idx]
      if (td) set.add(td.innerText.trim())
    }
    return Array.from(set)
  })
  console.log('  出现的项目: ' + JSON.stringify(distinctProjects))

  console.log('\n### 步骤 5：项目筛选')
  if (distinctProjects && distinctProjects.length > 1) {
    const target = distinctProjects[1]
    const ok = await page.evaluate((want) => {
      const root = document.querySelector('[data-plugin="npm-manager"]')
      const sel = Array.from(root.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => o.text.trim() === want))
      if (!sel) return false
      sel.value = want
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, target)
    await sleep(3000)
    const filtered = await page.evaluate(() => {
      const root = document.querySelector('[data-plugin="npm-manager"]')
      const idx = Array.from(root.querySelectorAll('thead th')).findIndex((th) => th.innerText.trim() === '项目')
      const set = new Set()
      for (const tr of root.querySelectorAll('tbody tr')) {
        const td = tr.querySelectorAll('td')[idx]
        if (td) set.add(td.innerText.trim())
      }
      return { rows: root.querySelectorAll('tbody tr').length, projects: Array.from(set) }
    })
    console.log('  选择「' + target + '」= ' + ok + ' → 行数 ' + filtered.rows + '，项目 ' + JSON.stringify(filtered.projects))
    await page.screenshot({ path: OUT + '/scopes-4-filtered.png' })
  } else {
    console.log('  （只出现一个项目，跳过筛选断言）')
  }

  console.log('\n### 步骤 6：切回「本项目」并换一个项目')
  await clickByText(page, '本项目')
  await sleep(9000)
  const projectSwitch = await page.evaluate(() => {
    const root = document.querySelector('[data-plugin="npm-manager"]')
    const sel = Array.from(root.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => /自定义路径/.test(o.text)))
    if (!sel || sel.options.length < 3) return { ok: false, optionCount: sel ? sel.options.length : 0 }
    const opts = Array.from(sel.options).map((o) => ({ text: o.text.trim(), value: o.value }))
    sel.value = opts[2].value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, optionCount: opts.length, picked: opts[2].text, options: opts.slice(0, 8) }
  })
  console.log('  项目选择器: ' + JSON.stringify(projectSwitch))
  const baselineSwitch = p.stats
  p = await waitStatsChange(page, baselineSwitch)
  console.log('  切换后 统计: ' + p.stats + '  行数: ' + p.rowCount)
  console.log('  首行: ' + JSON.stringify(p.rows[0]))
  await page.screenshot({ path: OUT + '/scopes-5-switched-project.png' })

  console.log('\n### 页面错误')
  if (errors.length === 0) console.log('  （无）')
  for (const e of errors.slice(0, 20)) console.log('  ' + e.slice(0, 300))

  console.log('\n### 失败请求')
  const interesting = failedRequests.filter((u) => !/favicon/.test(u))
  if (interesting.length === 0) console.log('  （无）')
  for (const u of interesting.slice(0, 20)) console.log('  ' + u.slice(0, 260))

  console.log('\n### 控制台消息（除既有 git-graph warn）')
  const noisy = logs.filter((l) => !/git-graph/.test(l.text))
  if (noisy.length === 0) console.log('  （无）')
  for (const l of noisy.slice(0, 20)) console.log('  [' + l.type + '] ' + l.text.slice(0, 240))

  writeFileSync(OUT + '/scopes-result.json', JSON.stringify({ errors, failedRequests, logs }, null, 1), 'utf8')
} finally {
  await browser.close()
}
