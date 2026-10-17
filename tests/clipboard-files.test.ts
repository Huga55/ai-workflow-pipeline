import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pathsFromUriList } from '@core/clipboard-files'

describe('clipboard files', () => {
  it('reads windows file uris from a copied photo list', () => {
    const paths = pathsFromUriList('file:///C:/Photos/look%20a.png\r\nfile:///C:/Photos/b.jpg\r\n')
    assert.deepEqual(paths, ['C:\\Photos\\look a.png', 'C:\\Photos\\b.jpg'])
  })
})