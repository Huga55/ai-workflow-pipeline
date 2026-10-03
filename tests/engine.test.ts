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
import { interpolate, resolvePath } from '@core/variables'

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

  it('runs a branch created after the source array grows', async () => {
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
    expect(created).toHaveLength(3)
    const reused = created.find((branch) => branch.id === first?.id)
    const fresh = created.find((branch) => branch.itemIndex === 2)
    expect(reused?.status).toBe('pending')
    expect(reused?.label).toBe('A2')
    expect(fresh?.status).toBe('pending')

    expect(await run(custom, store, steps, { onlyBranchId: reused?.id })).toBe('paused')
    const reusedExecutions = store.executions.filter((item) => item.stepId === 'draft' && item.branchId === reused?.id && item.status === 'completed')
    expect(reusedExecutions).toHaveLength(2)
    expect(store.artifacts.find((item) => item.stepExecutionId === reusedExecutions.at(-1)?.id)?.value).toBe('A2')

    expect(await run(custom, store, steps, { onlyBranchId: fresh?.id })).toBe('paused')
    const execution = store.executions.find((item) => item.stepId === 'draft' && item.branchId === fresh?.id && item.status === 'completed')
    expect(execution).toBeTruthy()
    expect(store.artifacts.find((item) => item.stepExecutionId === execution?.id)?.value).toBe('C')
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
