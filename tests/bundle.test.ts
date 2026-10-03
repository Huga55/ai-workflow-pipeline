import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { attachPaths, detachPaths, parseBundle } from '@core/bundle'

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      assert.equal(actual, expected)
    },
    toEqual(expected: unknown) {
      assert.deepEqual(actual, expected)
    }
  }
}

describe('bundle', () => {
  it('replaces file paths with media ids and restores them', () => {
    const files = new Map<string, { id: string; name: string; mime: string }>()
    const detached = detachPaths(
      {
        inputs: { photo: { kind: 'image', path: 'C:/media/a.png', mime: 'image/png', name: 'a.png' } },
        request: [{ type: 'image', path: 'C:/media/a.png', mime: 'image/png', name: 'a.png' }]
      },
      files
    ) as { inputs: { photo: { path: string } }; request: { path: string }[] }
    expect(files.size).toBe(1)
    const id = [...files.values()][0].id
    expect(detached.inputs.photo.path).toBe(`media:${id}`)
    expect(detached.request[0].path).toBe(`media:${id}`)
    const restored = attachPaths(detached, new Map([[id, 'D:/new/a.png']])) as typeof detached
    expect(restored.inputs.photo.path).toBe('D:/new/a.png')
    expect(restored.request[0].path).toBe('D:/new/a.png')
  })

  it('rejects a file that is not a pipeline export', () => {
    assert.throws(() => parseBundle('{"hello":1}'), /Это не файл экспорта Pipeline/)
    assert.throws(() => parseBundle('not json'), /Файл не является JSON/)
  })
})
