import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

test('visible wallpapers neutral surfaces symmetric navigation and scale menus', {
  skip: !process.env.VISUAL_QA_URL || !process.env.VISUAL_PLAYWRIGHT_MODULE,
  timeout: 120000,
}, async () => {
  const origin = new URL(process.env.VISUAL_QA_URL).origin
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.VISUAL_PLAYWRIGHT_MODULE)
  const browser = await chromium.launch({ executablePath: process.env.VISUAL_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'no-preference' })
  const page = await context.newPage()
  const errors = []
  await page.addInitScript(() => {
    window.__navMotion = []
    document.addEventListener('transitionrun', event => {
      const key = event.target.id || (event.target.classList?.contains('mobile-menu') ? 'mobile-menu' : '')
      if (key) window.__navMotion.push({ key, property: event.propertyName })
    })
  })
  const assertScaleMotion = async key => {
    await page.waitForFunction(key => window.__navMotion.some(event => event.key === key && event.property === 'scale'), key)
    const properties = await page.evaluate(key => window.__navMotion.filter(event => event.key === key).map(event => event.property), key)
    assert.ok(!properties.includes('translate'), key + ' scales without sliding')
  }
  page.on('pageerror', error => errors.push(error.message))
  const screenshot = async name => {
    if (process.env.VISUAL_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.VISUAL_SCREENSHOT_DIR, name + '.png'), animations: 'disabled' })
  }
  let token = '', originalPrefs
  const auth = () => ({ Authorization: 'Bearer ' + token })
  try {
    await page.goto(origin + '/login', { waitUntil: 'networkidle' })
    await page.locator('#login-username').fill(process.env.VISUAL_QA_USERNAME)
    await page.locator('#login-password').fill(process.env.VISUAL_QA_PASSWORD)
    await page.locator('form button[type=submit]').click()
    await page.waitForURL(url => url.pathname === '/')
    await page.waitForLoadState('networkidle')
    token = await page.evaluate(() => localStorage.getItem('token'))
    const prefResponse = await context.request.get(origin + '/api/auth/prefs', { headers: auth() })
    originalPrefs = (await prefResponse.json()).prefs
    await page.waitForFunction(() => {
      const image = document.querySelector('.wallpaper-img')
      return image?.complete && image.naturalWidth > 0 && Number(getComputedStyle(document.querySelector('.bg-wallpaper')).opacity) > .99
    })
    const geometry = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom } }
      return { nav: box('.nav-inner'), search: box('.nav-center'), heading: box('.home-topbar'), left: box('.category-sidebar'), right: box('.wall-sidebar'), feed: box('.posts-area'), imageOpacity: getComputedStyle(document.querySelector('.wallpaper-img')).opacity, filter: getComputedStyle(document.querySelector('.wallpaper-img')).filter, background: getComputedStyle(document.body).backgroundColor }
    })
    assert.equal(Number(geometry.imageOpacity), 1)
    assert.ok(!geometry.filter.includes('blur'))
    assert.ok(geometry.heading.y - geometry.nav.bottom >= 34)
    assert.ok(Math.abs(geometry.left.width - geometry.right.width) < 1)
    assert.ok(Math.abs(geometry.feed.x + geometry.feed.width / 2 - 720) < 1)
    assert.ok(Math.abs(geometry.search.x + geometry.search.width / 2 - 720) < 1)
    assert.deepEqual(geometry.background.match(/\d+/g).map(Number), [244, 243, 245])
    await page.locator('.post-card').first().hover()
    const cardAlpha = await page.locator('.post-card').first().evaluate(element => {
      const parts = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).map(Number)
      return parts.length === 4 ? parts[3] : 1
    })
    assert.ok(cardAlpha >= .9, 'hover keeps an opaque reading surface over the image')
    await page.mouse.move(1430, 990)
    await screenshot('refined-light')

    for (const [trigger, selector] of [
      ['.wall-btn', '#nav-wall-menu'],
      ['[aria-controls="nav-menu-publish"]', '#nav-menu-publish'],
      ['[aria-controls="nav-more-menu"]', '#nav-more-menu'],
      ['[aria-controls="nav-account-menu"]', '#nav-account-menu'],
    ]) {
      const button = page.locator('.desktop-only ' + trigger).first()
      const actualTrigger = await button.count() ? button : page.locator(trigger).first()
      await page.evaluate(() => { window.__navMotion = [] })
      await actualTrigger.click()
      const menu = page.locator(selector)
      await menu.waitFor({ state: 'visible' })
      await assertScaleMotion(selector.slice(1))
      await actualTrigger.press('ArrowDown')
      assert.ok(await menu.evaluate(element => element.contains(document.activeElement)))
      await page.keyboard.press('Escape')
      await page.waitForFunction(selector => !document.querySelector(selector), selector)
      assert.equal(await actualTrigger.evaluate(element => document.activeElement === element), true)
    }
    await page.evaluate(() => { window.__navMotion = [] })
    await page.locator('.nav-search input').focus()
    await page.locator('#nav-search-panel').waitFor({ state: 'visible' })
    await assertScaleMotion('nav-search-panel')
    await page.waitForFunction(() => !document.querySelector('#nav-search-panel').getAnimations().some(animation => animation.playState === 'running'))
    const searchMenu = await page.locator('#nav-search-panel').boundingBox()
    assert.ok(Math.abs(searchMenu.x + searchMenu.width / 2 - 720) < 1, 'scale keeps the translated search panel centered')
    await page.keyboard.press('Escape')

    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => !document.body.classList.contains('light-theme'))
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(23, 24, 28)')
    await page.mouse.move(1430, 990)
    await screenshot('refined-dark')

    for (const width of [320, 375, 768, 1024]) {
      await page.setViewportSize({ width, height: 812 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      const gap = await page.evaluate(() => document.querySelector('.home-topbar').getBoundingClientRect().top - document.querySelector('.nav-inner').getBoundingClientRect().bottom)
      assert.ok(gap >= 22)
      const toggle = page.getByRole('button', { name: '打开菜单', exact: true })
      await page.evaluate(() => { window.__navMotion = [] })
      await toggle.click()
      const menu = page.getByRole('group', { name: '移动端导航' })
      await menu.waitFor({ state: 'visible' })
      await assertScaleMotion(await menu.getAttribute('id') || 'mobile-menu')
      for (const text of ['投票', '树洞', '收藏']) assert.ok(await menu.getByRole('button', { name: new RegExp(text) }).count())
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('.mobile-menu'))
      assert.equal(await toggle.evaluate(element => document.activeElement === element), true)
    }
    await screenshot('refined-mobile')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(origin + '/settings?section=appearance', { waitUntil: 'networkidle' })
    const wallpaper = page.locator('#setting-wallpaper_enabled')
    await wallpaper.uncheck()
    await page.waitForFunction(() => !document.querySelector('.bg-wallpaper'))
    const neutral = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const previousAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-1'))
    await page.locator('#setting-accent').selectOption(originalPrefs.accent === 'amber' ? 'teal' : 'amber')
    await page.waitForFunction(value => getComputedStyle(document.documentElement).getPropertyValue('--accent-1') !== value, previousAccent)
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), neutral, 'accent changes do not force a green page background')
    await wallpaper.check()
    await page.waitForFunction(() => document.querySelector('.wallpaper-img')?.complete && document.querySelector('.wallpaper-img')?.naturalWidth > 0)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('.wall-btn').click()
    const duration = await page.locator('#nav-wall-menu').evaluate(element => getComputedStyle(element).transitionDuration)
    assert.ok(duration.split(',').every(value => parseFloat(value) <= .01), 'reduced motion skips menu scaling')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ wallpaperLoaded: true, neutralThemes: true, equalSidebars: true, centeredSearch: true, gap: geometry.heading.y - geometry.nav.bottom, mobileWidths: [320,375,768,1024], scaleMenus: true, runtimeErrors: errors }))
  } finally {
    if (token && originalPrefs) await context.request.put(origin + '/api/auth/prefs', { headers: auth(), data: { prefs: { wallpaper_enabled: originalPrefs.wallpaper_enabled, accent: originalPrefs.accent } } }).catch(() => {})
    await context.close()
    await browser.close()
  }
})
