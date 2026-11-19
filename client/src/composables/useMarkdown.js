import { marked } from 'marked'
import DOMPurify from 'dompurify'

const IMAGE_MARKER = /\[img\]([\s\S]*?)\[\/img\]/gi
const MARKDOWN_TAGS = ['p', 'br', 'strong', 'em', 'del', 's', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'hr', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td']
const asText = value => typeof value === 'string' ? value : ''

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
  if (/^(?:#|\/(?!\/)|\.\.?\/)/.test(url)) return url
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? url : ''
  } catch { return '' }
}

/** Markdown 和附件标记统一处理；只有格式标签可以进入 v-html。 */
export function useMarkdown() {
  function getTextContent(content) {
    return asText(content).replace(IMAGE_MARKER, '').trim()
  }

  function getPostImages(content) {
    return [...asText(content).matchAll(IMAGE_MARKER)]
      .map(match => safeImageUrl(match[1])).filter(Boolean).slice(0, 9)
  }

  function renderMarkdown(content) {
    const html = marked.parse(getTextContent(content), { breaks: true, gfm: true, async: false })
    // 局部配置，不改变公告预览等其它 DOMPurify 调用的全局行为。
    const body = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: MARKDOWN_TAGS,
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM: true,
    })
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
    return body.innerHTML
  }

  function truncateText(text, len = 30) {
    const plain = getTextContent(text)
      .replace(/<[^>]*>/g, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/\u0000/g, '')
      .replace(/`{1,3}/g, '')
      .replace(/^>\s+|^[-*+]\s+|^---+$/gm, '')
      .replace(/\s+/g, ' ').trim()
    const chars = Array.from(plain)
    const max = Math.max(0, Number.isFinite(len) ? Math.floor(len) : 30)
    return chars.length > max ? chars.slice(0, max).join('') + '…' : plain
  }

  return { getTextContent, getPostImages, renderMarkdown, truncateText }
}
