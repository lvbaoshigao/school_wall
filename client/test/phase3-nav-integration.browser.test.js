import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Opt in only against an explicitly supplied isolated loopback build. Never build or start a service.
const artifactDirectory = process.env.PHASE3_NAV_ARTIFACT_DIR || path.join(os.tmpdir(), 'school-wall-nav-qa')
const navigationKeys = ['home', 'publish', 'search', 'votes', 'chat', 'inbox', 'treehole', 'bookmarks', 'help', 'theme', 'wallpaper']
const directLabels = ['主页', '投票', '聊天', '收件箱', '树洞', '收藏']
const coreLabels = ['主页', '聊天', '收件箱']
const moreLabels = ['投票', '树洞', '收藏', '倾诉', '举报']
const destinations = [
  ['主页', '/'], ['投票', '/votes', 'more'], ['聊天', '/chat'], ['收件箱', '/inbox'], ['树洞', '/tree-hole/list', 'more'], ['收藏', '/bookmarks', 'more'],
  ['发帖', '/post/create', 'publish'], ['表白', '/confession/write', 'publish'], ['发起投票', '/vote/create', 'publish'],
  ['倾诉', '/help/counseling', 'more'], ['举报', '/help/report', 'more'],
  ['个人主页', '/profile', 'account'], ['设置', '/settings', 'account'], ['管理后台', '/admin', 'account'],
]

