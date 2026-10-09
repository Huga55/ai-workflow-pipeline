import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runAiStep } from '@core/ai-step'
import { WorkflowEngine } from '@core/engine'
import { validateGraph } from '@core/graph'
import { extractJson, validateJsonSchema } from '@core/json'
import { MemoryStore } from '@core/memory-store'
import { createRunners } from '@core/runners'
import { createNeurophotoGraph } from '@core/template'
import type { StepDefinition, WorkflowGraph } from '@core/types'
import { applyManualAction } from '@core/manual'
import { interpolate, previousStep, resolvePath, variableCatalog } from '@core/variables'

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      assert.equal(actual, expected)
    },
    toEqual(expected: unknown) {
      assert.deepEqual(actual, expected)
    },
    toHaveLength(length: number) {
      assert.equal((actual as { length: number }).length, length)
    },
    toBeTruthy() {
      assert.ok(actual)
    },
    toContain(part: string) {
      assert.equal(String(actual).includes(part), true)
    }
  }
}

function step(partial: Partial<StepDefinition> & Pick<StepDefinition, 'id' | 'key' | 'type' | 'config'>): StepDefinition {
  return {
    name: partial.name ?? partial.key,
    description: '',
    order: partial.order ?? 1,
    dependsOn: partial.dependsOn ?? [],
    stopAfter: partial.stopAfter ?? false,
    iterate: partial.iterate ?? null,
    ...partial
  }
}

function graph(steps: StepDefinition[]): WorkflowGraph {
  return { inputs: [], steps }
}

async function run(engine: WorkflowEngine, store: MemoryStore, steps: StepDefinition[], extra: Record<string, unknown> = {}) {
  return engine.advance({
    runId: 'run',
    graph: graph(steps),
    inputs: {},
    ...extra
  })
}

describe('variables', () => {
  it('returns the raw value when the whole string is a variable', () => {
    const value = interpolate('{{steps.analysis.output}}', {
      inputs: {},
      steps: { analysis: { output: { id: 'shot_01' } } },
      aliases: {}
    })
    expect(value).toEqual({ id: 'shot_01' })
  })

  it('reads indexes and fields', () => {
    const resolved = resolvePath('steps.shots.output[0].title', {
      inputs: {},
      steps: { shots: { output: [{ title: 'Quiet Finish' }] } },
      aliases: {}
    })
    expect(resolved).toEqual({ ok: true, value: 'Quiet Finish' })
  })

  it('reads the previous step output through prev', () => {
    const resolved = resolvePath('prev.output.title', {
      inputs: {},
      steps: {},
      aliases: {},
      prev: { output: { title: 'Hero' } }
    })
    expect(resolved).toEqual({ ok: true, value: 'Hero' })
    const missing = resolvePath('prev.output', { inputs: {}, steps: {}, aliases: {} })
    expect(missing.ok).toBe(false)
  })

  it('offers prev for the step that depends on the previous one', () => {
    const first = step({ id: 'a', key: 'make', type: 'transform', order: 1, config: { mode: 'template', template: 'a' } })
    const second = step({
      id: 'b',
      key: 'use',
      type: 'transform',
      order: 2,
      dependsOn: ['a'],
      config: { mode: 'template', template: '' }
    })
    expect(previousStep(second, [first, second])?.key).toBe('make')
    expect(previousStep(first, [first, second])).toBe(null)
    const group = variableCatalog(graph([first, second]), second).find((item) => item.title === 'Предыдущий')
    expect(group?.items[0]?.path).toBe('prev.output')
    expect(group?.items[0]?.hint).toBe('make')
  })

  it('keeps images out of interpolated text', () => {
    const value = interpolate('Кадр {{current_item.title}}', {
      inputs: {},
      steps: {},
      current_item: { title: 'Gentle Drop' },
      aliases: {}
    })
    expect(value).toBe('Кадр Gentle Drop')
  })
})

describe('json', () => {
  it('extracts fenced json and validates a schema', () => {
    const parsed = extractJson('```json\n{"shots":[{"id":"S01"}]}\n```')
    const result = validateJsonSchema(
      { type: 'object', required: ['shots'], properties: { shots: { type: 'array' } } },
      parsed
    )
    expect(result.ok).toBe(true)
  })
})

