import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

// 只连接明确指定的本机隔离QA实例，不读取生产配置；默认npm test不会访问网络。
test('settings center browser search mobile controls rollback import and scoped reset', {
  skip: !process.env.SETTINGS_QA_URL || !process.env.SETTINGS_PLAYWRIGHT_MODULE,
  timeout: 120000,
}, async () => {
  const origin = new URL(process.env.SETTINGS_QA_URL).origin
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
  assert.ok(process.env.SETTINGS_QA_USERNAME && process.env.SETTINGS_QA_PASSWORD, 'supply isolated QA credentials explicitly')
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.SETTINGS_PLAYWRIGHT_MODULE)
  const browser = await chromium.launch({ executablePath: process.env.SETTINGS_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, colorScheme: 'light' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let originalChat = null
  let token = ''
  const apiHeaders = () => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' })
  const screenshot = async name => {
    if (process.env.SETTINGS_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SETTINGS_SCREENSHOT_DIR, 'settings-' + name + '.png'), fullPage: true, animations: 'disabled' })
  }
  try {
    const login = await context.request.post(origin + '/api/auth/login', { data: { username: process.env.SETTINGS_QA_USERNAME, password: process.env.SETTINGS_QA_PASSWORD } })
    assert.equal(login.ok(), true)
    token = (await login.json()).token
    const response = await context.request.get(origin + '/api/auth/prefs', { headers: apiHeaders() })
    const initial = (await response.json()).prefs
    originalChat = Object.fromEntries(['chat_send_shortcut', 'chat_density', 'chat_show_timestamps', 'chat_poll_interval'].map(key => [key, initial[key]]))
    await context.addInitScript(value => { localStorage.setItem('token', value) }, token)
    await page.goto(origin + '/settings?section=chat', { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '设置中心', exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '聊天', exact: true }).isVisible(), true)
    assert.equal(await page.getByRole('navigation', { name: '设置分类' }).isVisible(), true)
    await screenshot('desktop')

    const search = page.getByRole('searchbox', { name: '搜索设置', exact: true })
    await search.fill('消息发送')
    await page.getByText('找到 1 项匹配的设置', { exact: true }).waitFor()
    assert.equal(await page.locator('#setting-chat_send_shortcut').isVisible(), true)
    await search.fill('没有匹配项xyz')
    await page.getByRole('heading', { name: '没有找到相关设置' }).waitFor()
    await page.getByRole('button', { name: '清空设置搜索', exact: true }).click()
    assert.equal(await search.inputValue(), '')
    assert.equal(await search.evaluate(element => element === document.activeElement), true)

    const nextDensity = originalChat.chat_density === 'compact' ? 'comfortable' : 'compact'
    const density = page.locator('#setting-chat_density')
    const saved = page.waitForResponse(response => response.url().endsWith('/api/auth/prefs') && response.request().method() === 'PUT')
    await density.selectOption(nextDensity)
    assert.equal((await saved).status(), 200)
    await page.getByText('已保存到账号', { exact: true }).waitFor()
    assert.equal(await density.inputValue(), nextDensity)

    let failNext = true
    await page.route('**/api/auth/prefs', async route => {
      if (route.request().method() === 'PUT' && failNext) { failNext = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离QA保存失败' }) }); return }
      await route.continue()
    })
    await density.selectOption(originalChat.chat_density)
    await page.getByText('隔离QA保存失败', { exact: true }).waitFor()
    assert.equal(await density.inputValue(), nextDensity, 'failed save restores original display value')
    await page.getByRole('button', { name: '重试上次更改', exact: true }).click()
    await page.getByText('已保存到账号', { exact: true }).waitFor()
    assert.equal(await density.inputValue(), originalChat.chat_density)
    await page.unroute('**/api/auth/prefs')

    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 812 })
      assert.equal(await page.locator('#settings-category').isVisible(), true)
      await page.locator('#settings-category').selectOption('appearance')
      await page.getByRole('heading', { name: '外观', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'no horizontal overflow at ' + width)
      await screenshot('mobile-' + width)
    }
    await page.locator('#settings-category').selectOption('data')
    const importButton = page.getByRole('button', { name: '导入偏好 JSON：选择文件', exact: true })
    await importButton.waitFor()
    const file = page.locator('input[type="file"]')
    await file.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'school-wall-preferences', version: 1, prefs: { token: 'must-not-import' } })) })
    await page.getByText('包含不支持的偏好：token', { exact: true }).waitFor()
    const input = { format: 'school-wall-preferences', version: 1, prefs: { chat_show_timestamps: !originalChat.chat_show_timestamps } }
    await file.setInputFiles({ name: 'preferences.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)) })
    const dialog = page.getByRole('dialog', { name: '导入 1 项偏好', exact: true })
    await dialog.waitFor()
    assert.equal(await dialog.getByText('显示聊天时间', { exact: true }).isVisible(), true)
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
    await page.getByText('已保存到账号', { exact: true }).waitFor()
    const imported = await context.request.get(origin + '/api/auth/prefs', { headers: apiHeaders() })
    assert.equal((await imported.json()).prefs.chat_show_timestamps, !originalChat.chat_show_timestamps)

    await page.getByRole('button', { name: '恢复默认偏好：选择范围', exact: true }).click()
    await page.locator('#reset-scope').selectOption('chat')
    await page.getByRole('button', { name: '继续确认', exact: true }).click()
    const resetDialog = page.getByRole('dialog', { name: '恢复聊天', exact: true })
    await resetDialog.waitFor()
    const reset = page.waitForResponse(response => response.url().endsWith('/api/auth/prefs/reset'))
    await resetDialog.getByRole('button', { name: '恢复默认', exact: true }).click()
    assert.deepEqual((await reset).request().postDataJSON(), { scope: 'chat' })
    await page.getByText('已保存到账号', { exact: true }).waitFor()
    const finalResponse = await context.request.get(origin + '/api/auth/prefs', { headers: apiHeaders() })
    const final = (await finalResponse.json()).prefs
    assert.equal(final.chat_density, 'comfortable'); assert.equal(final.chat_show_timestamps, true)
    assert.equal(final.default_anonymous_post, initial.default_anonymous_post, 'chat reset does not modify publishing defaults')
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error(JSON.stringify({ url: page.url(), browserErrors: errors, visibleText: (await page.locator('body').innerText().catch(() => '')).slice(-1500) }))
    await screenshot('failure')
    throw error
  } finally {
    if (originalChat && token) await context.request.put(origin + '/api/auth/prefs', { headers: apiHeaders(), data: { prefs: originalChat } })
    await browser.close()
  }
})
