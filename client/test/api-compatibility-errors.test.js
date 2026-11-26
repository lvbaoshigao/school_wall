import test from 'node:test'
import assert from 'node:assert/strict'
import { getApiErrorMessage } from '../src/api/index.js'

test('missing API route explains the backend update instead of suggesting a page reload', () => {
  const text = getApiErrorMessage({ response: { status: 404, data: { error: '接口不存在' } } })
  assert.match(text, /重启后端服务/)
  assert.match(text, /刷新网页不能更新后端/)
})

test('ordinary missing resources and other API errors keep their specific explanation', () => {
  for (const [status, error] of [[404, '帖子不存在'], [403, '无权访问此校园墙'], [409, '申请已处理']]) {
    assert.equal(getApiErrorMessage({ response: { status, data: { error } } }), error)
  }
  assert.equal(getApiErrorMessage({}, '统计加载失败'), '统计加载失败')
})
