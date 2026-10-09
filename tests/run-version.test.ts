import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runVersionFit } from '@core/run-version'
import type { RunDetails, StepDefinition, WorkflowGraph } from '@core/types'

function step(partial: Partial<StepDefinition> & Pick<StepDefinition, 'id' | 'key' | 'type' | 'config'>): StepDefinition {
  return {
    name: partial.name ?? partial.key,
    description: '',
    order: 1,
    dependsOn: [],
    stopAfter: false,
    iterate: null,
    ...partial
  }
}

function graph(steps: StepDefinition[], inputs: WorkflowGraph['inputs'] = []): WorkflowGraph {
  return { inputs, steps }
}

function details(stepIds: string[], branchSources: string[] = [], inputs: Record<string, unknown> = {}): Pick<RunDetails, 'executions' | 'branches' | 'run'> {
  return {
    run: { inputs } as RunDetails['run'],
    executions: stepIds.map((stepId) => ({ stepId }) as RunDetails['executions'][number]),
    branches: branchSources.map((sourceStepId) => ({ sourceStepId }) as RunDetails['branches'][number])
  }
}

const ai = step({
  id: 'ask',
  key: 'ask',
  name: 'Запрос',
  type: 'ai',
  config: { provider: 'openai', model: 'gpt', messages: [{ id: 'm', role: 'user', content: 'старый текст' }], outputFormat: 'text' }
})

describe('run version fit', () => {
  it('accepts a text change in a step that already ran', () => {
    const edited = step({
      id: 'ask',
      key: 'ask',
      name: 'Запрос',
      type: 'ai',
      config: { provider: 'openai', model: 'gpt', messages: [{ id: 'm', role: 'user', content: 'новый текст' }], outputFormat: 'text' }
    })
    const fit = runVersionFit(graph([ai]), graph([edited]), details(['ask']))
    assert.equal(fit.ok, true)
  })

  it('accepts a new step that has not run', () => {
    const extra = step({ id: 'next', key: 'next', name: 'Дальше', type: 'transform', dependsOn: ['ask'], config: { mode: 'template', template: 'x' } })
    const fit = runVersionFit(graph([ai]), graph([ai, extra]), details(['ask']))
    assert.equal(fit.ok, true)
  })

  it('rejects removing a step that already ran', () => {
    const fit = runVersionFit(graph([ai]), graph([]), details(['ask']))
    assert.equal(fit.ok, false)
  })

  it('rejects a key change for a step that already ran', () => {
    const renamed = step({
      id: 'ask',
      key: 'other',
      name: 'Запрос',
      type: 'ai',
      config: { provider: 'openai', model: 'gpt', messages: [{ id: 'm', role: 'user', content: 'старый текст' }], outputFormat: 'text' }
    })
    const fit = runVersionFit(graph([ai]), graph([renamed]), details(['ask']))
    assert.equal(fit.ok, false)
  })

  it('rejects a dependency change for a step that already ran', () => {
    const moved = step({
      id: 'ask',
      key: 'ask',
      name: 'Запрос',
      type: 'ai',
      dependsOn: ['missing'],
      config: { provider: 'openai', model: 'gpt', messages: [{ id: 'm', role: 'user', content: 'старый текст' }], outputFormat: 'text' }
    })
    const fit = runVersionFit(graph([ai]), graph([moved]), details(['ask']))
    assert.equal(fit.ok, false)
  })

  it('rejects an iterate change after branches exist', () => {
    const fan = step({
      id: 'items',
      key: 'items',
      name: 'Элементы',
      type: 'fanout',
      iterate: { over: '{{steps.ask.output}}', alias: 'item', launch: 'manual' },
      config: {}
    })
    const moved = { ...fan, iterate: { ...fan.iterate!, over: '{{steps.ask.output.shots}}' } }
    const fit = runVersionFit(graph([fan]), graph([moved]), details(['items'], ['items']))
    assert.equal(fit.ok, false)
  })

  it('accepts an iterate path fix before any branch exists', () => {
    const fan = step({
      id: 'items',
      key: 'items',
      name: 'Элементы',
      type: 'fanout',
      iterate: { over: '{{steps.ask.output}}', alias: 'item', launch: 'manual' },
      config: {}
    })
    const moved = { ...fan, iterate: { ...fan.iterate!, over: '{{steps.ask.output.shots}}' } }
    const fit = runVersionFit(graph([fan]), graph([moved]), details(['items']))
    assert.equal(fit.ok, true)
  })

  it('rejects a new required input without a value', () => {
    const input = { id: 'in', name: 'title', label: 'Название', type: 'text' as const, required: true, description: '' }
    const fit = runVersionFit(graph([ai]), graph([ai], [input]), details(['ask']))
    assert.equal(fit.ok, false)
  })
})
