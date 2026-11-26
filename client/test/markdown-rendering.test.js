import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'

const exec = promisify(execFile)
const clientRoot = new URL('../', import.meta.url)

// Use the already installed browser: DOMPurify must run against a real DOM,
// rather than a stub that can conceal sanitizer or browser parsing regressions.
async function renderInBrowser() {
  const executable = process.env.CHROMIUM_PATH || 'chromium'
  try { await exec(executable, ['--version']) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  const marked = moduleUrl(await readFile(new URL('node_modules/marked/lib/marked.esm.js', clientRoot), 'utf8'))
  const purify = moduleUrl(await readFile(new URL('node_modules/dompurify/dist/purify.es.mjs', clientRoot), 'utf8'))
  const moduleSource = (await readFile(new URL('src/composables/useMarkdown.js', clientRoot), 'utf8'))
    .replace("from 'marked'", 'from ' + JSON.stringify(marked))
    .replace("from 'dompurify'", 'from ' + JSON.stringify(purify))
    .replace(/^import ['"][^'"]+\.css['"];?\s*$/gm, '')
  let css = await readFile(new URL('src/styles/global.css', clientRoot), 'utf8')
  try { css += await readFile(new URL('src/styles/markdown.css', clientRoot), 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const vueUrl = moduleUrl(await readFile(new URL('node_modules/vue/dist/vue.runtime.esm-browser.prod.js', clientRoot), 'utf8'))
  const components = {}
  for (const [name, path] of [['PostCard', 'src/components/PostCard.vue'], ['Admin', 'src/views/Admin.vue']]) {
    const { descriptor } = parse(await readFile(new URL(path, clientRoot), 'utf8'))
    const id = 'data-v-markdown-test-' + name.toLowerCase()
    const compiled = compileScript(descriptor, { id })
    const template = compileTemplate({ source: descriptor.template.content, filename: path, id, compilerOptions: { bindingMetadata: compiled.bindings } })
    assert.deepEqual(template.errors, [])
    components[name] = { script: compiled.content, template: template.code, id }
    for (const style of descriptor.styles) {
      const result = compileStyle({ source: style.content, filename: path, id, scoped: style.scoped })
      assert.deepEqual(result.errors, [])
      css += result.code
    }
  }
  const script = 'import * as Vue from ' + JSON.stringify(vueUrl) + ';\n' +
    'import { useMarkdown, safeImageUrl } from ' + JSON.stringify(moduleUrl(moduleSource)) + ';\n' +
    'const result = await (' + browserCases.toString() + ')(useMarkdown(), safeImageUrl, Vue, ' + JSON.stringify(components) + ');\n' +
    "const output = document.createElement('pre'); output.id='test-results'; output.textContent=JSON.stringify(result); document.body.append(output);"
  const fixture = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="img-src &apos;none&apos;"><style>' + css + '</style></head><body><script type="module" src="' + moduleUrl(script) + '"></script></body></html>'
  const directory = await mkdtemp(join(tmpdir(), 'school-wall-markdown-'))
  const fixturePath = join(directory, 'fixture.html')
  await writeFile(fixturePath, fixture)
  try {
    const { stdout, stderr } = await exec(executable, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + join(directory, 'profile'), '--dump-dom', '--virtual-time-budget=1000',
      pathToFileURL(fixturePath).href,
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
    const match = stdout.match(/<pre id="test-results">([\s\S]*?)<\/pre>/)
    assert.ok(match, 'Browser did not finish Markdown tests: ' + stderr + '\n' + stdout.slice(-3000))
    const decoded = match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    return JSON.parse(decoded)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function browserCases(markdown, safeImageUrl, Vue, components) {
  const { renderMarkdown, renderPlainText, getTextContent, getPostImages, truncateText } = markdown
  const results = []
  function check(name, callback) {
    try { callback(); results.push({ name, passed: true }) }
    catch (error) { results.push({ name, passed: false, error: error.message }) }
  }
  function expect(condition, message) { if (!condition) throw new Error(message) }
  function mount(source) {
    const node = document.createElement('div')
    node.className = 'md-body'
    node.style.width = '280px'
    node.innerHTML = renderMarkdown(source)
    document.body.append(node)
    return node
  }
  check('marked 18 keeps nested link labels, image alt/title, and code text', () => {
    const node = mount('[**校园**链接](https://example.test/path "详情")\n\n![照片](/uploads/photo.png "图注")\n\n~~~js\nconst html = "<img onerror=alert(1)>"\n~~~')
    expect(node.querySelector('a strong')?.textContent === '校园', node.innerHTML)
    expect(node.querySelector('a')?.getAttribute('title') === '详情', node.innerHTML)
    expect(node.querySelector('img')?.alt === '照片' && node.querySelector('img')?.title === '图注', node.innerHTML)
    expect(node.querySelector('pre code')?.textContent.includes('<img onerror=alert(1)>'), node.innerHTML)
    expect(!node.textContent.includes('[object Object]'), node.innerHTML)
  })
  check('soft line breaks, headings, nested lists and blockquotes remain semantic', () => {
    const node = mount('# 标题\n\n第一行\n第二行\n\n- 外层\n  - 内层\n\n> 引用\n\n~~已划去~~')
    expect(node.querySelector('h1')?.textContent === '标题', node.innerHTML)
    expect(node.querySelector('p br') && node.querySelector('ul ul li') && node.querySelector('blockquote p') && node.querySelector('del'), node.innerHTML)
  })
  check('ordered list start, task state, table alignment and code language survive', () => {
    const node = mount('3. 第三项\n4. 第四项\n\n- [x] 已完成\n- [ ] 未完成\n\n|左|右|\n|:--|--:|\n|文字|123|\n\n~~~js\nlet a = 1\n~~~')
    expect(node.querySelector('ol')?.start === 3, 'Ordered list lost start: ' + node.innerHTML)
    const inputs = [...node.querySelectorAll('input')]
    expect(inputs.length === 2 && inputs.every(input => input.type === 'checkbox' && input.disabled) && inputs[0].checked && !inputs[1].checked, 'Task state lost: ' + node.innerHTML)
    expect(getComputedStyle(node.querySelector('td:last-child')).textAlign === 'right', 'Table alignment lost: ' + node.innerHTML)
    expect(node.querySelector('code')?.className === 'language-js', 'Code language lost: ' + node.innerHTML)
  })
  check('initial indentation is preserved and attachment syntax remains literal in code', () => {
    const node = mount('    const x = 1\n    [img]/uploads/example.png[/img]')
    expect(node.querySelector('pre code')?.textContent.includes('[img]/uploads/example.png[/img]'), node.innerHTML)
    const source = '~~~text\n[img]/uploads/example.png[/img]\n~~~\n\n正文\n[img]/uploads/attached.png[/img]'
    expect(getTextContent(source).includes('[img]/uploads/example.png[/img]'), getTextContent(source))
    expect(JSON.stringify(getPostImages(source)) === JSON.stringify(['/uploads/attached.png']), JSON.stringify(getPostImages(source)))
    expect(getTextContent('保留 [img]not-an-image[/img] 原文') === '保留 [img]not-an-image[/img] 原文', getTextContent('保留 [img]not-an-image[/img] 原文'))
  })
  check('safe relative, web, email and telephone links remain clickable', () => {
    const node = mount('[站内](/post/1) [文档](guide.md) [查询](?page=2) [锚点](#hello) [外链](https://example.test/a) [邮箱](mailto:user@example.test) [电话](tel:+1234)')
    const links = [...node.querySelectorAll('a')]
    expect(links.length === 7 && links.every(link => link.hasAttribute('href')), node.innerHTML)
    expect(links.every(link => link.rel.includes('noopener') && link.rel.includes('noreferrer')), node.innerHTML)
  })
  check('script, event, CSS, form, SVG, MathML and unsafe URL payloads are inert', () => {
    window.__markdownXss = 0
    const source = [
      '<script>window.__markdownXss=1</script>',
      '<img src="/uploads/missing.png" onerror="window.__markdownXss=2">',
      '<svg><a xlink:href="javascript:window.__markdownXss=3">svg</a></svg>',
      '<math><mtext><img src=x onerror="window.__markdownXss=4"></mtext></math>',
      '<iframe srcdoc="<script>window.__markdownXss=5</script>"></iframe>',
      '<form><input autofocus onfocus="window.__markdownXss=6"><button formaction="javascript:alert(1)">go</button></form>',
      '<p style="position:fixed" class="dangerous" id="app">hidden</p>',
      '[x](javascript:alert%281%29) [x](vbscript:msgbox%281%29) [x](data:text/html,payload)',
      '<a href="java&#x09;script:alert(1)" onclick="window.__markdownXss=7">x</a>',
      '<a href="//evil.test/x">protocol relative</a><a href="https://user:pass@evil.test">credentials</a>',
      '<img src="data:image/svg+xml;base64,PHN2Zz4="><img src="//evil.test/x"><img src="/api/admin">',
    ].join('\n\n')
    const node = mount(source)
    expect(!node.querySelector('script,svg,math,iframe,form,button,style,object,embed'), node.innerHTML)
    expect(!node.querySelector('[style],[id],[class]'), node.innerHTML)
    expect([...node.querySelectorAll('*')].every(el => [...el.attributes].every(attr => !attr.name.startsWith('on'))), node.innerHTML)
    expect([...node.querySelectorAll('a')].every(el => !el.hasAttribute('href')), node.innerHTML)
    expect([...node.querySelectorAll('img')].every(el => el.getAttribute('src') === '/uploads/missing.png' && el.referrerPolicy === 'no-referrer' && el.loading === 'lazy'), node.innerHTML)
    expect([...node.querySelectorAll('input')].every(el => el.disabled && el.type === 'checkbox'), node.innerHTML)
    expect(window.__markdownXss === 0, 'XSS executed')
  })
  check('image URL validation rejects data, credentials, traversal and non-upload routes', () => {
    for (const value of ['javascript:alert(1)', 'data:image/png;base64,abc', '//evil.test/a.png', '/api/admin', '/uploads/../secret', '/uploads/%2e%2e/secret', '/uploads/%2Fsecret', 'https://user:pass@evil.test/a', 'https://example.test/a\\b']) {
      expect(safeImageUrl(value) === '', 'Accepted unsafe image: ' + value)
    }
    expect(safeImageUrl('/uploads/safe.png') === '/uploads/safe.png', 'Rejected upload')
    expect(safeImageUrl('https://example.test/safe.png') === 'https://example.test/safe.png', 'Rejected HTTPS')
  })
  check('plain text output preserves syntax and escapes HTML with line breaks', () => {
    const node = document.createElement('div')
    node.innerHTML = renderPlainText('**普通文字**\n<img src=x onerror=alert(1)> & [链接](javascript:alert)')
    expect(node.querySelectorAll('*').length === 1 && node.querySelector('br'), node.innerHTML)
    expect(node.textContent.includes('**普通文字**') && node.textContent.includes('<img src=x onerror=alert(1)> &'), node.innerHTML)
    expect(renderMarkdown(null) === '' && renderPlainText({ content: 'x' }) === '', 'Non-string input must stay empty')
  })
  check('plain previews decode entities and preserve escaped code without splitting emoji', () => {
    expect(truncateText('**粗体** &amp; \u0060<code>\u0060', 80) === '粗体 & <code>', truncateText('**粗体** &amp; \u0060<code>\u0060', 80))
    expect(truncateText('😀😀😀', 2) === '😀😀…', truncateText('😀😀😀', 2))
    expect(truncateText('**不是粗体** <文字>', 80, false) === '**不是粗体** <文字>', 'Plain preview was parsed as Markdown')
  })
  check('code blocks and wide tables scroll within narrow Markdown containers', () => {
    const node = mount('~~~text\n' + 'long_code_'.repeat(60) + '\n~~~\n\n|列一|列二|列三|列四|\n|--|--|--|--|\n|' + ['很长的表格内容'.repeat(10), 'b', 'c', 'd'].join('|') + '|')
    const pre = node.querySelector('pre')
    expect(getComputedStyle(pre).whiteSpace === 'pre', 'Code whitespace must remain preformatted')
    expect(pre.scrollWidth > pre.clientWidth && pre.clientWidth <= node.clientWidth, 'Code block did not contain horizontal overflow')
    expect(node.scrollWidth <= node.clientWidth + 1, 'Markdown overflowed narrow container: ' + node.scrollWidth + '/' + node.clientWidth)
  })
  function component(name) {
    const source = components[name]
    const nullComponent = { render: () => null }
    const bindings = {
      ...Vue, onMounted() {}, onBeforeUnmount() {},
      useRouter: () => ({ push() {} }), useRoute: () => ({ params: {}, query: {} }),
      useUserStore: () => ({ isLoggedIn: false, can: () => true, canInWall: () => false }),
      useWallStore: () => ({ currentWallId: 1, canHere: () => true, myWalls: [], currentWall: null }),
      useTimeAgo: () => ({ timeAgo: () => '刚刚' }),
      useSettingsStore: () => ({ prefs: { auto_load_images: true } }),
      useToast: () => ({ success() {}, error() {} }), useMarkdown: () => markdown,
      useFocusTrap() {}, api: {}, AvatarIcon: nullComponent, Lightbox: nullComponent,
      Icon: nullComponent, ConfirmModal: nullComponent,
    }
    const code = source.script.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
    const definition = new Function(...Object.keys(bindings), code)(...Object.values(bindings))
    const template = source.template.replace(/^import[^\n]*\n/gm, line => {
      const names = line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ')
      return 'const {' + names + '} = Vue;\n'
    }).replace('export function render', 'return function render')
    definition.render = new Function('Vue', template)(Vue)
    definition.__scopeId = source.id
    return definition
  }
  check('actual PostCard keeps plain posts literal and renders only Markdown posts', () => {
    for (const isMarkdown of [false, true]) {
      const root = document.createElement('div')
      document.body.append(root)
      const app = Vue.createApp(component('PostCard'), { post: { id: 1, content: '**正文**\n<img src=x onerror=alert(1)>', is_markdown: isMarkdown } })
      app.mount(root)
      const content = root.querySelector('.post-content')
      expect(content && !content.querySelector('img'), root.innerHTML)
      expect(isMarkdown ? content.querySelector('strong')?.textContent === '正文' : content.textContent.includes('**正文**\n<img src=x onerror=alert(1)>'), root.innerHTML)
      expect(getComputedStyle(content).whiteSpace === (isMarkdown ? 'normal' : 'pre-wrap'), 'PostCard whitespace mismatch')
      app.unmount()
    }
  })
  check('actual Admin preview and saved announcement respect the same format flag', () => {
    const definition = component('Admin')
    const scope = Vue.effectScope()
    try {
      const state = scope.run(() => definition.setup({}, { expose() {} }))
      const source = '**公告**\n<img src=x onerror=alert(1)>'
      for (const isMarkdown of [false, true]) {
        state.annForm.value.content = source
        state.annForm.value.is_markdown = isMarkdown
        const expected = isMarkdown ? renderMarkdown(source) : renderPlainText(source)
        expect(state.renderedAnnPreview.value === expected, 'Admin preview differs from safe renderer')
        expect(state.renderAnn(source, isMarkdown) === expected, 'Admin saved content differs from preview')
      }
    } finally { scope.stop() }
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  check('sanitized payloads do not execute delayed image or focus handlers', () => {
    expect(window.__markdownXss === 0, 'An asynchronous XSS handler executed')
  })
  return results
}

const results = await renderInBrowser()
test('Markdown rendering and XSS regressions in real Chromium DOM', { skip: results === null ? 'Chromium unavailable; set CHROMIUM_PATH to enable real DOM checks' : false }, async t => {
  for (const result of results || []) {
    await t.test(result.name, () => assert.ok(result.passed, result.error))
  }
})
