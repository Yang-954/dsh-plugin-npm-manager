/**
 * loading-check.mjs — 验证「加载中不会显示空态」+「识别到几个就先列几个」
 *
 * 用法：node loading-check.mjs "<token URL>"
 *
 * 背景：用户反馈扫描慢时界面显示"没有找到已安装的包。"，看起来像宕机。
 * 这里用高频轮询取证：
 *   1. 扫描全程**绝不出现**空态文案
 *   2. 全程有旋转指示器（.npmgr-spin）与进度条（.npmgr-track）
 *   3. 行数是**逐步增长**的，首行远早于扫描结束 —— 不是一次性刷出来
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'

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

const EMPTY_TEXTS = ['没有找到已安装的包', 'No installed packages found']

let pass = 0, fail = 0
const assert = (label, cond, extra = '') => {
  if (cond) { console.log('  ✅ ' + label); pass++ }
  else { console.log('  ❌ ' + label + (extra ? ' — ' + extra : '')); fail++ }
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,1000'],
})

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

/** 一次采样：把界面上与"加载观感"有关的状态都取下来 */
async function sample(page) {
  return page.evaluate((empties) => {
    const root = document.querySelector('[data-plugin="npm-manager"]')
    if (!root) return { found: false }
    const text = root.innerText
    const statsEl = root.querySelector('.npmgr-stats')
    const seg = root.querySelector('.npmgr-seg button[aria-pressed="true"]')
    const body = root.querySelector('.npmgr-wrap, .npmgr-msg, .npmgr-err')
    return {
      found: true,
      scope: seg ? seg.innerText.trim() : '',
      rows: root.querySelectorAll('tbody tr').length,
      // ⚠️ 只看**统计行里的**旋转图标 —— 「刷新缓存」按钮自己也有一个 .npmgr-spin，
      //    混进来会让"扫描已开始"误判为真（实测踩过）。
      statsSpin: root.querySelector('.npmgr-stats .npmgr-spin') !== null,
      hasTrack: root.querySelector('.npmgr-track') !== null,
      hasEmptyText: empties.some((e) => text.includes(e)),
      // 注意：不能只看前 120 字 —— 标题/工具栏就占满了，正文的"正在扫描"在后面
      hasScanningText: text.includes('正在扫描'),
      // 主体当前显示的是什么（加载态 / 空态 / 表格）
      bodyKind: body ? body.className : '',
      stats: statsEl ? statsEl.innerText.replace(/\s+/g, ' ').trim() : '',
      bodyHead: text.replace(/\s+/g, ' ').slice(0, 120),
    }
  }, EMPTY_TEXTS)
}

