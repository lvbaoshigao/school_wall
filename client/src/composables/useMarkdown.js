import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import '../styles/markdown.css'

// Keep renderer options local: visiting an editor must not change another view.
// Marked 18's built-in renderers accept token objects and retain nested markup.
const markdown = new Marked({ breaks: true, gfm: true, async: false })
const IMAGE_LINE = /^ {0,3}\[img\]([^\n]*?)\[\/img\][ \t]*(?:\n|$)/gim
const MARKDOWN_TAGS = ['p', 'br', 'strong', 'em', 'del', 's', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'hr', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input']
const TAG_ATTRIBUTES = {
  a: ['href', 'title'], img: ['src', 'alt', 'title'], code: ['class'],
  ol: ['start'], th: ['align'], td: ['align'], input: ['type', 'checked', 'disabled'],
}
const asText = value => typeof value === 'string' ? value : ''
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

// 图片不接受 data/svg、脚本协议、凭据或任意站内接口地址。
export function safeImageUrl(value) {
  const url = asText(value).trim()
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url)) return ''
  if (/^\/uploads\/[a-zA-Z0-9_./%-]+$/.test(url) && !url.includes('..') && !/%(?:2e|2f|5c)/i.test(url)) return url
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : ''
  } catch { return '' }
}

function safeLinkUrl(value) {
  const url = asText(value).trim()
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url) || url.startsWith('//')) return ''
  try {
    // A fixed base permits ordinary document/query/anchor links without allowing
    // protocol-relative URLs or treating an unknown scheme as a local path.
    const parsed = new URL(url, 'https://markdown.invalid/')
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? url : ''
  } catch { return '' }
}

function splitPostContent(content) {
  const source = asText(content).replace(/\r\n?/g, '\n')
  const images = []
  if (!/\[img\]/i.test(source)) return { text: source, images }
  // Attachments are serialized as standalone lines. Never interpret an example
  // inside fenced/indented/inline code or raw HTML as an attached image.
  const text = markdown.lexer(source).map(token => {
    if (token.type !== 'paragraph') return token.raw
    let cursor = 0
    const protectedRanges = []
    for (const inline of token.tokens || []) {
      const start = token.raw.indexOf(inline.raw, cursor)
      if (start < 0) continue
      cursor = start + inline.raw.length
      if (inline.type === 'codespan' || inline.type === 'html') protectedRanges.push([start, cursor])
    }
    return token.raw.replace(IMAGE_LINE, (line, value, offset) => {
      if (protectedRanges.some(([start, end]) => offset >= start && offset < end)) return line
      const url = safeImageUrl(value)
      if (!url) return line
      images.push(url)
      return ''
    })
  }).join('')
  return { text, images }
}

function markdownBody(content) {
  const html = markdown.parse(content)
  const body = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MARKDOWN_TAGS,
    ALLOWED_ATTR: [...new Set(Object.values(TAG_ATTRIBUTES).flat())],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM: true,
  })
  // Allowed attributes also need tag-specific checks. In particular, permitting
  // task checkboxes must not permit arbitrary active form controls or CSS classes.
  for (const element of body.querySelectorAll('*')) {
    const allowed = TAG_ATTRIBUTES[element.localName] || []
    for (const attribute of [...element.attributes]) {
      if (!allowed.includes(attribute.name)) element.removeAttribute(attribute.name)
    }
  }
  for (const code of body.querySelectorAll('code[class]')) {
    const language = code.className.split(/\s+/).find(name => /^language-[\w-]+$/.test(name))
    if (language) code.className = language
    else code.removeAttribute('class')
  }
  for (const list of body.querySelectorAll('ol[start]')) {
    if (!/^-?\d{1,9}$/.test(list.getAttribute('start'))) list.removeAttribute('start')
  }
  for (const cell of body.querySelectorAll('th[align], td[align]')) {
    const align = cell.getAttribute('align').toLowerCase()
    if (['left', 'center', 'right'].includes(align)) cell.setAttribute('align', align)
    else cell.removeAttribute('align')
  }
  for (const input of body.querySelectorAll('input')) {
    if (input.getAttribute('type')?.toLowerCase() !== 'checkbox') { input.remove(); continue }
    input.setAttribute('type', 'checkbox')
    input.setAttribute('disabled', '')
  }
  for (const link of body.querySelectorAll('a')) {
    const href = safeLinkUrl(link.getAttribute('href'))
    if (href) link.setAttribute('href', href)
    else link.removeAttribute('href')
    link.setAttribute('rel', 'noopener noreferrer nofollow ugc')
  }
  for (const image of body.querySelectorAll('img')) {
    const src = safeImageUrl(image.getAttribute('src'))
    if (!src) { image.remove(); continue }
    image.setAttribute('src', src)
    image.setAttribute('loading', 'lazy')
    image.setAttribute('referrerpolicy', 'no-referrer')
    if (!image.getAttribute('alt')) image.setAttribute('alt', '帖子中的图片')
  }
  return body
}

/** Markdown 和附件标记统一处理；只有安全的格式标签可以进入 v-html。 */
export function useMarkdown() {
  function getTextContent(content) {
    const { text } = splitPostContent(content)
    return text.trim() ? text.trimEnd() : ''
  }

  function getPostImages(content) {
    return splitPostContent(content).images.slice(0, 9)
  }

  function renderMarkdown(content) {
    return markdownBody(getTextContent(content)).innerHTML
  }

  function renderPlainText(content) {
    return escapeHtml(asText(content)).replace(/\r\n?|\n/g, '<br>')
  }

  function truncateText(text, len = 30, isMarkdown = true) {
    let plain = asText(text)
    if (isMarkdown) {
      const body = markdownBody(getTextContent(text))
      for (const image of body.querySelectorAll('img')) image.replaceWith(image.getAttribute('alt') || '')
      for (const br of body.querySelectorAll('br')) br.replaceWith('\n')
      for (const block of body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, pre, blockquote, li, tr')) block.append('\n')
      for (const cell of body.querySelectorAll('th, td')) cell.append(' ')
      plain = body.textContent
    }
    plain = plain.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim()
    const chars = Array.from(plain)
    const max = Math.max(0, Number.isFinite(len) ? Math.floor(len) : 30)
    return chars.length > max ? chars.slice(0, max).join('') + '…' : plain
  }

  return { getTextContent, getPostImages, renderMarkdown, renderPlainText, truncateText }
}
