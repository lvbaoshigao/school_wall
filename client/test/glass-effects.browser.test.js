import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

test('glass is enabled by default and appearance settings persist solid and frosted surfaces', {
  skip: !process.env.GLASS_QA_URL || !process.env.GLASS_PLAYWRIGHT_MODULE,
  timeout: 120000,
}, async () => {
  const origin = new URL(process.env.GLASS_QA_URL).origin
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname))
  const { chromium } = createRequire(import.meta.url)(process.env.GLASS_PLAYWRIGHT_MODULE)
  const browser = await chromium.launch({ executablePath: process.env.GLASS_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let token, original
  const saveCheckbox = async (locator, checked) => {
    if (await locator.isChecked() === checked) return
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/prefs' && response.request().method() === 'PUT')
    await locator.setChecked(checked)
    assert.equal((await saved).status(), 200, 'wait for the account preference save, not only optimistic CSS')
  }
  const screenshot = async name => {
    if (process.env.GLASS_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.GLASS_SCREENSHOT_DIR, name + '.png'), animations: 'disabled' })
  }
  const surfaces = () => page.evaluate(() => {
    const surface = selector => {
      const style = getComputedStyle(document.querySelector(selector))
      const color = style.backgroundColor.match(/[\d.]+/g).map(Number)
      return { filter: style.backdropFilter || style.webkitBackdropFilter, alpha: color.length > 3 ? color[3] : 1, color: style.backgroundColor }
    }
    return { navbar: surface('.nav-inner'), card: surface('.post-card') }
  })
  try {
    await page.route('**/api/wallpaper', route => route.fulfill({ json: { url: '/rele/4.png' } }))
    await page.goto(origin + '/login', { waitUntil:'networkidle' })
    await page.locator('#login-username').fill(process.env.GLASS_QA_USERNAME)
    await page.locator('#login-password').fill(process.env.GLASS_QA_PASSWORD)
    await page.locator('form button[type=submit]').click()
    await page.waitForURL(url => url.pathname === '/')
    await page.waitForLoadState('networkidle')
    token = await page.evaluate(() => localStorage.getItem('token'))
    const response = await context.request.get(origin + '/api/auth/prefs', { headers: { Authorization:'Bearer '+token } })
    original = (await response.json()).prefs
    assert.equal(original.disable_blur, false, 'the unchanged server default enables glass')
    await page.waitForFunction(() => document.querySelector('.wallpaper-img')?.complete && document.querySelector('.wallpaper-img')?.naturalWidth > 0)
    for (const scheme of ['light','dark']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion:'reduce' })
      await page.waitForFunction(scheme => document.body.classList.contains('light-theme') === (scheme === 'light'), scheme)
      const style = await surfaces()
      for (const surface of Object.values(style)) {
        assert.ok(surface.filter.includes('blur('), scheme + ' frosts the backdrop')
        assert.ok(surface.alpha >= .7 && surface.alpha < .95, scheme + ' keeps visible transparency and readable tint')
      }
      await page.locator('.post-card').first().hover()
      const hovered = await surfaces()
      assert.ok(hovered.card.alpha >= .7 && hovered.card.filter.includes('blur('))
      await page.mouse.move(1430,990)
      await screenshot('glass-'+scheme)
    }
    await page.goto(origin + '/settings?section=appearance', { waitUntil:'networkidle' })
    const toggle = page.getByRole('checkbox', { name:'毛玻璃效果', exact:true })
    assert.equal(await toggle.isChecked(), true)
    await saveCheckbox(toggle, false)
    await page.waitForFunction(() => document.documentElement.dataset.blur === 'off' && getComputedStyle(document.querySelector('.nav-inner')).backdropFilter === 'none')
    await page.waitForFunction(() => !document.querySelector('.settings-center[aria-busy="true"]'))
    assert.equal((await (await context.request.get(origin+'/api/auth/prefs',{headers:{Authorization:'Bearer '+token}})).json()).prefs.disable_blur,true)
    await page.reload({ waitUntil:'networkidle' })
    assert.equal(await toggle.isChecked(), false, 'reload restores the saved solid preference')
    await page.goto(origin+'/',{waitUntil:'networkidle'})
    const solid = await surfaces()
    for(const surface of Object.values(solid)){assert.equal(surface.filter,'none');assert.equal(surface.alpha,1)}
    await screenshot('glass-off')
    await page.setViewportSize({ width:375, height:812 })
    for (const surface of Object.values(await surfaces())) { assert.equal(surface.filter, 'none'); assert.equal(surface.alpha, 1) }
    await page.setViewportSize({ width:1440, height:1000 })
    await page.goto(origin+'/settings?section=appearance',{waitUntil:'networkidle'})
    await saveCheckbox(toggle, true)
    await page.waitForFunction(() => document.documentElement.dataset.blur === 'on' && getComputedStyle(document.querySelector('.nav-inner')).backdropFilter.includes('blur('))
    await page.reload({waitUntil:'networkidle'})
    assert.equal(await toggle.isChecked(),true,'enabled glass persists too')
    await saveCheckbox(page.locator('#setting-high_contrast'), true)
    await page.waitForFunction(() => document.documentElement.dataset.highContrast === 'on')
    assert.equal(await page.locator('.nav-inner').evaluate(e=>getComputedStyle(e).backdropFilter),'none','high contrast uses an opaque fallback')
    await saveCheckbox(page.locator('#setting-high_contrast'), false)
    await page.waitForFunction(() => document.documentElement.dataset.highContrast === 'off')
    const cdp=await context.newCDPSession(page)
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-transparency',value:'reduce'}]})
    assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-transparency: reduce)').matches),true)
    assert.equal(await page.locator('.nav-inner').evaluate(e=>getComputedStyle(e).backdropFilter),'none','system reduced transparency wins over default glass')
    await cdp.send('Emulation.setEmulatedMedia',{features:[]})
    await page.goto(origin+'/',{waitUntil:'networkidle'})
    for(const width of [320,375,768,1024]){
      await page.setViewportSize({width,height:812})
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false)
      assert.ok((await surfaces()).navbar.filter.includes('blur('))
      await page.getByRole('button',{name:'打开菜单',exact:true}).click()
      const mobile=page.getByRole('group',{name:'移动端导航'})
      await mobile.waitFor({state:'visible'})
      assert.ok((await mobile.evaluate(e=>getComputedStyle(e).backdropFilter)).includes('blur('))
      await page.keyboard.press('Escape')
      await page.waitForFunction(()=>!document.querySelector('.mobile-menu'))
    }
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({defaultGlass:true,savedOnAndOff:true,lightAndDark:true,highContrastFallback:true,reducedTransparencyFallback:true,mobileWidths:[320,375,768,1024],runtimeErrors:errors}))
  } finally {
    if(token&&original)await context.request.put(origin+'/api/auth/prefs',{headers:{Authorization:'Bearer '+token},data:{prefs:{disable_blur:original.disable_blur,high_contrast:original.high_contrast}}}).catch(()=>{})
    await context.close();await browser.close()
  }
})
