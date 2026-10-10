/**
 * cache-check.mjs — 验证「切换子选项不重新扫描」这条行为真的成立
 *
 * 用法：node cache-check.mjs "<token URL>"
 *
 * 判据（比 UI 文本更硬的证据）：
 *   1. 统计请求数：进入页面后每个 (scope, project) 组合只应产生 **1 次**
 *      `GET /plugins/npm-manager/packages`
 *   2. 统计行里的「数据 HH:MM」在切来切去时**保持不变**
 *   3. 点「刷新缓存」后：产生新请求，且「数据 HH:MM」随之更新
 */

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = 'D:/yang/日常非项目活动/dsh-plugin-npm-manager/_diag'

/** 所有打到 /packages 的请求 */
const pkgRequests = []
let errors = []

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

/** 读统计行（含「数据 HH:MM」）与行数 */
async function snapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-plugin="npm-manager"]')
    if (!root) return { found: false }
    const statsEl = root.querySelector('.npmgr-stats')
    const stats = statsEl ? statsEl.innerText.trim() : ''
    const m = stats.match(/数据\s+(\d{1,2}:\d{2})/)
    return {
      found: true,
      stats,
      dataTime: m ? m[1] : null,
      rows: root.querySelectorAll('tbody tr').length,
      busy: !!root.querySelector('.npmgr-btn[disabled]'),
    }
  })
}

/** 轮询直到条件成立 */
async function until(page, pred, tries = 40, label = '') {
  for (let i = 1; i <= tries; i++) {
    await sleep(2500)
    const s = await snapshot(page)
    if (s.found && pred(s)) return s
    if (i % 6 === 0) console.log('    等待中' + (label ? '（' + label + '）' : '') + '… ' + (s.found ? s.stats : '无面板'))
  }
  return snapshot(page)
}

let pass = 0, fail = 0
function assert(label, cond, extra = '') {
  if (cond) { console.log('  ✅ ' + label); pass++ }
  else { console.log('  ❌ ' + label + (extra ? ' — ' + extra : '')); fail++ }
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
  page.on('request', (r) => {
    const u = r.url()
    if (u.includes('/plugins/npm-manager/packages')) pkgRequests.push(u)
  })

  await page.goto(URL_WITH_TOKEN, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(6000)

  console.log('### 步骤 1：进入设置 → NPM 管理器（首次扫描「本项目」）')
  await clickByText(page, '设置')
  await sleep(2500)
  await clickByText(page, 'NPM 管理器')
  const s1 = await until(page, (s) => s.rows > 0 && s.dataTime !== null, 40, '本项目首次扫描')
  const reqAfterEnter = pkgRequests.length
  console.log('  统计: ' + s1.stats)
  console.log('  行数: ' + s1.rows + '，数据时间: ' + s1.dataTime + '，packages 请求数: ' + reqAfterEnter)
  assert('进入后产生了 1 次 packages 请求', reqAfterEnter === 1, '实际 ' + reqAfterEnter)

  console.log('\n### 步骤 2：切「全局」（首次扫描，应 +1 次请求）')
  await clickByText(page, '全局')
  const s2 = await until(page, (s) => s.dataTime !== null && s.stats !== s1.stats, 40, '全局首次扫描')
  console.log('  统计: ' + s2.stats + '  行数: ' + s2.rows)
  assert('切到全局产生了新请求', pkgRequests.length === reqAfterEnter + 1, '实际 ' + pkgRequests.length)

  console.log('\n### 步骤 3：切「全系统」（首次扫描，应 +1 次请求）')
  await clickByText(page, '全系统')
  const s3 = await until(page, (s) => /个项目/.test(s.stats) && s.rows > 0, 60, '全系统首次扫描')
  console.log('  统计: ' + s3.stats + '  行数: ' + s3.rows)
  const reqAfterSystem = pkgRequests.length
  assert('切到全系统产生了新请求', reqAfterSystem === reqAfterEnter + 2, '实际 ' + reqAfterSystem)

  console.log('\n### 步骤 4：切回「本项目」—— 应命中缓存，零新请求')
  await clickByText(page, '本项目')
  await sleep(4000)
  const s4 = await snapshot(page)
  console.log('  统计: ' + s4.stats + '  行数: ' + s4.rows + '  数据时间: ' + s4.dataTime)
  assert('切回本项目未产生新请求', pkgRequests.length === reqAfterSystem, '实际 ' + pkgRequests.length)
  assert('数据时间与首次「本项目」一致（用的是缓存）', s4.dataTime === s1.dataTime,
    '首次 ' + s1.dataTime + ' vs 现在 ' + s4.dataTime)
  assert('行数与首次一致', s4.rows === s1.rows, s1.rows + ' vs ' + s4.rows)

  console.log('\n### 步骤 5：再切回「全系统」—— 应命中缓存，零新请求')
  await clickByText(page, '全系统')
  await sleep(4000)
  const s5 = await snapshot(page)
  console.log('  统计: ' + s5.stats + '  行数: ' + s5.rows + '  数据时间: ' + s5.dataTime)
  assert('再切全系统未产生新请求', pkgRequests.length === reqAfterSystem, '实际 ' + pkgRequests.length)
  assert('数据时间与首次「全系统」一致', s5.dataTime === s3.dataTime,
    '首次 ' + s3.dataTime + ' vs 现在 ' + s5.dataTime)

  console.log('\n### 步骤 6：点「刷新缓存」—— 应产生新请求且数据时间更新')
  const beforeRefresh = pkgRequests.length
  await clickByText(page, '刷新缓存')
  const s6 = await until(page, (s) => s.rows > 0 && !s.busy, 40, '刷新')
  console.log('  统计: ' + s6.stats + '  行数: ' + s6.rows + '  数据时间: ' + s6.dataTime)
  assert('刷新后产生了新请求', pkgRequests.length > beforeRefresh,
    beforeRefresh + ' → ' + pkgRequests.length)

  console.log('\n### 步骤 7：筛选是纯客户端，不应产生任何请求')
  const beforeFilter = pkgRequests.length
  await page.evaluate(() => {
    const root = document.querySelector('[data-plugin="npm-manager"]')
    const input = root.querySelector('input[type="search"]')
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'deepseek')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await sleep(2500)
  const s7 = await snapshot(page)
  console.log('  搜索 "deepseek" 后 统计: ' + s7.stats + '  行数: ' + s7.rows)
  assert('搜索未产生任何请求', pkgRequests.length === beforeFilter, '实际 ' + pkgRequests.length)
  assert('搜索确实过滤了（行数下降）', s7.rows > 0 && s7.rows < s6.rows, s6.rows + ' → ' + s7.rows)

  await page.screenshot({ path: OUT + '/cache-final.png' })

  console.log('\n### 请求清单')
  pkgRequests.forEach((u, i) => console.log('  ' + (i + 1) + '. ' + u.replace(/^https?:\/\/[^/]+/, '')))
  console.log('\n### 页面错误')
  console.log(errors.length === 0 ? '  （无）' : errors.map((e) => '  ' + e).join('\n'))

  console.log('\n=== 共 ' + pass + ' 通过 / ' + fail + ' 失败 ===')
} finally {
  await browser.close()
}
process.exit(fail === 0 ? 0 : 1)
