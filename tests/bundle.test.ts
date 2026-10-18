import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { attachPaths, BUNDLE_FORMAT, BUNDLE_VERSION, detachPaths, normalizeImportedVariable, parseBundle, type Bundle } from '@core/bundle'

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

  it('wraps an old variable without versions into version 1', () => {
    const variable = normalizeImportedVariable({
      id: 'var',
      scope: 'global',
      projectId: null,
      name: 'brand',
      label: 'Бренд',
      value: 'MELOA',
      updatedAt: '2026-10-05T00:00:00.000Z'
    })
    expect(variable.versions.length).toBe(1)
    expect(variable.versions[0]?.version).toBe(1)
    expect(variable.versions[0]?.value).toBe('MELOA')
    expect(variable.name).toBe('brand')
  })

  it('rejects a file that is not a pipeline export', () => {
    assert.throws(() => parseBundle('{"hello":1}'), /Это не файл экспорта Pipeline/)
    assert.throws(() => parseBundle('not json'), /Файл не является JSON/)
  })

  it('keeps an old export without chat addresses', () => {
    const bundle = parseBundle(JSON.stringify(shell()))
    expect(bundle.chats).toEqual([])
  })

  it('keeps a qwen chat address and drops an empty one', () => {
    const bundle = parseBundle(
      JSON.stringify({
        ...shell(),
        chats: [
          { runId: 'run', chatKey: 'analyst', branchId: '', url: 'https://chat.qwen.ai/c/180b240c-1315-49ef-beb3-9604aedfa1f2', status: 'running', error: '' },
          { runId: 'run', chatKey: 'empty', url: '  ' }
        ]
      })
    )
    expect(bundle.chats).toEqual([
      {
        runId: 'run',
        chatKey: 'analyst',
        branchId: '',
        url: 'https://chat.qwen.ai/c/180b240c-1315-49ef-beb3-9604aedfa1f2',
        status: 'completed',
        error: ''
      }
    ])
  })
})

function shell(): Bundle {
  const at = '2026-10-17T10:00:00.000Z'
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: at,
    projects: [{ id: 'project', name: 'Проект', description: '', settings: {}, createdAt: at, updatedAt: at }],
    workflows: [{ id: 'workflow', projectId: 'project', name: 'Схема', description: '', createdAt: at, updatedAt: at, latestVersion: 1 }],
    versions: [{ id: 'version', workflowId: 'workflow', version: 1, graph: { inputs: [], steps: [] }, createdAt: at }],
    drafts: [],
    runs: [
      {
        id: 'run',
        projectId: 'project',
        workflowId: 'workflow',
        workflowVersionId: 'version',
        number: 16,
        title: 'Run #016',
        status: 'paused',
        inputs: {},
        error: null,
        createdAt: at,
        updatedAt: at
      }
    ],
    chats: [],
    branches: [],
    executions: [],
    artifacts: [],
    actions: [],
    variables: [],
    secrets: {},
    media: []
  }
}
