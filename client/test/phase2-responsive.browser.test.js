import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

// 显式 opt-in，限定本机隔离实例；只读已有样本，不创建产品数据。
test('phase2 real responsive screens, persisted theme and visible keyboard viewport', {
  skip: !process.env.PHASE2_QA_URL,
  timeout: 120000,
}, async () => {
  const url = new URL(process.env.PHASE2_QA_URL)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PHASE2_PLAYWRIGHT_MODULE || 'playwright-core')
  const browser = await chromium.launch({ executablePath: process.env.PHASE2_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const contexts = [], errors = [], findings = []
  const screenshot = async (page, name) => {
    if (process.env.PHASE2_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PHASE2_SCREENSHOT_DIR, 'responsive-' + name + '.png'), fullPage: false, animations: 'disabled' })
  }
  try {
    const authContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }); contexts.push(authContext)
    const auth = await authContext.newPage()
    await auth.goto(new URL('/login', url).href, { waitUntil: 'networkidle' })
    await auth.locator('#login-username').fill(process.env.PHASE2_QA_USERNAME || '')
    await auth.locator('#login-password').fill(process.env.PHASE2_QA_PASSWORD || '')
    await auth.locator('form button[type="submit"]').click()
    await auth.waitForURL(value => value.pathname === '/')
    await auth.waitForLoadState('networkidle')
    const storageState = await authContext.storageState()
    const privateChatPath = '/chat/' + (process.env.PHASE2_QA_CHAT_ID || '2')
    const postId = await auth.evaluate(async () => {
      const response = await fetch('/api/posts', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'X-Wall-Id': '1' } })
      const data = await response.json()
      return response.ok && Array.isArray(data.posts) ? data.posts[0]?.id : null
    })
    const routes = ['/', '/settings', '/votes', ...(postId ? ['/post/' + postId] : []), privateChatPath, '/tree-hole/chat/phase2-tree-1']
    for (const [width, height] of [[320, 740], [360, 800], [390, 844], [768, 1024], [1024, 768], [844, 390]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 769, hasTouch: true, storageState }); contexts.push(context)
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      for (const route of routes) {
        await page.goto(new URL(route, url).href, { waitUntil: 'networkidle' })
        const fontScale = await page.evaluate(() => document.documentElement.dataset.fontScale)
        const testSmallFont = width === 320
        if (testSmallFont) await page.evaluate(() => { document.documentElement.dataset.fontScale = 'sm' })
        const state = await page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyOverflow: getComputedStyle(document.body).overflowX,
          overflow: [...document.querySelectorAll('main *, nav *')].filter(element => {
            if (!element.getClientRects().length) return false
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
            return style.position !== 'fixed' && (rect.right > innerWidth + 1 || rect.left < -1)
          }).slice(0, 6).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent.slice(0, 40) })),
          shortTargets: [...document.querySelectorAll('main button, nav button')].filter(element => {
            const rect = element.getBoundingClientRect(); return rect.width && rect.height && (rect.height < 43.5 || rect.width < 43.5)
          }).map(element => ({ className: element.className, height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width, text: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 25) })),
        }))
        findings.push({ width, height, route, ...state })
        assert.ok(state.scrollWidth <= state.width + 1, JSON.stringify({ route, width, ...state }))
        assert.notEqual(state.bodyOverflow, 'hidden', 'body does not conceal layout overflow')
        assert.equal(state.shortTargets.length, 0, '44px touch targets: ' + JSON.stringify({ width, route, targets: [...new Map(state.shortTargets.map(item => [item.className + item.text, item])).values()] }))
        if (route === '/settings') assert.equal(await page.locator('.fab-root').count(), 0, 'floating publish cannot cover settings controls')
        if (route.includes('/chat/')) {
          assert.equal(await page.locator('main').getAttribute('class').then(value => value.includes('main-conversation')), true)
          assert.equal(await page.locator('.fab-root').count(), 0)
          const textarea = page.locator('textarea').last()
          await textarea.waitFor()
          const rect = await textarea.boundingBox()
          assert.ok(rect.y >= 0 && rect.y + rect.height <= height + 1, 'composer remains inside visible screen: ' + JSON.stringify({ route, width, height, rect }))
        }
        if (width === 320 || (width === 844 && height === 390)) await screenshot(page, width + '-' + route.replaceAll('/', '-'))
        if (testSmallFont) await page.evaluate(previous => { if (previous === undefined) delete document.documentElement.dataset.fontScale; else document.documentElement.dataset.fontScale = previous }, fontScale)
      }
      await page.goto(new URL('/settings', url).href, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '打开菜单', exact: true }).click()
      const menu = page.getByRole('group', { name: '移动端导航' })
      const box = await menu.boundingBox()
      assert.ok(box.y + box.height <= height + 1, 'mobile menu fits landscape visual viewport')
      await page.keyboard.press('Escape')
      assert.equal(await page.getByRole('button', { name: '打开菜单', exact: true }).evaluate(element => element === document.activeElement), true)
    }
    const keyboardContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState }); contexts.push(keyboardContext)
    const keyboard = await keyboardContext.newPage()
    keyboard.on('pageerror', error => errors.push(error.message))
    await keyboard.goto(new URL(privateChatPath, url).href, { waitUntil: 'networkidle' })
    await keyboard.locator('textarea').last().focus()
    await keyboard.evaluate(() => {
      for (const [name, value] of Object.entries({ height: 390, width: 390, offsetTop: 24, scale: 1 })) Object.defineProperty(window.visualViewport, name, { configurable: true, value })
      window.dispatchEvent(new Event('resize'))
    })
    await keyboard.waitForFunction(() => document.documentElement.dataset.keyboardOpen === 'on')
    const keyboardRect = await keyboard.locator('textarea').last().boundingBox()
    assert.ok(keyboardRect.y + keyboardRect.height <= 415, 'composer tracks measured visual viewport')
    await screenshot(keyboard, 'keyboard-viewport')
    await keyboard.evaluate(() => { Object.defineProperty(window.visualViewport, 'scale', { configurable: true, value: 2 }); window.dispatchEvent(new Event('resize')) })
    await keyboard.waitForFunction(() => document.documentElement.dataset.keyboardOpen === 'off')
    const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' }); contexts.push(guestContext)
    const guest = await guestContext.newPage()
    let guestPreferenceWrites = 0
    guest.on('request', request => { if (request.url().includes('/api/auth/prefs') && request.method() === 'PUT') guestPreferenceWrites++ })
    await guest.goto(new URL('/login', url).href, { waitUntil: 'networkidle' })
    assert.equal(await guest.locator('body').evaluate(element => element.classList.contains('light-theme')), true)
    assert.ok((await guest.locator('nav .logo').boundingBox()).height >= 44, 'brand navigation has a full touch target')
    await guest.emulateMedia({ colorScheme: 'dark' })
    await guest.waitForFunction(() => !document.body.classList.contains('light-theme'))
    await guest.getByRole('button', { name: '切换亮色主题', exact: true }).click()
    await guest.waitForFunction(() => document.body.classList.contains('light-theme'))
    assert.equal(await guest.evaluate(() => localStorage.getItem('theme_mode')), 'light')
    await guest.reload({ waitUntil: 'networkidle' })
    assert.equal(await guest.locator('body').evaluate(element => element.classList.contains('light-theme')), true, 'explicit guest theme survives reload and OS dark')
    assert.equal(guestPreferenceWrites, 0)
    assert.deepEqual(errors, [])
    const shortTargets = findings.filter(value => value.shortTargets.length).map(({ width, height, route, shortTargets }) => ({ width, height, route, shortTargets: [...new Map(shortTargets.map(item => [item.className + ':' + item.height + ':' + item.text, item])).values()] }))
    console.log(JSON.stringify({ checkedScreens: findings.length, widths: [320, 360, 390, 768, 1024], landscape: '844x390', shortTargets, keyboard: keyboardRect, runtimeErrors: errors }, null, 2))
  } finally { for (const context of contexts) await context.close(); await browser.close() }
})
