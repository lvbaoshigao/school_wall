import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ breaks: true, gfm: true })

/**
 * Markdown 渲染 + 帖子内容处理 composable
 * 统一 PostCard, PostDetail, Home, CreatePost 中的重复逻辑
 */
export function useMarkdown() {
  /** 提取纯文本（去除图片标记和 Markdown 语法） */
  function getTextContent(content) {
    return (content || '').replace(/\[img\][^\[]+\[\/img\]/g, '').trim()
  }

  /** 提取帖子中的图片 URL */
  function getPostImages(content) {
    const matches = (content || '').match(/\[img\]([^\[]+)\[\/img\]/g) || []
    return matches.map(m => m.replace(/\[img\]|\[\/img\]/g, '')).slice(0, 9)
  }

  /** 渲染 Markdown 为安全 HTML */
  function renderMarkdown(content) {
    const text = getTextContent(content)
    return DOMPurify.sanitize(marked.parse(text || ''))
  }

  /**
   * 截断纯文本（移除 Markdown 标记后）
   * @param {string} text 原始文本
   * @param {number} len 最大长度
   */
  function truncateText(text, len = 30) {
    if (!text) return ''
    const plain = text
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`{1,3}[^`]*`{1,3}/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^>\s+/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^---+$/gm, '')
      .replace(/\[img\][^\[]+\[\/img\]/g, '')
      .replace(/\n+/g, ' ')
      .trim()
    return plain.length > len ? plain.substring(0, len) + '...' : plain
  }

  return { getTextContent, getPostImages, renderMarkdown, truncateText }
}
