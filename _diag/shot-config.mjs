/** 打开配置表单并截图 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/Admin/.workbuddy/skills/fireworks-tech-graph/node_modules'
const req = createRequire(pathToFileURL(ROOT + '/_resolve_.js').href)
const puppeteer = req('puppeteer')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = 'D:/yang/日常非项目活动/dsh-plugin-npm-manager/_diag'
const browser = await puppeteer.launch({
  headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,1100'],
})
async function clickByText(page, text) {
  const hs = await page.$$('button, a, [role="button"], [role="menuitem"], [role="tab"]')
  for (const h of hs) {
    const t = await h.evaluate((n) => (n.innerText || '').trim())
    const vis = await h.evaluate((n) => n.offsetParent !== null)
    if (t === text && vis) { await h.evaluate((n) => n.scrollIntoView({block:'center'})); await h.click(); return true }
  }
  return false
}
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1100 })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message)))
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(6000)
  await clickByText(page, '设置'); await sleep(2500)
  await clickByText(page, 'NPM 管理器'); await sleep(3000)
  // 展开配置
  const expanded = await page.evaluate(() => {
    const root = document.querySelector('[data-plugin="npm-manager"]')
    const btn = root && root.querySelector('.npmgr-cfg-toggle')
    if (!btn) return 'no-toggle'
    btn.click(); return 'clicked'
  })
  await sleep(1200)
  const info = await page.evaluate(() => {
    const root = document.querySelector('[data-plugin="npm-manager"]')
    const body = root && root.querySelector('.npmgr-cfg-body')
    if (!body) return { open: false }
    return {
      open: true,
      items: body.querySelectorAll('.npmgr-cfg-item').length,
      labels: Array.from(body.querySelectorAll('.npmgr-cfg-label')).map((n) => n.innerText.trim()),
      buttons: Array.from(body.querySelectorAll('button')).map((b) => b.innerText.trim()),
      note: (body.querySelector('.npmgr-cfg-note') || {}).innerText || '',
    }
  })
  console.log('展开结果:', expanded)
  console.log('表单:', JSON.stringify(info, null, 1))
  console.log('页面错误:', errs.length === 0 ? '（无）' : errs.join(' | '))
  await page.screenshot({ path: OUT + '/config-form.png' })
} finally { await browser.close() }
