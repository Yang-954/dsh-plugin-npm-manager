/** 抓一张"扫描中"的截图（用于展示动画与进度条） */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/Admin/.workbuddy/skills/fireworks-tech-graph/node_modules'
const req = createRequire(pathToFileURL(ROOT + '/_resolve_.js').href)
const puppeteer = req('puppeteer')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = 'D:/yang/日常非项目活动/dsh-plugin-npm-manager/_diag'

const browser = await puppeteer.launch({
  headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,1000'],
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
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(6000)
  await clickByText(page, '设置'); await sleep(2500)
  await clickByText(page, 'NPM 管理器'); await sleep(1500)
  await clickByText(page, '全系统')
  await sleep(8000)
  // 强制冷扫描后立刻截
  await clickByText(page, '刷新缓存')
  await sleep(2500)
  await page.screenshot({ path: OUT + '/loading-shot-mid.png' })
  const s = await page.evaluate(() => {
    const r = document.querySelector('[data-plugin="npm-manager"]')
    return r ? r.innerText.replace(/\s+/g,' ').slice(0, 200) : ''
  })
  console.log('截图时界面: ' + s)
  await sleep(2500)
  await page.screenshot({ path: OUT + '/loading-shot-later.png' })
  const s2 = await page.evaluate(() => {
    const r = document.querySelector('[data-plugin="npm-manager"]')
    return r ? r.innerText.replace(/\s+/g,' ').slice(0, 200) : ''
  })
  console.log('2.5s 后界面: ' + s2)
} finally { await browser.close() }