describe('engine', () => {
  it('passes structured data between steps', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'a',
        key: 'make',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return { product_identifiers: { name: "Cream" } };' }
      }),
      step({
        id: 'b',
        key: 'use',
        type: 'transform',
        order: 2,
        dependsOn: ['a'],
        config: { mode: 'template', template: '{{steps.make.output.product_identifiers.name}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('completed')
    const output = store.artifacts.at(-1)
    expect(output?.value).toBe('Cream')
  })

  it('uses prev as the output of the direct dependency', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'a',
        key: 'make',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return { product_identifiers: { name: "Cream" } };' }
      }),
      step({
        id: 'b',
        key: 'use',
        type: 'transform',
        order: 2,
        dependsOn: ['a'],
        config: { mode: 'template', template: '{{prev.output.product_identifiers.name}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('completed')
    expect(store.artifacts.at(-1)?.value).toBe('Cream')
  })

  it('sends an optional per-item note into that branch', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }];' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'transform',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'item', launch: 'manual', noteAlias: 'note' },
        config: { mode: 'template', template: '{{item.title}} / {{note}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('paused')
    const pending = store.branches.filter((branch) => branch.sourceStepId === 'shots')
    expect(pending).toHaveLength(2)
    const first = pending.find((branch) => branch.itemIndex === 0)
    expect(first).toBeTruthy()
    expect(
      await engine.advance({
        runId: 'run',
        graph: graph(steps),
        inputs: {},
        onlyBranchId: first?.id,
        branchNote: 'крупнее'
      })
    ).toBe('paused')
    const done = store.executions.find((item) => item.stepId === 'shots' && item.branchId === first?.id && item.status === 'completed')
    expect(store.artifacts.find((item) => item.stepExecutionId === done?.id)?.value).toBe('A / крупнее')
    expect(store.branches.find((branch) => branch.itemIndex === 1)?.status).toBe('pending')
  })

  it('lets a fanout step hand each item to the next step', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }];' }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'item', launch: 'all' },
        config: {}
      }),
      step({
        id: 'use',
        key: 'use',
        type: 'transform',
        order: 3,
        dependsOn: ['items'],
        config: { mode: 'template', template: '{{steps.items.output.title}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('completed')
    const values = store.executions
      .filter((item) => item.stepId === 'use' && item.status === 'completed')
      .map((item) => store.artifacts.find((artifact) => artifact.stepExecutionId === item.id)?.value)
    expect(values).toEqual(['A', 'B'])
  })

  it('runs all-at-once branches at the same time', async () => {
    const store = new MemoryStore()
    let started = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runners = createRunners()
    runners.ai = async (context) => {
      started += 1
      await gate
      const item = context.ctx.aliases.item as { title: string }
      return { status: 'completed', output: item.title, rawResponse: item.title }
    }
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }];' }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'item', launch: 'all' },
        config: {}
      }),
      step({
        id: 'use',
        key: 'use',
        type: 'ai',
        order: 3,
        dependsOn: ['items'],
        config: { provider: 'openai', model: 'test', messages: [], outputFormat: 'text' }
      })
    ]
    const done = run(engine, store, steps)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(started).toBe(2)
    release()
    expect(await done).toBe('completed')
  })

  it('runs steps listed after a fanout inside each branch', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }];' }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'item', launch: 'all' },
        config: {}
      }),
      step({
        id: 'shots',
        key: 'shots',
        name: 'Формирование шотов',
        type: 'transform',
        order: 3,
        dependsOn: ['concepts'],
        config: { mode: 'template', template: '{{steps.items.output.title}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('completed')
    const values = store.executions
      .filter((item) => item.stepId === 'shots' && item.status === 'completed')
      .map((item) => store.artifacts.find((artifact) => artifact.stepExecutionId === item.id)?.value)
    expect(values).toEqual(['A', 'B'])
    expect(store.executions.some((item) => item.stepId === 'shots' && item.branchId === '')).toBe(false)
  })

  it('restarts the following steps of one branch when continuing from a finished step', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }];' }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'item', launch: 'all' },
        config: {}
      }),
      step({
        id: 'note',
        key: 'note',
        type: 'transform',
        order: 3,
        dependsOn: ['items'],
        config: { mode: 'template', template: '{{item.title}}' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'transform',
        order: 4,
        dependsOn: ['concepts'],
        config: { mode: 'template', template: '{{steps.note.output}}-shot' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('completed')
    const first = store.branches.find((branch) => branch.sourceStepId === 'items' && branch.itemIndex === 0)
    const second = store.branches.find((branch) => branch.sourceStepId === 'items' && branch.itemIndex === 1)
    expect(await run(engine, store, steps, { focus: { stepId: 'note', branchId: first?.id ?? '', mode: 'chain' } })).toBe('completed')
    const done = (stepId: string, branchId: string) =>
      store.executions.filter((item) => item.stepId === stepId && item.branchId === branchId && item.status === 'completed')
    expect(done('concepts', '')).toHaveLength(1)
    expect(done('note', first?.id ?? '')).toHaveLength(2)
    expect(done('shots', first?.id ?? '')).toHaveLength(2)
    expect(done('note', second?.id ?? '')).toHaveLength(1)
    expect(done('shots', second?.id ?? '')).toHaveLength(1)
    const latest = done('shots', first?.id ?? '').sort((a, b) => a.attempt - b.attempt).at(-1)
    expect(store.artifacts.find((item) => item.stepExecutionId === latest?.id)?.value).toBe('A-shot')
  })

  it('does not rerun an earlier manual step when the parse is listed after the fanout', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'answers',
        key: 'answers',
        type: 'transform',
        order: 4,
        config: { mode: 'template', template: 'ответы' }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 5,
        dependsOn: ['parsed'],
        iterate: { over: '{{steps.parsed.output}}', alias: 'item', launch: 'all' },
        config: {}
      }),
      step({
        id: 'parsed',
        key: 'parsed',
        type: 'transform',
        order: 6,
        dependsOn: ['answers'],
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }];' }
      }),
      step({
        id: 'note',
        key: 'note',
        type: 'transform',
        order: 7,
        dependsOn: ['items'],
        config: { mode: 'template', template: '{{item.title}}' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'transform',
        order: 8,
        dependsOn: [],
        config: { mode: 'template', template: '{{steps.note.output}}-shot' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('completed')
    const first = store.branches.find((branch) => branch.sourceStepId === 'items' && branch.itemIndex === 0)
    const second = store.branches.find((branch) => branch.sourceStepId === 'items' && branch.itemIndex === 1)
    expect(await run(engine, store, steps, { focus: { stepId: 'shots', branchId: first?.id ?? '', mode: 'chain' } })).toBe('completed')
    const done = (stepId: string, branchId: string) =>
      store.executions.filter((item) => item.stepId === stepId && item.branchId === branchId && item.status === 'completed')
    expect(done('answers', '')).toHaveLength(1)
    expect(done('parsed', '')).toHaveLength(1)
    expect(done('note', first?.id ?? '')).toHaveLength(1)
    expect(done('shots', first?.id ?? '')).toHaveLength(2)
    expect(done('note', second?.id ?? '')).toHaveLength(1)
    expect(done('shots', second?.id ?? '')).toHaveLength(1)
  })

  it('accepts an empty manual note when the step allows it', () => {
    const result = applyManualAction(
      { mode: 'text', prompt: 'Добавьте', allowEmpty: true },
      { type: 'text', text: '   ' }
    )
    expect(result).toEqual({ ok: true, output: '   ' })
  })

  it('runs every item and can resume a single manual branch', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "C1" }, { title: "C2" }];' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'transform',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'concept', launch: 'all' },
        config: { mode: 'script', script: 'return [{ title: "S1" }, { title: "S2" }];' }
      }),
      step({
        id: 'prompt',
        key: 'prompt',
        type: 'transform',
        order: 3,
        dependsOn: ['shots'],
        iterate: { over: '{{steps.shots.output}}', alias: 'current_shot', launch: 'manual' },
        config: { mode: 'template', template: '{{concept.title}}-{{current_shot.title}}' }
      })
    ]

    expect(await run(engine, store, steps)).toBe('paused')
    const pending = store.branches.filter((branch) => branch.sourceStepId === 'prompt')
    expect(pending).toHaveLength(4)
    expect(pending.every((branch) => branch.status === 'pending')).toBe(true)
    expect(store.executions.filter((item) => item.stepId === 'prompt')).toHaveLength(0)

    const target = pending.find((branch) => branch.label === 'S2' && branch.parentBranchId)
    expect(target).toBeTruthy()
    const parent = store.branches.find((branch) => branch.id === target?.parentBranchId)
    expect(parent?.label).toBeTruthy()

    const first = await engine.advance({
      runId: 'run',
      graph: graph(steps),
      inputs: {},
      onlyBranchId: target?.id
    })
    expect(first).toBe('paused')
    const done = store.executions.filter((item) => item.stepId === 'prompt' && item.status === 'completed')
    expect(done).toHaveLength(1)
    expect(store.artifacts.find((item) => item.stepExecutionId === done[0].id)?.value).toBe(`${parent?.label}-S2`)
    expect(store.branches.filter((branch) => branch.sourceStepId === 'prompt' && branch.status === 'pending')).toHaveLength(3)
  })

  it('stops after a step and continues on the next run', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'a',
        key: 'a',
        type: 'transform',
        order: 1,
        stopAfter: true,
        config: { mode: 'template', template: 'one' }
      }),
      step({
        id: 'b',
        key: 'b',
        type: 'transform',
        order: 2,
        dependsOn: ['a'],
        config: { mode: 'template', template: 'two' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('paused')
    expect(store.executions.map((item) => item.stepId)).toEqual(['a'])
    expect(await run(engine, store, steps)).toBe('completed')
    expect(store.executions.map((item) => item.stepId).sort()).toEqual(['a', 'b'])
  })

  it('waits for a manual choice and then branches only the selection', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: {
          mode: 'script',
          script: 'return { concepts: [{ id: "c1", title: "One" }, { id: "c2", title: "Two" }] };'
        }
      }),
      step({
        id: 'pick',
        key: 'pick',
        type: 'manual',
        order: 2,
        dependsOn: ['concepts'],
        config: {
          mode: 'select_many',
          source: '{{steps.concepts.output.concepts}}',
          labelField: 'title',
          prompt: 'Выберите',
          allowEmpty: false
        }
      }),
      step({
        id: 'next',
        key: 'next',
        type: 'transform',
        order: 3,
        dependsOn: ['pick'],
        iterate: { over: '{{steps.pick.output}}', alias: 'concept', launch: 'all' },
        config: { mode: 'template', template: '{{current_item.title}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('paused')
    const waiting = store.executions.find((item) => item.status === 'waiting_for_user')
    expect(waiting?.meta.waiting?.options?.map((item) => item.label)).toEqual(['One', 'Two'])
    const result = await engine.submitUserAction(
      { runId: 'run', graph: graph(steps), inputs: {} },
      waiting!.id,
      { type: 'select_many', optionIds: ['0'] }
    )
    expect(result).toBe('completed')
    expect(store.branches.filter((branch) => branch.sourceStepId === 'next')).toHaveLength(1)
    expect(store.artifacts.at(-1)?.value).toBe('One')
  })

  it('skips the follow-up step when the review has no questions', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({ id: 'draft', key: 'draft', type: 'transform', order: 1, config: { mode: 'template', template: 'Готовый ответ' } }),
      step({
        id: 'review',
        key: 'review',
        type: 'manual',
        order: 2,
        dependsOn: ['draft'],
        config: { mode: 'text', source: '{{steps.draft.output}}', prompt: 'Ответы на вопросы', skipStepIds: ['followup'] }
      }),
      step({
        id: 'followup',
        key: 'followup',
        type: 'transform',
        order: 3,
        dependsOn: ['review'],
        config: { mode: 'template', template: 'не должен выполниться' }
      }),
      step({
        id: 'tail',
        key: 'tail',
        type: 'transform',
        order: 4,
        dependsOn: ['draft'],
        config: { mode: 'template', template: 'дальше-{{steps.draft.output}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('paused')
    const waiting = store.executions.find((item) => item.status === 'waiting_for_user')
    expect(waiting?.meta.waiting?.value).toBe('Готовый ответ')
    const result = await engine.submitUserAction({ runId: 'run', graph: graph(steps), inputs: {} }, waiting!.id, { type: 'skip' })
    expect(result).toBe('completed')
    const status = (id: string) => store.executions.filter((item) => item.stepId === id).at(-1)?.status
    expect(status('review')).toBe('skipped')
    expect(status('followup')).toBe('skipped')
    expect(store.artifacts.find((item) => item.stepExecutionId === store.executions.find((execution) => execution.stepId === 'followup')?.id)?.value).toBe('Готовый ответ')
    expect(status('tail')).toBe('completed')
    expect(store.artifacts.at(-1)?.value).toBe('дальше-Готовый ответ')
  })

  it('continues the next step after a manual step is skipped', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({ id: 'draft', key: 'draft', type: 'transform', order: 1, config: { mode: 'template', template: 'Готовый ответ' } }),
      step({
        id: 'review',
        key: 'review',
        type: 'manual',
        order: 2,
        dependsOn: ['draft'],
        config: { mode: 'text', source: '{{steps.draft.output}}', prompt: 'Можно пропустить', skipStepIds: [] }
      }),
      step({
        id: 'next',
        key: 'next',
        type: 'transform',
        order: 3,
        dependsOn: ['review'],
        config: { mode: 'template', template: 'дальше-{{steps.review.output}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('paused')
    const waiting = store.executions.find((item) => item.status === 'waiting_for_user')
    const result = await engine.submitUserAction({ runId: 'run', graph: graph(steps), inputs: {} }, waiting!.id, { type: 'skip' })
    expect(result).toBe('completed')
    const status = (id: string) => store.executions.filter((item) => item.stepId === id).at(-1)?.status
    expect(status('review')).toBe('skipped')
    expect(status('next')).toBe('completed')
    expect(store.artifacts.at(-1)?.value).toBe('дальше-Готовый ответ')
  })

  it('continues the branch after a manual step inside it is skipped', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }];' }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'item', launch: 'manual' },
        config: {}
      }),
      step({
        id: 'review',
        key: 'review',
        type: 'manual',
        order: 3,
        dependsOn: ['items'],
        config: { mode: 'text', prompt: 'Добавьте', allowEmpty: true, skipStepIds: [] }
      }),
      step({
        id: 'next',
        key: 'next',
        type: 'transform',
        order: 4,
        dependsOn: ['review'],
        config: { mode: 'template', template: '{{steps.items.output.title}}-{{steps.review.output}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('paused')
    const branch = store.branches.find((item) => item.itemIndex === 0)
    expect(branch).toBeTruthy()
    expect(await engine.advance({ runId: 'run', graph: graph(steps), inputs: {}, onlyBranchId: branch!.id })).toBe('paused')
    const waiting = store.executions.find((item) => item.stepId === 'review' && item.status === 'waiting_for_user')
    const result = await engine.submitUserAction({ runId: 'run', graph: graph(steps), inputs: {} }, waiting!.id, { type: 'skip' })
    expect(result).toBe('paused')
    const next = store.executions.filter((item) => item.stepId === 'next' && item.branchId === branch!.id).at(-1)
    expect(next?.status).toBe('completed')
    expect(store.artifacts.find((item) => item.stepExecutionId === next?.id)?.value).toBe('A-')
  })

  it('runs the following fanout after a manual step is skipped', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'draft',
        key: 'draft',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }];' }
      }),
      step({
        id: 'review',
        key: 'review',
        type: 'manual',
        order: 2,
        dependsOn: ['draft'],
        config: { mode: 'confirm', source: '{{steps.draft.output}}', prompt: 'Принять список', skipStepIds: [] }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 3,
        dependsOn: ['review'],
        iterate: { over: '{{steps.review.output}}', alias: 'item', launch: 'all' },
        config: {}
      }),
      step({
        id: 'next',
        key: 'next',
        type: 'transform',
        order: 4,
        dependsOn: ['items'],
        config: { mode: 'template', template: '{{steps.items.output.title}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('paused')
    const waiting = store.executions.find((item) => item.status === 'waiting_for_user')
    expect(await engine.submitUserAction({ runId: 'run', graph: graph(steps), inputs: {} }, waiting!.id, { type: 'skip' })).toBe('completed')
    const values = store.executions
      .filter((item) => item.stepId === 'next' && item.status === 'completed')
      .map((item) => store.artifacts.find((artifact) => artifact.stepExecutionId === item.id)?.value)
    expect(values).toEqual(['A', 'B'])
  })

  it('keeps finished items and appends a new batch when the array length changes', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    let shots = [{ title: 'A' }, { title: 'B' }]
    const steps = [
      step({
        id: 'parsed',
        key: 'parsed',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return shots' }
      }),
      step({
        id: 'draft',
        key: 'draft',
        type: 'transform',
        order: 2,
        dependsOn: ['parsed'],
        iterate: { over: '{{steps.parsed.output}}', alias: 'item', launch: 'manual' },
        config: { mode: 'template', template: '{{item.title}}' }
      })
    ]
    const runners = createRunners()
    const base = runners.transform
    runners.transform = async (context) => {
      if (context.step.id === 'parsed') return { status: 'completed', output: shots, rawResponse: null }
      return base(context)
    }
    const custom = new WorkflowEngine(store, runners)
    expect(await run(custom, store, steps)).toBe('paused')
    const first = store.branches.find((branch) => branch.sourceStepId === 'draft' && branch.itemIndex === 0)
    expect(await run(custom, store, steps, { onlyBranchId: first?.id })).toBe('paused')
    expect(store.artifacts.at(-1)?.value).toBe('A')

    shots = [{ title: 'A2' }, { title: 'B2' }, { title: 'C' }]
    expect(await run(custom, store, steps, { focus: { stepId: 'parsed', branchId: '', mode: 'chain' } })).toBe('paused')
    const created = store.branches.filter((branch) => branch.sourceStepId === 'draft')
    expect(created).toHaveLength(5)
    const kept = created.find((branch) => branch.id === first?.id)
    const untouched = created.find((branch) => branch.itemIndex === 1)
    const added = created.filter((branch) => branch.batch === 1).sort((a, b) => a.itemIndex - b.itemIndex)
    expect(kept?.status).toBe('completed')
    expect(kept?.label).toBe('A')
    expect(kept?.batch).toBe(0)
    expect(untouched?.status).toBe('pending')
    expect(untouched?.label).toBe('B')
    expect(added.map((branch) => branch.label)).toEqual(['A2', 'B2', 'C'])
    expect(added.map((branch) => branch.itemIndex)).toEqual([2, 3, 4])
    expect(added.every((branch) => branch.status === 'pending')).toBe(true)

    expect(await run(custom, store, steps, { onlyBranchId: added[0]?.id })).toBe('paused')
    const keptExecutions = store.executions.filter((item) => item.stepId === 'draft' && item.branchId === kept?.id && item.status === 'completed')
    expect(keptExecutions).toHaveLength(1)
    expect(store.artifacts.find((item) => item.stepExecutionId === keptExecutions[0]?.id)?.value).toBe('A')
    const execution = store.executions.find((item) => item.stepId === 'draft' && item.branchId === added[0]?.id && item.status === 'completed')
    expect(store.artifacts.find((item) => item.stepExecutionId === execution?.id)?.value).toBe('A2')
  })

  it('refreshes branches in place when the new array has the same length', async () => {
    const store = new MemoryStore()
    let shots = [{ title: 'A' }, { title: 'B' }]
    const steps = [
      step({
        id: 'parsed',
        key: 'parsed',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return shots' }
      }),
      step({
        id: 'draft',
        key: 'draft',
        type: 'transform',
        order: 2,
        dependsOn: ['parsed'],
        iterate: { over: '{{steps.parsed.output}}', alias: 'item', launch: 'manual' },
        config: { mode: 'template', template: '{{item.title}}' }
      })
    ]
    const runners = createRunners()
    const base = runners.transform
    runners.transform = async (context) => {
      if (context.step.id === 'parsed') return { status: 'completed', output: shots, rawResponse: null }
      return base(context)
    }
    const custom = new WorkflowEngine(store, runners)
    expect(await run(custom, store, steps)).toBe('paused')
    const first = store.branches.find((branch) => branch.itemIndex === 0)
    shots = [{ title: 'A2' }, { title: 'B2' }]
    expect(await run(custom, store, steps, { focus: { stepId: 'parsed', branchId: '', mode: 'chain' } })).toBe('paused')
    const created = store.branches.filter((branch) => branch.sourceStepId === 'draft')
    expect(created).toHaveLength(2)
    expect(created.find((branch) => branch.id === first?.id)?.label).toBe('A2')
    expect(created.every((branch) => branch.status === 'pending' && branch.batch === 0)).toBe(true)
  })

  it('appends a new row when the same count is generated with the new-row flag', async () => {
    const store = new MemoryStore()
    let shots = [{ title: 'A' }, { title: 'B' }]
    const steps = [
      step({
        id: 'parsed',
        key: 'parsed',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return shots' }
      }),
      step({
        id: 'draft',
        key: 'draft',
        type: 'transform',
        order: 2,
        dependsOn: ['parsed'],
        iterate: { over: '{{steps.parsed.output}}', alias: 'item', launch: 'manual' },
        config: { mode: 'template', template: '{{item.title}}' }
      })
    ]
    const runners = createRunners()
    const base = runners.transform
    runners.transform = async (context) => {
      if (context.step.id === 'parsed') return { status: 'completed', output: shots, rawResponse: null }
      return base(context)
    }
    const custom = new WorkflowEngine(store, runners)
    expect(await run(custom, store, steps)).toBe('paused')
    const first = store.branches.find((branch) => branch.itemIndex === 0)
    shots = [{ title: 'A2' }, { title: 'B2' }]
    expect(
      await run(custom, store, steps, { focus: { stepId: 'parsed', branchId: '', mode: 'chain' }, appendBatch: true })
    ).toBe('paused')
    const created = store.branches.filter((branch) => branch.sourceStepId === 'draft')
    expect(created).toHaveLength(4)
    expect(created.find((branch) => branch.id === first?.id)?.label).toBe('A')
    expect(created.find((branch) => branch.id === first?.id)?.status).toBe('pending')
    const added = created.filter((branch) => branch.batch === 1).sort((a, b) => a.itemIndex - b.itemIndex)
    expect(added.map((branch) => branch.label)).toEqual(['A2', 'B2'])
    expect(added.every((branch) => branch.status === 'pending')).toBe(true)
  })

  it('runs request steps of a nested all-at-once fanout together', async () => {
    const store = new MemoryStore()
    let started = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runners = createRunners()
    runners.ai = async () => {
      started += 1
      await gate
      return { status: 'completed', output: 'ok', rawResponse: 'ok' }
    }
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }];' }
      }),
      step({
        id: 'concept',
        key: 'concept',
        type: 'fanout',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'concept', launch: 'all' },
        config: {}
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'transform',
        order: 3,
        dependsOn: ['concept'],
        config: { mode: 'script', script: 'return [{ title: "S1" }, { title: "S2" }];' }
      }),
      step({
        id: 'shot',
        key: 'shot',
        type: 'fanout',
        order: 4,
        dependsOn: ['shots'],
        iterate: { over: '{{steps.shots.output}}', alias: 'item', launch: 'all' },
        config: {}
      }),
      step({
        id: 'ask',
        key: 'ask',
        type: 'ai',
        order: 5,
        dependsOn: ['shot'],
        config: { provider: 'openai', model: 'test', messages: [], outputFormat: 'text' }
      })
    ]
    const done = run(engine, store, steps)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(started).toBe(2)
    release()
    expect(await done).toBe('completed')
  })

  it('keeps the branch after the run is stopped and continues the interrupted step', async () => {
    const store = new MemoryStore()
    const controller = new AbortController()
    let calls = 0
    const runners = createRunners()
    runners.ai = async () => {
      calls += 1
      if (calls === 1) {
        controller.abort()
        throw new Error('The operation was aborted')
      }
      return { status: 'completed', output: 'ok', rawResponse: 'ok' }
    }
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({
        id: 'items',
        key: 'items',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }];' }
      }),
      step({
        id: 'fan',
        key: 'fan',
        type: 'fanout',
        order: 2,
        dependsOn: ['items'],
        iterate: { over: '{{steps.items.output}}', alias: 'item', launch: 'all' },
        config: {}
      }),
      step({
        id: 'ask',
        key: 'ask',
        type: 'ai',
        order: 3,
        dependsOn: ['fan'],
        config: { provider: 'openai', model: 'test', messages: [], outputFormat: 'text' }
      })
    ]
    expect(await engine.advance({ runId: 'run', graph: graph(steps), inputs: {}, signal: controller.signal })).toBe('paused')
    const branches = store.branches.filter((branch) => branch.sourceStepId === 'fan')
    expect(branches).toHaveLength(2)
    expect(branches.some((branch) => branch.status === 'cancelled')).toBe(false)
    expect(store.executions.some((item) => item.stepId === 'ask' && item.meta.interrupted)).toBe(true)
    expect(await run(engine, store, steps)).toBe('completed')
    expect(calls).toBe(3)
  })

  it('fans out a second level inside each outer branch', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return { concepts: [{ title: "A" }, { title: "B" }] };' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'transform',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output.concepts}}', alias: 'concept', launch: 'all' },
        config: { mode: 'script', script: 'return { shots: [{ title: "S1" }, { title: "S2" }, { title: "S3" }] };' }
      }),
      step({
        id: 'parsed',
        key: 'parsed',
        type: 'transform',
        order: 3,
        dependsOn: ['shots'],
        config: { mode: 'script', script: 'return ctx.steps.shots.output;' }
      }),
      step({
        id: 'detail',
        key: 'detail',
        type: 'transform',
        order: 4,
        dependsOn: ['parsed'],
        iterate: { over: '{{steps.parsed.output.shots}}', alias: 'shot', launch: 'all' },
        config: { mode: 'template', template: '{{concept.title}}-{{shot.title}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('completed')
    const outer = store.branches.filter((branch) => branch.sourceStepId === 'shots')
    const inner = store.branches.filter((branch) => branch.sourceStepId === 'detail')
    expect(outer).toHaveLength(2)
    expect(inner).toHaveLength(6)
    const values = store.executions
      .filter((item) => item.stepId === 'detail' && item.status === 'completed')
      .map((item) => store.artifacts.find((artifact) => artifact.stepExecutionId === item.id)?.value)
      .sort()
    expect(values).toEqual(['A-S1', 'A-S2', 'A-S3', 'B-S1', 'B-S2', 'B-S3'])
  })

  it('creates every nested branch when continuing one outer branch and when rerunning the chain', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return { concepts: [{ title: "A" }, { title: "B" }] };' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'transform',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output.concepts}}', alias: 'concept', launch: 'manual' },
        config: { mode: 'script', script: 'return { shots: [{ title: "S1" }, { title: "S2" }] };' }
      }),
      step({
        id: 'parsed',
        key: 'parsed',
        type: 'transform',
        order: 3,
        dependsOn: ['shots'],
        config: { mode: 'extract', source: '{{steps.shots.output}}' }
      }),
      step({
        id: 'detail',
        key: 'detail',
        type: 'transform',
        order: 4,
        dependsOn: ['parsed'],
        iterate: { over: '{{steps.parsed.output.shots}}', alias: 'shot', launch: 'all' },
        config: { mode: 'template', template: '{{shot.title}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('paused')
    const outer = store.branches.find((branch) => branch.sourceStepId === 'shots' && branch.itemIndex === 0)
    expect(await run(engine, store, steps, { onlyBranchId: outer?.id })).toBe('paused')
    const nested = () => store.branches.filter((branch) => branch.sourceStepId === 'detail' && branch.parentBranchId === outer?.id)
    expect(nested()).toHaveLength(2)

    expect(await run(engine, store, steps, { focus: { stepId: 'parsed', branchId: outer?.id ?? '', mode: 'chain' } })).toBe('paused')
    expect(nested()).toHaveLength(2)
    expect(store.executions.filter((item) => item.stepId === 'detail' && item.branchId === outer?.id)).toHaveLength(0)

    const only = await run(engine, store, steps, { focus: { stepId: 'detail', branchId: outer?.id ?? '', mode: 'only' } })
    expect(only === 'paused' || only === 'completed').toBe(true)
    expect(store.executions.filter((item) => item.stepId === 'detail' && item.branchId === outer?.id)).toHaveLength(0)
    expect(nested()).toHaveLength(2)
    expect(store.executions.filter((item) => item.stepId === 'detail' && item.status === 'completed')).toHaveLength(6)
  })

  it('keeps the failed attempt when a step is retried', async () => {
    const store = new MemoryStore()
    let calls = 0
    const runners = createRunners()
    runners.transform = async () => {
      calls += 1
      if (calls === 1) return { status: 'failed', error: 'сеть', rawResponse: 'raw-1' }
      return { status: 'completed', output: { ok: true }, rawResponse: 'raw-2' }
    }
    const engine = new WorkflowEngine(store, runners)
    const steps = [step({ id: 'a', key: 'a', type: 'transform', config: { mode: 'template', template: 'x' } })]
    expect(await run(engine, store, steps)).toBe('failed')
    expect(await engine.advance({ runId: 'run', graph: graph(steps), inputs: {}, retry: { stepId: 'a', branchId: '' } })).toBe('completed')
    expect(store.executions.map((item) => [item.attempt, item.status, item.rawResponse])).toEqual([
      [1, 'failed', 'raw-1'],
      [2, 'completed', 'raw-2']
    ])
  })
})