/** 是否处于"正在扫描"状态：进度条出现，或统计行有旋转图标 */
const isScanning = (s) => !!(s && (s.hasTrack || s.statsSpin))

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))

  await page.goto(URL_WITH_TOKEN, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(6000)

  console.log('### 进入设置 → NPM 管理器')
  await clickByText(page, '设置')
  await sleep(2500)
  await clickByText(page, 'NPM 管理器')
  await sleep(1000)

  console.log('\n### 切到「全系统」（最慢的范围）')
  await clickByText(page, '全系统')
  // 等它先加载完一轮，拿到基线
  let settled = null
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const s = await sample(page)
    if (s.found && !isScanning(s) && s.rows > 0) { settled = s; break }
  }
  console.log('  已加载完成: ' + (settled ? settled.stats : '（超时）') + '   scope=' + (settled ? settled.scope : '?'))

  console.log('\n### 点「刷新缓存」强制冷扫描，高频采样')
  const beforeClick = await sample(page)
  await clickByText(page, '刷新缓存')
  const t0 = Date.now()

  const timeline = []
  const rowSeq = []
  let sawEmpty = false
  let sawStatsSpin = false
  let sawTrack = false
  let sawLoadingBody = false
  let started = false
  let sawDrop = false
  let firstRowsAt = null
  let finalRows = 0
  let finalStats = ''
  let scopeSeen = ''

  // 从点击那一刻就开始采样：前 3 秒 100ms 一次（抓"0 个包"的短暂窗口），之后 250ms
  for (let i = 0; i < 500; i++) {
    const s = await sample(page)
    const ms = Date.now() - t0
    if (s.found) {
      if (s.scope) scopeSeen = s.scope
      if (s.hasEmptyText) sawEmpty = true
      if (s.statsSpin) sawStatsSpin = true
      if (s.hasTrack) sawTrack = true
      if (isScanning(s)) started = true
      if (s.hasScanningText) sawLoadingBody = true
      if (rowSeq.length === 0 || rowSeq[rowSeq.length - 1] !== s.rows) rowSeq.push(s.rows)

      // ⚠️ 关键：只有等行数**掉到 0**（旧数据被清掉、新扫描开始）之后才开始统计增长，
      //    否则第一帧读到的 220 行残留值会把 finalRows 顶满，后续增长全被忽略。
      if (started && !sawDrop && s.rows === 0) {
        sawDrop = true
        finalRows = 0
        firstRowsAt = null
        timeline.length = 0
      }

      if (sawDrop) {
        if (firstRowsAt === null && s.rows > 0) firstRowsAt = ms
        if (s.rows > finalRows) {
          finalRows = s.rows
          timeline.push({ ms, rows: s.rows, stats: s.stats })
        }
      }
      finalStats = s.stats
      // 结束条件：已进入过扫描态，且现在既无进度条也无统计行动画
      if (started && !isScanning(s)) break
    }
    await sleep(ms < 3000 ? 100 : 250)
  }

  console.log('\n### 采样结果')
  console.log('  范围（采样期间所见）: ' + scopeSeen)
  console.log('  行数变化序列（前 24 段）: ' + rowSeq.slice(0, 24).join(' → '))
  console.log('  行数增长轨迹（最多 14 条）:')
  const step = Math.max(1, Math.floor(timeline.length / 14))
  for (let i = 0; i < timeline.length; i += step) {
    console.log('    [' + String(timeline[i].ms).padStart(6) + 'ms] ' + String(timeline[i].rows).padStart(4) + ' 行   ' + timeline[i].stats)
  }
  console.log('  首行出现于: ' + firstRowsAt + 'ms   最终: ' + finalRows + ' 行')
  console.log('  最终统计: ' + finalStats)
  console.log('  点击前统计: ' + beforeClick.stats)

  // 加载态是否真的出现过：行数必须先掉到 0（清掉上一批），再长起来
  const minRows = rowSeq.length > 1 ? Math.min.apply(null, rowSeq.slice(1)) : -1

  console.log('\n### 断言')
  assert('⭐ 扫描全程未出现空态文案', !sawEmpty, '出现了"没有找到已安装的包"')
  assert('⭐ 扫描期间统计行有旋转动画', sawStatsSpin)
  assert('⭐ 扫描期间有进度条', sawTrack)
  assert('⭐ 重新扫描时先清空上一批行（min rows = 0）', minRows === 0,
    '观察到的最小行数 = ' + minRows + '（说明旧数据被残留）')
  assert('⭐ 一个包都没到时显示"正在扫描"加载态', sawLoadingBody)
  assert('⭐ 首行远早于扫描结束（渐进式）', firstRowsAt !== null && firstRowsAt < 6000,
    '首行 ' + firstRowsAt + 'ms')
  assert('⭐ 行数逐步增长（不是一次性刷出）', timeline.length >= 3,
    '只观察到 ' + timeline.length + ' 次增长')
  assert('最终行数与刷新前一致', finalRows === beforeClick.rows,
    beforeClick.rows + ' → ' + finalRows)
  assert('页面无错误', errors.length === 0, errors.join(' | '))

  writeFileSync(OUT + '/loading-timeline.json', JSON.stringify({ timeline, firstRowsAt, finalRows }, null, 1), 'utf8')
  await page.screenshot({ path: OUT + '/loading-final.png' })

  console.log('\n=== 共 ' + pass + ' 通过 / ' + fail + ' 失败 ===')
} finally {
  await browser.close()
}
process.exit(fail === 0 ? 0 : 1)
