import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRunners } from '@core/runners'
import { expandSharedMessage, findDuplicateGroups, shareMatchingMessages } from '@core/shared-messages'
import type { StepDefinition, WorkflowGraph } from '@core/types'

function ai(id: string, name: string, content: string, when?: { op: 'and' | 'or'; paths: string[] }): StepDefinition {
  return {
    id,
    key: id,
    name,
    description: '',
    order: 1,
    dependsOn: [],
    stopAfter: false,
    iterate: null,
    type: 'ai',
    config: {
      provider: 'openai',
      model: 'gpt',
      outputFormat: 'text',
      messages: [when ? { id: `${id}-m`, role: 'user', content, when } : { id: `${id}-m`, role: 'user', content }]
    }
  }
}

describe('shared messages', () => {
  it('находит одинаковые сообщения и заменяет их ссылкой', () => {
    const text = 'Референсы одежды:\n{{inputs.clothes}}'
    const when = { op: 'and' as const, paths: ['inputs.clothes'] }
    const graph: WorkflowGraph = {
      inputs: [],
      steps: [ai('look', 'Разбор', text, when), ai('shots', 'Кадры', text, when), ai('other', 'Другое', 'свой текст')]
    }
    const groups = findDuplicateGroups(graph)
    assert.equal(groups.length, 1)
    assert.deepEqual(
      groups[0]?.places.map((place) => place.stepName),
      ['Разбор', 'Кадры']
    )
    const next = shareMatchingMessages(graph, groups[0]?.signature ?? '', () => 'id-shared')
    const shared = next.sharedMessages?.[0]
    assert.equal(shared?.key, 'referensy_odezhdy')
    assert.equal(shared?.content, text)
    assert.deepEqual(shared?.when, when)
    for (const key of ['look', 'shots']) {
      const step = next.steps.find((item) => item.key === key)
      assert.equal(step?.type, 'ai')
      if (step?.type !== 'ai') continue
      assert.deepEqual(step.config.messages[0], { id: `${key}-m`, shared: shared?.key })
    }
    const other = next.steps.find((item) => item.key === 'other')
    assert.equal(other?.type, 'ai')
    if (other?.type === 'ai') assert.equal('content' in other.config.messages[0] ? other.config.messages[0].content : '', 'свой текст')
    assert.equal(findDuplicateGroups(next).length, 0)
  })

  it('удаление общего возвращает текст в шаги', () => {
    const graph: WorkflowGraph = {
      inputs: [],
      sharedMessages: [{ id: 's', key: 'clothes', name: 'Одежда', role: 'user', content: 'референс' }],
      steps: [
        {
          id: 'look',
          key: 'look',
          name: 'Разбор',
          description: '',
          order: 1,
          dependsOn: [],
          stopAfter: false,
          iterate: null,
          type: 'ai',
          config: {
            provider: 'openai',
            model: 'gpt',
            outputFormat: 'text',
            messages: [{ id: 'm', shared: 'clothes' }]
          }
        }
      ]
    }
    const next = expandSharedMessage(graph, 'clothes')
    assert.equal(next.sharedMessages?.length ?? 0, 0)
    const step = next.steps[0]
    assert.equal(step?.type, 'ai')
    if (step?.type !== 'ai') return
    assert.deepEqual(step.config.messages[0], { id: 'm', role: 'user', content: 'референс' })
  })

  it('перед вызовом модели подставляет текст общего сообщения', async () => {
    let seen = ''
    const runners = createRunners({
      generate: async (request) => {
        seen = request.messages.map((message) => message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')).join('\n')
        return { raw: 'ok', providerResponse: null, model: 'gpt', provider: 'openai' }
      }
    })
    const step: StepDefinition = {
      id: 'look',
      key: 'look',
      name: 'Разбор',
      description: '',
      order: 1,
      dependsOn: [],
      stopAfter: false,
      iterate: null,
      type: 'ai',
      config: {
        provider: 'openai',
        model: 'gpt',
        outputFormat: 'text',
        messages: [{ id: 'm', shared: 'clothes' }]
      }
    }
    const graph: WorkflowGraph = {
      inputs: [],
      steps: [step],
      sharedMessages: [
        {
          id: 's',
          key: 'clothes',
          name: 'Одежда',
          role: 'user',
          content: 'Референс {{inputs.clothes}}',
          when: { op: 'and', paths: ['inputs.clothes'] }
        }
      ]
    }
    const outcome = await runners.ai({
      step,
      graph,
      runId: 'run',
      branchId: '',
      ctx: { inputs: { clothes: 'пальто' }, steps: {}, aliases: {} }
    })
    assert.equal(outcome.status, 'completed')
    assert.equal(seen, 'Референс пальто')
  })
})
