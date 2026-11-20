import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 只连接显式指定的隔离 QA 实例；默认 npm test 不访问网络或真实数据。
test('shared UI browser navigation, modal and image accessibility regressions', {
  skip: !process.env.FOUNDATION_QA_URL,
  timeout: 90000,
}, async () => {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.FOUNDATION_QA_URL).hostname), 'browser regressions require a local isolated QA instance')
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.FOUNDATION_PLAYWRIGHT_MODULE || 'playwright-core')
  const { build } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const browser = await chromium.launch({ executablePath: process.env.FOUNDATION_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const errors = []
  let storageState
  let activePage
  const contexts = []
  const screenshot = async (page, name) => {
    if (process.env.FOUNDATION_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.FOUNDATION_SCREENSHOT_DIR, 'foundation-' + name + '.png'), fullPage: !/dialog|lightbox/.test(name), animations: 'disabled' })
  }
  try {
    for (const [name, width, height, colorScheme] of [['home-desktop', 1440, 1000, 'light'], ['home-mobile', 375, 812, 'light'], ['home-midwidth', 1140, 900, 'light'], ['home-dark', 1440, 1000, 'dark']]) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme, storageState })
      contexts.push(context)
      const page = await context.newPage()
      activePage = page
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(process.env.FOUNDATION_QA_URL, { waitUntil: 'networkidle' })
      if (!storageState && process.env.FOUNDATION_QA_USERNAME) {
        await page.locator('#login-username').fill(process.env.FOUNDATION_QA_USERNAME)
        await page.locator('#login-password').fill(process.env.FOUNDATION_QA_PASSWORD || '')
        await page.locator('form button[type="submit"]').click()
        await page.waitForURL(url => url.pathname === '/')
        await page.locator('.wall-btn').waitFor()
        await page.waitForLoadState('networkidle')
        storageState = await context.storageState()
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
      assert.equal(overflow, false, name + ' has no horizontal overflow')
      if (storageState) {
        if (width < 1121) {
          const trigger = page.getByRole('button', { name: '打开菜单', exact: true })
          await trigger.click()
          await page.getByRole('group', { name: '移动端导航' }).waitFor()
          await screenshot(page, 'mobile-menu')
          assert.equal(await page.getByRole('button', { name: '个人主页', exact: true }).isVisible(), true)
          await page.keyboard.press('Escape')
          assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
        } else {
          const trigger = page.getByRole('button', { name: '账号菜单', exact: true })
          await trigger.click()
          await page.keyboard.press('ArrowDown')
          assert.equal(await page.locator('#nav-account-menu button').first().evaluate(element => element === document.activeElement), true)
          await page.keyboard.press('Escape')
          assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
          if (width === 1140) assert.equal(await page.getByRole('searchbox', { name: '搜索帖子', exact: true }).isVisible(), true, 'centered search remains available at intermediate desktop width')
        }
      }
      await screenshot(page, name)
      await page.locator('.skip-link').focus()
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('main').evaluate(element => element === document.activeElement), true, 'skip link focuses main content')
    }
    const page = activePage
    await page.setViewportSize({ width: 1440, height: 1000 })
    if (storageState) {
      let markReadRequests = 0
      const requestListener = request => { if (request.url().endsWith('/api/messages/read-all') && request.method() === 'PUT') markReadRequests++ }
      page.on('request', requestListener)
      await page.route('**/api/announcements', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA unavailable' }) }))
      const trigger = page.getByRole('button', { name: '公告', exact: true })
      await trigger.click()
      await page.getByText('公告加载失败，请检查网络后重试', { exact: true }).waitFor()
      assert.equal(markReadRequests, 0, 'failed announcement load does not mark messages as read')
      await screenshot(page, 'announcement-error')
      await page.unroute('**/api/announcements')
      await page.getByRole('dialog', { name: '公告', exact: true }).getByRole('button', { name: '重试', exact: true }).click()
      await page.getByText('暂无公告', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
      page.off('request', requestListener)
    }
    const fixtureImages = ['#397d72', '#2d655c'].map(color => 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="' + color + '"/></svg>').toString('base64'))
    const fixture = [
      'import { createApp, h, ref } from "vue";',
      'import ConfirmModal from ' + JSON.stringify(path.join(root, 'src/components/ConfirmModal.vue')) + ';',
      'import Lightbox from ' + JSON.stringify(path.join(root, 'src/components/Lightbox.vue')) + ';',
      'import SkeletonCard from ' + JSON.stringify(path.join(root, 'src/components/SkeletonCard.vue')) + ';',
      'const mount=document.createElement("div"); mount.id="foundation-harness"; document.body.append(mount);',
      'const images=' + JSON.stringify(fixtureImages) + ';',
      'createApp({setup(){const show=ref(false),prompt=ref(false),lightbox=ref(null);return()=>h("div",[h("button",{id:"foundation-open",onClick:()=>{prompt.value=false;show.value=true}},"测试确认窗口"),h("button",{id:"foundation-prompt",onClick:()=>{prompt.value=true;show.value=true}},"测试输入窗口"),h(ConfirmModal,{show:show.value,"onUpdate:show":v=>show.value=v,title:"基础组件确认测试",message:"仅用于隔离的浏览器验证",prompt:prompt.value,promptPlaceholder:"测试输入"},{default:()=>h("button",{id:"foundation-image",onClick:()=>lightbox.value.open()},"打开嵌套图片")}),h(Lightbox,{ref:lightbox,images}),h(SkeletonCard)])}}).mount(mount);'
    ].join('\n')
    const built = await build({ configFile: false, root, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, plugins: [vue(), { name: 'foundation-virtual-fixture', resolveId(id) { if (id === 'foundation-fixture' || id === path.join(root, 'foundation-fixture')) return '\0foundation-fixture' }, load(id) { if (id === '\0foundation-fixture') return fixture } }], build: { write: false, minify: false, lib: { entry: 'foundation-fixture', name: 'FoundationFixture', formats: ['iife'] } }, logLevel: 'silent' })
    const output = (Array.isArray(built) ? built[0] : built).output
    for (const item of output) {
      if (item.type === 'asset' && item.fileName.endsWith('.css')) await page.addStyleTag({ content: String(item.source) })
      if (item.type === 'chunk') {
        const scriptURL = new URL('/__foundation-browser-fixture.js', process.env.FOUNDATION_QA_URL).href
        await page.route(scriptURL, route => route.fulfill({ contentType: 'text/javascript', body: item.code }))
        await page.addScriptTag({ url: scriptURL })
        await page.unroute(scriptURL)
      }
    }
    assert.deepEqual(errors, [], 'fixture loads without browser runtime errors')
    const opener = page.locator('#foundation-open')
    await opener.click()
    const confirm = page.getByRole('dialog', { name: '基础组件确认测试', exact: true })
    await confirm.waitFor()
    assert.equal(await confirm.getByRole('button', { name: '取消', exact: true }).evaluate(element => element === document.activeElement), true, 'safe action receives initial focus')
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.equal(await confirm.evaluate(element => element.contains(document.activeElement)), true) }
    await screenshot(page, 'confirm-dialog')
    await confirm.locator('#foundation-image').click()
    const lightbox = page.getByRole('dialog', { name: '图片预览', exact: true })
    await lightbox.waitFor()
    assert.equal(await lightbox.getByRole('button', { name: '关闭图片', exact: true }).evaluate(element => element === document.activeElement), true)
    await page.keyboard.press('ArrowRight')
    assert.equal(await lightbox.getByRole('img').getAttribute('alt'), '第 2 张图片，共 2 张')
    await screenshot(page, 'nested-lightbox')
    await page.keyboard.press('Escape')
    await lightbox.waitFor({ state: 'hidden' })
    assert.equal(await confirm.isVisible(), true)
    assert.equal(await page.locator('#foundation-image').evaluate(element => element === document.activeElement), true)
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden')
    await page.keyboard.press('Escape')
    await confirm.waitFor({ state: 'hidden' })
    assert.equal(await opener.evaluate(element => element === document.activeElement), true)
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden')
    await page.locator('#foundation-prompt').click()
    assert.equal(await confirm.getByRole('textbox', { name: '测试输入', exact: true }).evaluate(element => element === document.activeElement), true, 'prompt has a name and receives focus')
    await page.keyboard.press('Escape')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await page.locator('#foundation-harness .shimmer').first().evaluate(element => getComputedStyle(element, '::after').animationName), 'none')
    assert.deepEqual(errors, [], 'no browser runtime errors')
    console.log('Browser checks passed: 375/1140/1440px, light/dark, nav Escape/ArrowDown, skip link, announcement retry, modal Tab/return, nested image Escape/scroll lock, labelled prompt, reduced motion')
  } finally { for (const context of contexts) await context.close(); await browser.close() }
})
