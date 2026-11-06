import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chatIdFromUrl } from '@core/chat-url'

describe('chat url', () => {
  it('reads a saved chat id and skips the new-chat placeholder', () => {
    assert.equal(chatIdFromUrl('https://chat.qwen.ai/c/7b6007d0-72ee-4e15-890d-91a977c00feb'), '7b6007d0-72ee-4e15-890d-91a977c00feb')
    assert.equal(chatIdFromUrl('https://chat.qwen.ai/c/new-chat'), null)
    assert.equal(chatIdFromUrl('https://chat.qwen.ai/c/guest'), null)
    assert.equal(chatIdFromUrl('https://chat.qwen.ai/'), null)
  })
})