describe('ai step', () => {
  it('keeps the raw response when schema validation fails', async () => {
    const outcome = await runAiStep(
      {
        provider: 'openai',
        model: 'gpt-test',
        outputFormat: 'json',
        jsonSchema: { type: 'object', required: ['shots'], properties: { shots: { type: 'array' } } },
        messages: [{ id: '1', role: 'user', content: 'make shots' }]
      },
      { inputs: {}, steps: {}, aliases: {} },
      async () => ({ raw: '{"title":"nope"}', providerResponse: { id: 'resp' }, model: 'gpt-test', provider: 'openai' })
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.rawResponse).toBe('{"title":"nope"}')
    expect(outcome.parsed).toEqual({ title: 'nope' })
    expect(outcome.error).toContain('схем')
  })
})

describe('template', () => {
  it('reruns one step and leaves an unrelated step untouched', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({ id: 'spec', key: 'spec', type: 'transform', order: 1, config: { mode: 'template', template: 'spec' } }),
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 2,
        dependsOn: ['spec'],
        config: { mode: 'template', template: '{{steps.spec.output}}-concepts' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'transform',
        order: 3,
        dependsOn: ['concepts'],
        config: { mode: 'template', template: '{{project.brand}}-{{steps.concepts.output}}' }
      })
    ]
    expect(await run(engine, store, steps, { project: { brand: 'Acme' } })).toBe('completed')
    expect(await run(engine, store, steps, { project: { brand: 'Acme' }, focus: { stepId: 'spec', branchId: '', mode: 'only' } })).toBe('completed')
    const completed = (id: string) => store.executions.filter((item) => item.stepId === id && item.status === 'completed')
    expect(completed('spec')).toHaveLength(2)
    expect(completed('concepts')).toHaveLength(1)
    expect(completed('shots')).toHaveLength(1)
    expect(await run(engine, store, steps, { project: { brand: 'Acme' }, focus: { stepId: 'concepts', branchId: '', mode: 'chain' } })).toBe('completed')
    expect(completed('spec')).toHaveLength(2)
    expect(completed('concepts')).toHaveLength(2)
    expect(completed('shots')).toHaveLength(2)
    expect(store.artifacts.at(-1)?.value).toBe('Acme-spec-concepts')
  })

  it('builds a valid neurophoto graph', () => {
    expect(validateGraph(createNeurophotoGraph())).toEqual([])
  })
})
