import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findMissingVariables } from '@core/missing-variables'
import type { StepDefinition, WorkflowGraph } from '@core/types'

function ai(id: string, content: string, extra: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id,
    key: id,
    name: extra.name ?? id,
    description: '',
    order: extra.order ?? 1,
    dependsOn: extra.dependsOn ?? [],
    stopAfter: false,
    iterate: extra.iterate ?? null,
    type: 'ai',
    config: {
      provider: 'p',
      model: 'm',
      messages: [{ id: 'm1', role: 'user', content }],
      outputFormat: 'text'
    },
    ...extra,
    type: 'ai'
  }
}

function graph(partial: Partial<WorkflowGraph> & Pick<WorkflowGraph, 'steps'>): WorkflowGraph {
  return { inputs: [], snippets: [], ...partial }
}

function paths(graphValue: WorkflowGraph, pools?: { globals?: { name: string }[]; project?: { name: string }[] }) {
  return findMissingVariables(graphValue, pools).map((item) => `${item.place} / ${item.field} / ${item.path}`)
}

describe('missing variables', () => {
  it('flags a bare name and points at a real step key', () => {
    const issues = findMissingVariables(
      graph({
        steps: [
          ai('shot', 'кадр'),
          ai('write', 'про {{shot}}', { order: 2, dependsOn: ['shot'] })
        ]
      })
    )
    assert.equal(issues.length, 1)
    assert.equal(issues[0].path, 'shot')
    assert.equal(issues[0].targetId, 'write')
    assert.equal(issues[0].field, 'сообщение 1')
    assert.match(issues[0].hint ?? '', /\{\{steps\.shot\.output\}\}/)
  })

  it('accepts an alias inside the branch and rejects it in the source array', () => {
    const found = paths(
      graph({
        inputs: [{ id: 'items', name: 'items', label: 'items', type: 'json[]', required: false, description: '' }],
        steps: [
          {
            ...ai('ideas', ''),
            type: 'fanout',
            config: {},
            iterate: { over: '{{idea}}', alias: 'idea', launch: 'all' }
          },
          ai('write', '{{idea.title}} и {{shot}}', { order: 2, dependsOn: ['ideas'] })
        ]
      })
    )
    assert.deepEqual(found, ['Шаг «ideas» / массив / idea', 'Шаг «write» / сообщение 1 / shot'])
  })

  it('checks inputs, snippets, steps, project and globals', () => {
    const found = paths(
      graph({
        inputs: [{ id: 'topic', name: 'topic', label: 'topic', type: 'text', required: false, description: '' }],
        snippets: [{ key: 'notes', content: '{{inputs.topic}} {{inputs.gone}} {{project.brand}}' }],
        steps: [
          ai('look', '{{snippets.notes}} {{snippets.missing}} {{steps.look.output}} {{globals.tone}}', {
            config: {
              provider: 'p',
              model: 'm',
              messages: [{ id: 'm1', role: 'user', content: '{{snippets.notes}} {{snippets.missing}} {{steps.look.output}} {{globals.tone}}' }],
              outputFormat: 'json',
              jsonSchema: { type: 'object', properties: { title: { type: 'string' } } }
            }
          }),
          ai('next', '{{steps.look.output.title}} {{steps.look.output.shot}}', { order: 2, dependsOn: ['look'] })
        ]
      }),
      { project: [{ name: 'voice' }], globals: [{ name: 'tone' }] }
    )
    assert.deepEqual(found, [
      'Фрагмент «notes» / текст / inputs.gone',
      'Фрагмент «notes» / текст / project.brand',
      'Шаг «look» / сообщение 1 / snippets.missing',
      'Шаг «next» / сообщение 1 / steps.look.output.shot'
    ])
  })

  it('allows a fragment to use the alias of the step that inserts it', () => {
    const found = paths(
      graph({
        inputs: [{ id: 'items', name: 'items', label: 'items', type: 'json[]', required: false, description: '' }],
        snippets: [{ key: 'line', content: '{{idea}}' }],
        steps: [
          {
            ...ai('ideas', ''),
            type: 'fanout',
            config: {},
            iterate: { over: '{{inputs.items}}', alias: 'idea', launch: 'all' }
          },
          ai('write', '{{snippets.line}}', { order: 2, dependsOn: ['ideas'] })
        ]
      })
    )
    assert.deepEqual(found, [])
  })

  it('rejects current item and prev outside a branch', () => {
    const found = paths(graph({ steps: [ai('write', '{{current_item}} {{prev.output}}')] }))
    assert.deepEqual(found, ['Шаг «write» / сообщение 1 / current_item', 'Шаг «write» / сообщение 1 / prev.output'])
  })

  it('rejects a branch variable in a run chat and keeps the fanout alias in a branch chat', () => {
    const base = {
      runtime: 'playwright' as const,
      inputs: [{ id: 'items', name: 'items', label: 'items', type: 'json[]' as const, required: false, description: '' }],
      steps: [
        {
          ...ai('ideas', ''),
          type: 'fanout' as const,
          config: {},
          iterate: { over: '{{inputs.items}}', alias: 'idea', launch: 'all' as const }
        }
      ]
    }
    assert.deepEqual(
      paths(graph({ ...base, chats: [{ key: 'main', instruction: '{{idea}}', scope: 'run' }] })),
      ['Чат «main» / инструкция / idea']
    )
    assert.deepEqual(paths(graph({ ...base, chats: [{ key: 'main', instruction: '{{idea}}', scope: 'branch' }] })), [])
  })

  it('reads a condition the same way as a token', () => {
    const found = paths(
      graph({
        steps: [
          ai('write', '', {
            config: {
              provider: 'p',
              model: 'm',
              messages: [{ id: 'm1', role: 'user', content: '{{#if shot}}есть{{/if}}', when: { op: 'and', paths: ['inputs.missing'] } }],
              outputFormat: 'text'
            }
          })
        ]
      })
    )
    assert.deepEqual(found, ['Шаг «write» / сообщение 1 / shot', 'Шаг «write» / условие сообщения 1 / inputs.missing'])
  })
})