test('phase3 long capsule real geometry, full entries, keyboard, breakpoints and chat viewport', {
  skip: !process.env.PHASE3_NAV_QA_URL, timeout: 420000,
}, async t => {
  const base = new URL(process.env.PHASE3_NAV_QA_URL)
  assert.ok(['http:', 'https:'].includes(base.protocol))
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Only explicit loopback QA is allowed')
  assert.equal(base.username + base.password, '', 'Do not put credentials in the URL')
  assert.ok(process.env.PHASE3_NAV_QA_USERNAME)
  assert.ok(process.env.PHASE3_NAV_QA_PASSWORD)
  const peer = process.env.PHASE3_NAV_QA_CHAT_ID || '2'
  assert.match(peer, /^[1-9][0-9]*$/)
  const chatPath = '/chat/' + peer
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PHASE3_NAV_PLAYWRIGHT_MODULE || 'playwright-core')
  await fs.mkdir(artifactDirectory, { recursive: true })
  const previousTmp = process.env.TMPDIR
  process.env.TMPDIR = artifactDirectory
  const browser = await chromium.launch({ executablePath: process.env.PHASE3_NAV_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const contexts = []
  const report = { cases: [], measurements: [], runtimeErrors: [], failedResponses: [], prohibitedWrites: [], screenshots: [], keyboardViewportSimulation: false }
  let storageState, originalTheme, restorePage, activePage
  const surfaceByTheme = {}
  const slug = value => value.replace(/[^A-Za-z0-9_-]+/g, '-')
  async function shot(page, label) {
    const file = path.join(artifactDirectory, slug(label) + '.png')
    await page.screenshot({ path: file, fullPage: false, animations: 'disabled' })
    report.screenshots.push(file)
  }
  function observe(page) {
    activePage = page
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => report.runtimeErrors.push(error.message))
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin === base.origin && url.pathname.startsWith('/api/') && (response.status() >= 500 || response.status() === 429)) report.failedResponses.push({ path: url.pathname, status: response.status() })
    })
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== base.origin || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) return
      const allowed = url.pathname === '/api/auth/login' || url.pathname === '/api/auth/prefs' || url.pathname.startsWith('/api/messages/read-')
      if (!allowed) report.prohibitedWrites.push({ method: request.method(), path: url.pathname })
    })
  }
  async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
  async function loaded(page) { await page.locator('nav[aria-label="主导航"] .nav-inner').waitFor(); await page.locator('.wall-btn').waitFor(); await settle(page) }
  async function goto(page, route) {
    await page.goto(new URL(route, base).href, { waitUntil: 'networkidle' })
    assert.equal(new URL(page.url()).pathname, route, 'Seeded route loads without an authentication/permission redirect')
    await loaded(page)
  }
  async function setTheme(page, theme) {
    const current = await page.locator('body').evaluate(body => body.classList.contains('light-theme') ? 'light' : 'dark')
    if (current !== theme) {
      if (await page.locator('.mobile-menu-btn').isVisible()) {
        await page.getByRole('button', { name: '打开菜单', exact: true }).click()
        await page.locator('#nav-mobile-panel').getByRole('button', { name: theme === 'light' ? '切换亮色' : '切换暗色', exact: true }).click()
        await page.keyboard.press('Escape')
      } else await page.getByRole('button', { name: theme === 'light' ? '切换亮色主题' : '切换暗色主题', exact: true }).click()
      await page.waitForFunction(want => document.body.classList.contains('light-theme') === (want === 'light'), theme)
      await page.waitForFunction(() => ![...document.querySelectorAll('nav button')].some(button => button.disabled && (button.getAttribute('aria-label') || '').includes('主题')))
    }
    await settle(page)
  }
  async function font(page, mode) {
    await page.evaluate(value => {
      document.documentElement.style.removeProperty('font-size')
      document.documentElement.dataset.fontScale = value === 'large' ? 'lg' : 'md'
      if (value === 'text200') document.documentElement.style.setProperty('font-size', '32px', 'important')
    }, mode)
    await settle(page)
  }
  async function geometry(page, label, { desktop = false, touch = false } = {}) {
    const state = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="主导航"]'), shell = nav.querySelector('.nav-inner')
      const box = element => { const r=element.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom } }
      const visible = element => !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'
      const elements=[...shell.querySelectorAll('button,a,input')].filter(visible)
      const controls=elements.map(element=>({label:element.getAttribute('aria-label')||element.textContent.trim(),tag:element.tagName,box:box(element)}))
      const clipped=elements.filter(element=>{const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !hit||!(hit===element||element.contains(hit))}).map(element=>element.getAttribute('aria-label')||element.textContent.trim())
      const overflow=[...nav.querySelectorAll('.nav-inner,.nav-left,.nav-right,.nav-center,button,a,input')].filter(visible).filter(element=>{const r=element.getBoundingClientRect();return r.left < -1 || r.right > document.documentElement.clientWidth+1}).map(element=>({className:element.className,box:box(element)}))
      const style=getComputedStyle(shell)
      return {viewport:{width:innerWidth,height:innerHeight},shell:box(shell),radius:parseFloat(style.borderTopLeftRadius),shellOverflow:style.overflow,railBackground:getComputedStyle(nav).backgroundColor,shellBackground:style.backgroundColor,fontSize:getComputedStyle(document.documentElement).fontSize,bodyOverflow:getComputedStyle(document.body).overflowX,docWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,controls,clipped,overflow}
    })
    report.measurements.push({label,...state})
    assert.ok(Math.abs(state.shell.x-(state.docWidth-state.shell.width)/2)<=1,label+': centered capsule')
    assert.ok(state.shell.x>=7 && state.docWidth-state.shell.right>=7,label+': outer whitespace')
    assert.ok(state.shell.y>=6,label+': top gap')
    assert.ok(state.scrollWidth<=state.docWidth+1,label+': no document horizontal overflow')
    assert.notEqual(state.bodyOverflow,'hidden',label+': body does not conceal overflow')
    assert.deepEqual(state.overflow,[],label+': navigation inside viewport')
    assert.deepEqual(state.clipped,[],label+': every visible control is hit-testable')
    assert.equal(state.shellOverflow,'visible',label+': no clipping of dropdowns/focus rings')
    if(desktop){assert.ok(Math.abs(state.shell.width-1180)<=2,label+': approximately 1180px on every route');assert.ok(state.radius>=state.shell.height/2,label+': full pill ends');assert.ok(state.shell.width/state.shell.height>=14,label+': long pill proportions')}
    else assert.ok(state.radius>=20,label+': rounded mobile capsule')
    if(touch)assert.deepEqual(state.controls.filter(control=>control.tag!=='INPUT'&&(control.box.width<43.5||control.box.height<43.5)),[],label+': 44px navigation touch targets')
    return state
  }
  async function hitTestMenu(page,selector,label){
    const menu=page.locator(selector);await menu.waitFor({state:'visible'})
    const rect=await menu.boundingBox(),viewport=page.viewportSize()
    assert.ok(rect.x>=-1 && rect.x+rect.width<=viewport.width+1,label+': panel horizontal fit')
    assert.ok(rect.y>=0 && rect.y+rect.height<=viewport.height+1,label+': panel vertical fit')
    const buttons=menu.locator('button');assert.ok(await buttons.count()>0,label+': actual menu controls')
    for(let index=0;index<await buttons.count();index++){
      const button=buttons.nth(index);await button.scrollIntoViewIfNeeded()
      const evidence=await button.evaluate(element=>{const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {width:r.width,height:r.height,hit:!!hit&&(hit===element||element.contains(hit)),label:element.textContent.trim()}})
      assert.ok(evidence.width>=43.5&&evidence.height>=43.5,label+': 44px menu target '+JSON.stringify(evidence));assert.equal(evidence.hit,true,label+': menu item not clipped '+JSON.stringify(evidence))
    }
  }
  async function keyboardDropdown(page,selector,label){
    const trigger=page.locator(selector);await trigger.focus();await trigger.press('Enter')
    assert.equal(await trigger.getAttribute('aria-expanded'),'true',label+': Enter opens')
    const panel='#'+await trigger.getAttribute('aria-controls');await hitTestMenu(page,panel,label)
    await trigger.focus();await page.keyboard.press('ArrowDown')
    const first=page.locator(panel+' button').first()
    assert.equal(await first.evaluate(element=>element===document.activeElement),true,label+': ArrowDown enters first item')
    const outline=await first.evaluate(element=>({style:getComputedStyle(element).outlineStyle,width:parseFloat(getComputedStyle(element).outlineWidth)}))
    assert.ok(outline.style!=='none'&&outline.width>=1,label+': visible keyboard focus')
    await page.keyboard.press('Escape');await page.locator(panel).waitFor({state:'hidden'})
    assert.equal(await trigger.evaluate(element=>element===document.activeElement),true,label+': Escape restores focus')
  }
  async function mobileMenu(page,label){
    const trigger=page.getByRole('button',{name:'打开菜单',exact:true});await trigger.focus();await trigger.press('Enter');await hitTestMenu(page,'#nav-mobile-panel',label)
    const menu=page.locator('#nav-mobile-panel')
    for(const text of [...directLabels,'发帖','表白','发起投票','倾诉','举报','搜索','设置','个人主页','管理后台','运行看板','换壁纸','公告','加入 / 申请建墙','退出登录'])assert.ok(await menu.getByRole('button',{name:new RegExp('^'+text)}).count()>0,label+': entry '+text+' retained')
    await menu.locator('button').last().focus();await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'})
    assert.equal(await trigger.evaluate(element=>element===document.activeElement),true,label+': mobile Escape restores focus')
  }
  async function navigate(page,route){
    if(new URL(page.url()).pathname===route)return
    if(await page.locator('.mobile-menu-btn').isVisible()){await page.getByRole('button',{name:'打开菜单',exact:true}).click();await page.locator('#nav-mobile-panel').getByRole('button',{name:route==='/'?'主页':'设置',exact:true}).click()}
    else if(route==='/settings'){await page.locator('.avatar-btn').click();await page.locator('#nav-account-menu').getByRole('button',{name:'设置',exact:true}).click()}
    else await page.locator('.nav-right').getByRole('button',{name:'主页',exact:true}).click()
    await page.waitForURL(url=>url.pathname===route);await settle(page)
  }
  async function chatVisible(page,label){
    const input=page.getByRole('textbox',{name:'消息内容',exact:true});await input.waitFor();await input.focus();await settle(page)
    const state=await page.evaluate(()=>{const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {y:r.y,bottom:r.bottom,width:r.width,height:r.height}};return {nav:rect('.nav-inner'),header:rect('.chat-header'),input:rect('textarea[aria-label="消息内容"]'),height:visualViewport?.height||innerHeight,top:visualViewport?.offsetTop||0,focused:document.activeElement?.getAttribute('aria-label')==='消息内容'}})
    report.measurements.push({label,chat:state})
    assert.ok(state.header.y>=state.nav.bottom-1,label+': chat header below capsule');assert.ok(state.header.bottom<=state.top+state.height+1,label+': chat header visible');assert.ok(state.input.y>=state.header.bottom-1&&state.input.bottom<=state.top+state.height+1,label+': composer inside visual viewport');assert.equal(state.focused,true,label+': composer retains focus')
  }
  async function scenario(name,page,callback){await t.test(name,async()=>{activePage=page;try{await callback();report.cases.push({name,status:'passed'})}catch(error){report.cases.push({name,status:'failed',message:error.message});await shot(page,'FAIL-'+name).catch(()=>{});throw error}})}
  try{
    const authContext=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'reduce'});contexts.push(authContext)
    const auth=await authContext.newPage();observe(auth);restorePage=auth
    await auth.goto(new URL('/login',base).href,{waitUntil:'networkidle'});await auth.locator('#login-username').fill(process.env.PHASE3_NAV_QA_USERNAME);await auth.locator('#login-password').fill(process.env.PHASE3_NAV_QA_PASSWORD);await auth.locator('form button[type="submit"]').click();await auth.waitForURL(url=>url.pathname==='/');await auth.waitForLoadState('networkidle');await loaded(auth)
    const prefs=await auth.evaluate(async()=>{const response=await fetch('/api/auth/prefs',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}});return {status:response.status,body:await response.json()}})
    assert.equal(prefs.status,200)
    for(const key of navigationKeys)assert.equal(prefs.body.prefs[key],true,'QA seed must enable every navigation/tool preference: '+key)
    originalTheme=prefs.body.prefs.theme_mode
    const expectedWall=process.env.PHASE3_NAV_QA_WALL_NAME||'青禾校园'
    if(!(await auth.locator('.wall-btn').textContent()).includes(expectedWall)){await auth.locator('.wall-btn').click();await auth.locator('#nav-wall-menu').getByRole('button',{name:new RegExp('^'+expectedWall)}).click();await auth.waitForLoadState('networkidle')}
    storageState=await authContext.storageState()
    for(const width of [1888,1440]){
      const context=await browser.newContext({viewport:{width,height:1000},storageState,reducedMotion:'reduce'});contexts.push(context)
      const page=await context.newPage();observe(page);await goto(page,chatPath)
      for(const theme of ['light','dark']){
        await setTheme(page,theme)
        for(const route of [chatPath,'/settings','/']){
          if(route===chatPath&&new URL(page.url()).pathname!==chatPath)await goto(page,chatPath);else if(route!==chatPath)await navigate(page,route)
          await scenario(width+'-'+theme+'-'+slug(route),page,async()=>{await font(page,'normal');const state=await geometry(page,width+' '+theme+' '+route,{desktop:true});surfaceByTheme[theme]=state.shellBackground;if(route===chatPath)await chatVisible(page,width+' '+theme+' chat');if(route==='/')await shot(page,width+'-'+theme+'-home')})
        }
      }
      await navigate(page,'/')
      await scenario(width+'-desktop-full-menus',page,async()=>{
        for(const text of coreLabels)assert.equal(await page.locator('.nav-right').getByRole('button',{name:new RegExp('^'+text)}).isVisible(),true,'Desktop core entry '+text)
        await page.locator('button[aria-controls="nav-more-menu"]').click()
        for(const text of moreLabels)assert.equal(await page.locator('#nav-more-menu').getByRole('button',{name:new RegExp('^'+text)}).isVisible(),true,'More entry '+text+' remains reachable')
        await page.keyboard.press('Escape');await page.locator('#nav-more-menu').waitFor({state:'hidden'})
        for(const selector of ['.wall-btn','button[aria-controls="nav-menu-publish"]','button[aria-controls="nav-more-menu"]','.avatar-btn'])await keyboardDropdown(page,selector,width+' '+selector)
        await page.getByRole('searchbox',{name:'搜索帖子',exact:true}).focus();await hitTestMenu(page,'#nav-search-panel',width+' search');await page.keyboard.press('Escape');await shot(page,width+'-desktop-menu-closed')
      })
      if(width===1888)await scenario('desktop-all-destinations',page,async()=>{
        for(const [label,route,group]of destinations){
          await navigate(page,'/');let control
          if(group){
            const panelId=group==='account'?'nav-account-menu':group==='more'?'nav-more-menu':'nav-menu-'+group
            await page.locator(group==='account'?'.avatar-btn':'button[aria-controls="'+panelId+'"]').click()
            control=page.locator('#'+panelId).getByRole('button',{name:new RegExp('^'+label+'(?:\\s|$)')})
          }
          else control=page.locator('.nav-right').getByRole('button',{name:new RegExp('^'+label)})
          await control.click();await page.waitForURL(url=>url.pathname===route);await settle(page)
        }
      })
      await context.close()
    }
    await scenario('light-dark-surfaces-differ',restorePage,async()=>{assert.ok(surfaceByTheme.light);assert.ok(surfaceByTheme.dark);assert.notEqual(surfaceByTheme.light,surfaceByTheme.dark)})
    for(const width of [320,375,768,1024,1080,1120,1121]){
      const context=await browser.newContext({viewport:{width,height:width<500?844:1000},isMobile:width<769,hasTouch:true,storageState,reducedMotion:'reduce'});contexts.push(context)
      const page=await context.newPage();observe(page)
      for(const fontMode of ['normal','large']){
        await goto(page,chatPath);await setTheme(page,'light')
        for(const route of [chatPath,'/settings','/']){
          if(route!==chatPath)await navigate(page,route)
          await scenario(width+'-'+fontMode+'-'+slug(route),page,async()=>{
            await font(page,fontMode);await geometry(page,width+' '+fontMode+' '+route,{touch:true});assert.equal(await page.locator('.mobile-menu-btn').isVisible(),width<=1120,'Responsive handoff at 1120/1121')
            if(route===chatPath)await chatVisible(page,width+' '+fontMode+' chat')
            if(route==='/'&&width<=1120){await mobileMenu(page,width+' '+fontMode+' mobile');if(width===320||width===375){await page.getByRole('button',{name:'打开菜单',exact:true}).click();await shot(page,width+'-'+fontMode+'-menu');await page.keyboard.press('Escape')}}
          })
        }
      }
      if(width===375)await scenario('375-keyboard-height-and-text200',page,async()=>{
        await goto(page,chatPath);await font(page,'large');await page.setViewportSize({width:375,height:430});await settle(page);await chatVisible(page,'375 reduced viewport focus');await shot(page,'375-keyboard-height-chat')
        await page.setViewportSize({width:375,height:844});await navigate(page,'/');await font(page,'text200');await geometry(page,'375 text200',{touch:true});await mobileMenu(page,'375 text200 mobile');await shot(page,'375-text200-home')
      })
      await context.close()
    }
    assert.deepEqual(report.runtimeErrors,[],'No browser runtime errors');assert.deepEqual(report.failedResponses,[],'No server errors or QA rate limiting');assert.deepEqual(report.prohibitedWrites,[],'No content submissions or destructive actions')
  }catch(error){if(activePage&&!activePage.isClosed())await shot(activePage,'FAIL-unhandled').catch(()=>{});throw error}
  finally{
    if(originalTheme&&restorePage&&!restorePage.isClosed())await restorePage.evaluate(async mode=>{await fetch('/api/auth/prefs',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('token')},body:JSON.stringify({prefs:{theme_mode:mode}})})},originalTheme).catch(()=>{})
    await fs.writeFile(path.join(artifactDirectory,'nav-report.json'),JSON.stringify(report,null,2))
    for(const context of contexts)await context.close().catch(()=>{})
    await browser.close();if(previousTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmp
    console.log(JSON.stringify({cases:report.cases.length,passed:report.cases.filter(item=>item.status==='passed').length,failed:report.cases.filter(item=>item.status==='failed'),screenshots:report.screenshots.length,report:path.join(artifactDirectory,'nav-report.json'),runtimeErrors:report.runtimeErrors,failedResponses:report.failedResponses,prohibitedWrites:report.prohibitedWrites}))
  }
})
