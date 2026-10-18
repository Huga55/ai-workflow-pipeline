import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runAiStep } from '@core/ai-step'
import { WorkflowEngine } from '@core/engine'
import { validateGraph } from '@core/graph'
import { extractJson, repairJson, stitchChunks, stripCodeGutter, validateJsonSchema } from '@core/json'
import { MemoryStore } from '@core/memory-store'
import { createRunners } from '@core/runners'
import { createNeurophotoGraph } from '@core/template'
import type { StepDefinition, WorkflowGraph } from '@core/types'
import { applyManualAction } from '@core/manual'
import { interpolate, interpolateParts, previousStep, resolvePath, validateTemplate, variableCatalog } from '@core/variables'

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
  return { inputs: [], snippets: [], steps }
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

  it('includes #if blocks only when the value is present', () => {
    const template = 'Тема: {{inputs.topic}}{{#if inputs.notes}}\nДополнительно:\n{{inputs.notes}}{{/if}}'
    const ctx = { inputs: { topic: 'Свет', notes: 'Без теней' }, steps: {}, aliases: {} }
    expect(interpolate(template, ctx)).toBe('Тема: Свет\nДополнительно:\nБез теней')
    expect(interpolate(template, { ...ctx, inputs: { topic: 'Свет', notes: '' } })).toBe('Тема: Свет')
    expect(interpolate(template, { ...ctx, inputs: { topic: 'Свет', notes: '   ' } })).toBe('Тема: Свет')
  })

  it('supports nested #if blocks', () => {
    const template = '{{#if inputs.a}}A{{#if inputs.b}}+B{{/if}}{{/if}}'
    expect(interpolate(template, { inputs: { a: '1', b: '2' }, steps: {}, aliases: {} })).toBe('A+B')
    expect(interpolate(template, { inputs: { a: '1', b: '' }, steps: {}, aliases: {} })).toBe('A')
    expect(interpolate(template, { inputs: { a: '', b: '2' }, steps: {}, aliases: {} })).toBe('')
  })

  it('keeps images inside a truthy #if in message parts', () => {
    const image = { kind: 'image' as const, path: '/tmp/a.png', mime: 'image/png', name: 'a.png' }
    const parts = interpolateParts('{{#if inputs.shot}}Кадр: {{inputs.shot}}{{/if}}', {
      inputs: { shot: image },
      steps: {},
      aliases: {}
    })
    expect(parts).toEqual([
      { type: 'text', text: 'Кадр: ' },
      { type: 'image', path: '/tmp/a.png', mime: 'image/png', name: 'a.png' }
    ])
    expect(interpolateParts('{{#if inputs.shot}}Кадр: {{inputs.shot}}{{/if}}', {
      inputs: { shot: null },
      steps: {},
      aliases: {}
    })).toEqual([])
  })

  it('rejects broken #if syntax', () => {
    expect(validateTemplate('{{#if inputs.notes}}текст')).toEqual(['Не закрыт {{#if inputs.notes}}'])
    expect(validateTemplate('текст{{/if}}')).toEqual(['Лишний {{/if}} без открывающего {{#if}}'])
    expect(validateTemplate('{{#if}}x{{/if}}')).toEqual(['В {{#if}} не указан путь'])
    expect(validateTemplate('{{#if inputs.bad-name}}x{{/if}}')).toEqual([
      'Некорректный путь «inputs.bad-name» в {{#if}}'
    ])
    expect(validateTemplate('{{#else}}x{{/else}}')).toEqual([
      'Неизвестная конструкция {{#else}}',
      'Неизвестная конструкция {{/else}}'
    ])
    expect(validateTemplate('{{#if inputs.notes}}ok{{/if}}')).toEqual([])
  })

  it('flags broken #if in the workflow graph', () => {
    const broken = step({
      id: 'ask',
      key: 'ask',
      type: 'ai',
      order: 1,
      config: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        messages: [{ id: 'm1', role: 'user', content: '{{#if inputs.notes}}без закрытия' }],
        outputFormat: 'text'
      }
    })
    expect(validateGraph(graph([broken])).some((item) => item.includes('Не закрыт'))).toBe(true)
  })

  it('expands snippets with nested if blocks', () => {
    const value = interpolate('Тема: {{inputs.topic}}\n{{snippets.notes_block}}', {
      inputs: { topic: 'Свет', notes: 'Без теней' },
      steps: {},
      aliases: {},
      snippets: {
        notes_block: '{{#if inputs.notes}}\nДополнительно:\n{{inputs.notes}}\n{{/if}}'
      }
    })
    expect(value).toBe('Тема: Свет\n\nДополнительно:\nБез теней\n')
    expect(
      interpolate('Тема: {{inputs.topic}}\n{{snippets.notes_block}}', {
        inputs: { topic: 'Свет', notes: '' },
        steps: {},
        aliases: {},
        snippets: {
          notes_block: '{{#if inputs.notes}}\nДополнительно:\n{{inputs.notes}}\n{{/if}}'
        }
      })
    ).toBe('Тема: Свет\n')
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

  it('escapes quotes inside strings and drops a trailing comma', () => {
    const repaired = repairJson(
      '{"what":"клише "строгой офисной дамы"","styling":"главным "украшением" кадра",}'
    )
    expect(repaired.ok).toBe(true)
    if (repaired.ok) {
      expect(repaired.value).toEqual({
        what: 'клише "строгой офисной дамы"',
        styling: 'главным "украшением" кадра'
      })
    }
  })

  it('keeps valid json and already escaped quotes', () => {
    const repaired = repairJson('{"title":"say \\"hi\\""}')
    expect(repaired.ok).toBe(true)
    if (repaired.ok) expect(repaired.value).toEqual({ title: 'say "hi"' })
  })

  it('reads json after a code gutter of line numbers', () => {
    const parsed = extractJson('json\n191\n192\n193\n{"shots":[{"shotNumber":"SHOT 01"}]}')
    expect(parsed).toEqual({ shots: [{ shotNumber: 'SHOT 01' }] })
    expect(stripCodeGutter('{"shots":[]}')).toBe('{"shots":[]}')
  })

  it('joins overlapping slices of a scrolled code block', () => {
    const text = stitchChunks(['{\n  "a": 1,\n  "b": 2,', '  "b": 2,\n  "c": 3\n}'])
    expect(extractJson(text)).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('does not throw when the json cannot be repaired', () => {
    const truncated = repairJson('{"a": "hi"')
    expect(truncated.ok).toBe(false)
    const commaInside = repairJson('{"a":"say "hi", pal"}')
    expect(commaInside.ok).toBe(false)
    const prose = repairJson('это не json')
    expect(prose.ok).toBe(false)
  })
})

describe('json repair on a step', () => {
  it('saves the repaired answer and continues without another model call', async () => {
    const store = new MemoryStore()
    let calls = 0
    const broken = '{"what":"клише "строгой офисной дамы"","styling":"главным "украшением" кадра"}'
    const engine = new WorkflowEngine(
      store,
      createRunners({
        generate: async () => {
          calls += 1
          return { raw: broken, providerResponse: null, model: 'test', provider: 'test' }
        }
      })
    )
    const steps = [
      step({
        id: 'parse',
        key: 'parse',
        type: 'ai',
        order: 1,
        config: {
          provider: 'openai',
          model: 'test',
          messages: [{ id: 'm', role: 'user', content: 'дай json' }],
          outputFormat: 'json'
        }
      }),
      step({
        id: 'use',
        key: 'use',
        type: 'transform',
        order: 2,
        dependsOn: ['parse'],
        config: { mode: 'template', template: '{{steps.parse.output.what}}' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('failed')
    expect(calls).toBe(1)
    expect(engine.repairStepJson({ runId: 'run', graph: graph(steps), inputs: {} }, 'parse', '')).toBe('paused')
    expect(calls).toBe(1)
    const fixed = store.executions.filter((item) => item.stepId === 'parse').sort((a, b) => b.attempt - a.attempt)[0]
    expect(fixed.status).toBe('completed')
    expect(fixed.meta.repairedJson).toBe(true)
    expect(await run(engine, store, steps)).toBe('completed')
    expect(calls).toBe(1)
    const used = store.executions.find((item) => item.stepId === 'use' && item.status === 'completed')
    const artifact = store.artifacts.find((item) => item.stepExecutionId === used?.id)
    expect(artifact?.value).toBe('клише "строгой офисной дамы"')
  })

  it('stores a pasted answer and continues without another model call', async () => {
    const store = new MemoryStore()
    let calls = 0
    const engine = new WorkflowEngine(
      store,
      createRunners({
        generate: async () => {
          calls += 1
          return { raw: 'не нужно', providerResponse: null, model: 'test', provider: 'test' }
        }
      })
    )
    const steps = [
      step({
        id: 'ask',
        key: 'ask',
        type: 'ai',
        order: 1,
        config: {
          provider: 'openai',
          model: 'test',
          messages: [{ id: 'm', role: 'user', content: 'дай json' }],
          outputFormat: 'json'
        }
      }),
      step({
        id: 'use',
        key: 'use',
        type: 'transform',
        order: 2,
        dependsOn: ['ask'],
        config: { mode: 'template', template: '{{steps.ask.output.title}}' }
      })
    ]
    const options = { runId: 'run', graph: graph(steps), inputs: {} }
    expect(await engine.acceptManualAnswer(options, 'ask', '', '{"title":"Город"}', true)).toBe('completed')
    expect(calls).toBe(0)
    const saved = store.executions.find((item) => item.stepId === 'ask' && item.status === 'completed')
    expect(saved?.meta.manualAnswer).toBe(true)
    expect(store.artifacts.find((item) => item.stepExecutionId === saved?.id)?.value).toEqual({ title: 'Город' })
    const used = store.executions.find((item) => item.stepId === 'use' && item.status === 'completed')
    expect(store.artifacts.find((item) => item.stepExecutionId === used?.id)?.value).toBe('Город')
    await assert.rejects(() => engine.acceptManualAnswer(options, 'ask', '', 'не json', false), /Это не JSON/)
  })

  it('keeps the failed step when the answer cannot be repaired', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(
      store,
      createRunners({
        generate: async () => ({ raw: '{"a": "hi"', providerResponse: null, model: 'test', provider: 'test' })
      })
    )
    const steps = [
      step({
        id: 'parse',
        key: 'parse',
        type: 'ai',
        order: 1,
        config: {
          provider: 'openai',
          model: 'test',
          messages: [{ id: 'm', role: 'user', content: 'дай json' }],
          outputFormat: 'json'
        }
      })
    ]
    expect(await run(engine, store, steps)).toBe('failed')
    const before = store.executions.length
    assert.throws(() => engine.repairStepJson({ runId: 'run', graph: graph(steps), inputs: {} }, 'parse', ''), /Не удалось починить JSON/)
    expect(store.executions.length).toBe(before)
    expect(store.executions[0].status).toBe('failed')
  })

  it('does not accept repaired json that misses the schema', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(
      store,
      createRunners({
        generate: async () => ({
          raw: '{"title":"клише "строгой офисной дамы""}',
          providerResponse: null,
          model: 'test',
          provider: 'test'
        })
      })
    )
    const steps = [
      step({
        id: 'parse',
        key: 'parse',
        type: 'ai',
        order: 1,
        config: {
          provider: 'openai',
          model: 'test',
          messages: [{ id: 'm', role: 'user', content: 'дай json' }],
          outputFormat: 'json',
          jsonSchema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } } }
        }
      })
    ]
    expect(await run(engine, store, steps)).toBe('failed')
    assert.throws(() => engine.repairStepJson({ runId: 'run', graph: graph(steps), inputs: {} }, 'parse', ''), /схема не сошлась/)
    expect(store.executions.filter((item) => item.status === 'completed')).toHaveLength(0)
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

  it('runs sequence branches one after another and stops when one fails', async () => {
    const store = new MemoryStore()
    let active = 0
    let peak = 0
    const order: string[] = []
    const runners = createRunners()
    runners.ai = async (context) => {
      active += 1
      peak = Math.max(peak, active)
      const item = context.ctx.aliases.item as { title: string }
      order.push(item.title)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      if (item.title === 'B') return { status: 'failed', error: 'стоп', rawResponse: null }
      return { status: 'completed', output: item.title, rawResponse: item.title }
    }
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }, { title: "C" }];' }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'item', launch: 'sequence' },
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
    expect(await run(engine, store, steps)).toBe('paused')
    expect(peak).toBe(1)
    expect(order).toEqual(['A', 'B'])
    expect(store.branches.find((branch) => branch.label === 'C')?.status).toBe('pending')
  })

  it('continues the sequence queue after the failed branch is resumed', async () => {
    const store = new MemoryStore()
    const seen = new Map<string, number>()
    const order: string[] = []
    const runners = createRunners()
    runners.ai = async (context) => {
      const item = context.ctx.aliases.item as { title: string }
      order.push(item.title)
      const attempt = (seen.get(item.title) ?? 0) + 1
      seen.set(item.title, attempt)
      if (item.title === 'B' && attempt === 1) return { status: 'failed', error: 'стоп', rawResponse: null }
      return { status: 'completed', output: item.title, rawResponse: item.title }
    }
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }, { title: "C" }];' }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'item', launch: 'sequence' },
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
    const graphForRun = graph(steps)
    expect(await run(engine, store, steps)).toBe('paused')
    const failed = store.branches.find((branch) => branch.label === 'B')
    expect(failed?.status).toBe('failed')
    expect(
      await engine.advance({
        runId: 'run',
        graph: graphForRun,
        inputs: {},
        focus: { stepId: 'use', branchId: failed?.id ?? '', mode: 'chain' }
      })
    ).toBe('completed')
    expect(order).toEqual(['A', 'B', 'B', 'C'])
    expect(store.branches.find((branch) => branch.label === 'C')?.status).toBe('completed')
  })

  it('does not start the next sequence branch when only this step is rerun', async () => {
    const store = new MemoryStore()
    const runners = createRunners()
    runners.ai = async (context) => {
      const item = context.ctx.aliases.item as { title: string }
      if (item.title === 'B') return { status: 'failed', error: 'стоп', rawResponse: null }
      return { status: 'completed', output: item.title, rawResponse: item.title }
    }
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }, { title: "B" }, { title: "C" }];' }
      }),
      step({
        id: 'items',
        key: 'items',
        type: 'fanout',
        order: 2,
        dependsOn: ['concepts'],
        iterate: { over: '{{steps.concepts.output}}', alias: 'item', launch: 'sequence' },
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
    expect(await run(engine, store, steps)).toBe('paused')
    const failed = store.branches.find((branch) => branch.label === 'B')
    runners.ai = async () => ({ status: 'completed', output: 'B', rawResponse: 'B' })
    expect(
      await engine.advance({
        runId: 'run',
        graph: graph(steps),
        inputs: {},
        focus: { stepId: 'use', branchId: failed?.id ?? '', mode: 'only' }
      })
    ).toBe('completed')
    expect(store.branches.find((branch) => branch.label === 'C')?.status).toBe('pending')
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

  it('continues the outer branch when a nested fanout before the step has no items', async () => {
    const store = new MemoryStore()
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return [{ title: "A" }];' }
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
        id: 'look',
        key: 'look',
        type: 'transform',
        order: 3,
        dependsOn: ['items'],
        config: { mode: 'template', template: '{{item.title}}' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'fanout',
        order: 4,
        dependsOn: ['look'],
        iterate: { over: '{{steps.look.output.shots}}', alias: 'shot', launch: 'all' },
        config: {}
      }),
      step({
        id: 'comment',
        key: 'comment',
        type: 'transform',
        order: 5,
        dependsOn: ['look'],
        config: { mode: 'template', template: 'note {{steps.look.output}}' }
      }),
      step({
        id: 'next',
        key: 'next',
        type: 'transform',
        order: 6,
        dependsOn: ['comment'],
        config: { mode: 'template', template: '{{steps.comment.output}}-next' }
      }),
      step({
        id: 'shot_note',
        key: 'shot_note',
        type: 'transform',
        order: 7,
        dependsOn: ['shots'],
        config: { mode: 'template', template: 'shot' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('failed')
    const branch = store.branches.find((item) => item.sourceStepId === 'items')
    expect(branch).toBeTruthy()
    expect(
      await run(engine, store, steps, { focus: { stepId: 'comment', branchId: branch?.id ?? '', mode: 'chain' } })
    ).toBe('completed')
    const done = (stepId: string, branchId: string) =>
      store.executions.filter((item) => item.stepId === stepId && item.branchId === branchId && item.status === 'completed')
    expect(done('comment', branch?.id ?? '')).toHaveLength(1)
    expect(done('next', branch?.id ?? '')).toHaveLength(1)
    expect(done('shot_note', branch?.id ?? '')).toHaveLength(0)
    expect(store.branches.some((item) => item.sourceStepId === 'shots')).toBe(false)
    expect(store.artifacts.find((item) => item.stepExecutionId === done('next', branch?.id ?? '')[0]?.id)?.value).toBe('note A-next')
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

  it('keeps manual text as a string until files are attached', () => {
    const image = { kind: 'image' as const, path: '/tmp/a.png', mime: 'image/png', name: 'a.png' }
    const file = { kind: 'file' as const, path: '/tmp/a.pdf', mime: 'application/pdf', name: 'a.pdf' }
    expect(applyManualAction({ mode: 'text', prompt: '' }, { type: 'text', text: 'смотри' })).toEqual({
      ok: true,
      output: 'смотри'
    })
    expect(
      applyManualAction({ mode: 'text', prompt: '' }, { type: 'text', text: 'смотри', files: [image, file] })
    ).toEqual({ ok: true, output: { text: 'смотри', files: [image, file] } })
    expect(applyManualAction({ mode: 'text', prompt: '' }, { type: 'text', text: '   ', files: [image] })).toEqual({
      ok: true,
      output: { text: '   ', files: [image] }
    })
  })

  it('keeps one uploaded file as a file and several as a list', () => {
    const first = { kind: 'image' as const, path: '/tmp/a.png', mime: 'image/png', name: 'a.png' }
    const second = { kind: 'image' as const, path: '/tmp/b.png', mime: 'image/png', name: 'b.png' }
    expect(applyManualAction({ mode: 'upload_image', prompt: '' }, { type: 'upload', files: [first] })).toEqual({
      ok: true,
      output: first
    })
    expect(applyManualAction({ mode: 'upload_image', prompt: '' }, { type: 'upload', files: [first, second] })).toEqual({
      ok: true,
      output: [first, second]
    })
    expect(applyManualAction({ mode: 'upload_image', prompt: '', allowEmpty: true }, { type: 'upload', files: [] })).toEqual({
      ok: true,
      output: null
    })
  })

  it('sends a manual note with files as text and images', () => {
    const image = { kind: 'image' as const, path: '/tmp/a.png', mime: 'image/png', name: 'a.png' }
    const file = { kind: 'file' as const, path: '/tmp/a.pdf', mime: 'application/pdf', name: 'a.pdf' }
    expect(
      interpolateParts('{{steps.note.output}}', {
        inputs: {},
        steps: { note: { output: { text: 'смотри', files: [image, file] } } },
        aliases: {}
      })
    ).toEqual([
      { type: 'text', text: 'смотри\na.pdf' },
      { type: 'image', path: '/tmp/a.png', mime: 'image/png', name: 'a.png' }
    ])
    expect(interpolate('Заметка: {{steps.note.output}}', {
      inputs: {},
      steps: { note: { output: { text: 'смотри', files: [image, file] } } },
      aliases: {}
    })).toBe('Заметка: смотри\na.png\na.pdf')
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

  it('does not copy a row when the parsed array matches an existing one', async () => {
    const store = new MemoryStore()
    const shots = [{ title: 'A' }, { title: 'B' }]
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
        iterate: { over: '{{steps.parsed.output}}', alias: 'item', launch: 'manual', appendOnRerun: true },
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
    expect(await run(custom, store, steps, { focus: { stepId: 'parsed', branchId: '', mode: 'chain' }, appendBatch: true })).toBe('paused')
    const created = store.branches.filter((branch) => branch.sourceStepId === 'draft')
    expect(created).toHaveLength(2)
    expect(created.map((branch) => branch.label).sort()).toEqual(['A', 'B'])
    expect(created.every((branch) => branch.batch === 0)).toBe(true)
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

  it('runs a side branch once on the concept, not once per nested shot', async () => {
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
        iterate: { over: '{{steps.concepts.output}}', alias: 'concept', launch: 'all' },
        config: {}
      }),
      step({
        id: 'shot_list',
        key: 'shot_list',
        type: 'transform',
        order: 3,
        dependsOn: ['items'],
        config: { mode: 'script', script: 'return ["S1", "S2"];' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'fanout',
        order: 4,
        dependsOn: ['shot_list'],
        iterate: { over: '{{steps.shot_list.output}}', alias: 'shot', launch: 'all' },
        config: {}
      }),
      step({
        id: 'json',
        key: 'json',
        name: 'Формирование JSON по шоту',
        type: 'transform',
        order: 5,
        dependsOn: ['shots'],
        config: { mode: 'template', template: '{{concept.title}}-{{shot}}' }
      }),
      step({
        id: 'extra',
        key: 'extra',
        name: 'Дополнительные шоты',
        type: 'manual',
        order: 9,
        dependsOn: ['items'],
        sideBranch: true,
        config: { mode: 'text', prompt: 'Какие ещё кадры?', allowEmpty: true }
      }),
      step({
        id: 'extra_ai',
        key: 'extra_ai',
        type: 'transform',
        order: 10,
        dependsOn: ['extra'],
        config: { mode: 'template', template: 'later' }
      })
    ]
    expect(await run(engine, store, steps)).toBe('paused')
    const concepts = store.branches.filter((branch) => branch.sourceStepId === 'items')
    const shots = store.branches.filter((branch) => branch.sourceStepId === 'shots')
    expect(concepts).toHaveLength(2)
    expect(shots).toHaveLength(4)
    const waiting = store.executions.filter((item) => item.stepId === 'extra' && item.status === 'waiting_for_user')
    expect(waiting).toHaveLength(2)
    expect(waiting.map((item) => item.branchId).sort()).toEqual(concepts.map((branch) => branch.id).sort())
    expect(waiting.some((item) => shots.some((branch) => branch.id === item.branchId))).toBe(false)
    const jsonDone = store.executions.filter((item) => item.stepId === 'json' && item.status === 'completed')
    expect(jsonDone.length).toBe(shots.length)

    const stray = { ...waiting[0], id: 'stray', branchId: shots[0].id, attempt: 1 }
    store.insertExecution(stray)
    expect(await run(engine, store, steps)).toBe('paused')
    expect(store.executions.find((item) => item.id === 'stray')?.status).toBe('skipped')
    const stillWaiting = store.executions.filter((item) => item.stepId === 'extra' && item.status === 'waiting_for_user')
    expect(stillWaiting).toHaveLength(2)
    expect(stillWaiting.every((item) => concepts.some((branch) => branch.id === item.branchId))).toBe(true)
  })

  it('continues a side branch on the concept when rerunning from a step there', async () => {
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
        iterate: { over: '{{steps.concepts.output}}', alias: 'concept', launch: 'all' },
        config: {}
      }),
      step({
        id: 'shot_list',
        key: 'shot_list',
        type: 'transform',
        order: 3,
        dependsOn: ['items'],
        config: { mode: 'script', script: 'return ["S1", "S2"];' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        type: 'fanout',
        order: 4,
        dependsOn: ['shot_list'],
        iterate: { over: '{{steps.shot_list.output}}', alias: 'shot', launch: 'all' },
        config: {}
      }),
      step({
        id: 'json',
        key: 'json',
        type: 'transform',
        order: 5,
        dependsOn: ['shots'],
        config: { mode: 'template', template: '{{concept.title}}-{{shot}}' }
      }),
      step({
        id: 'extra',
        key: 'extra',
        name: 'Дополнительные шоты',
        type: 'manual',
        order: 9,
        dependsOn: ['items'],
        sideBranch: true,
        config: { mode: 'text', prompt: 'Какие ещё кадры?', allowEmpty: true }
      }),
      step({
        id: 'extra_ai',
        key: 'extra_ai',
        name: 'Формирование дополнительных шотов',
        type: 'transform',
        order: 10,
        dependsOn: ['extra'],
        config: { mode: 'template', template: 'later' }
      })
    ]
    const options = { runId: 'run', graph: graph(steps), inputs: {} }
    expect(await engine.advance(options)).toBe('paused')
    const concept = store.branches.find((branch) => branch.sourceStepId === 'items' && branch.itemIndex === 0)
    const shots = store.branches.filter((branch) => branch.sourceStepId === 'shots' && branch.parentBranchId === concept?.id)
    expect(concept).toBeTruthy()
    expect(shots).toHaveLength(2)
    const asked = await engine.advance({
      ...options,
      focus: { stepId: 'extra', branchId: concept?.id ?? '', mode: 'chain' }
    })
    expect(asked).toBe('paused')
    const waiting = store.executions.filter((item) => item.stepId === 'extra' && item.status === 'waiting_for_user' && item.branchId === concept?.id)
    expect(waiting.length > 0).toBe(true)
    expect(store.executions.some((item) => item.stepId === 'extra' && item.branchId === shots[0].id && item.status === 'waiting_for_user')).toBe(false)
    const latest = waiting.sort((a, b) => b.attempt - a.attempt)[0]
    expect(await engine.submitUserAction(options, latest.id, { type: 'text', text: 'крупный план' })).toBe('paused')
    const followed = store.executions.filter((item) => item.stepId === 'extra_ai' && item.status === 'completed' && item.branchId === concept?.id)
    expect(followed.length > 0).toBe(true)
    expect(store.executions.some((item) => item.stepId === 'extra_ai' && shots.some((branch) => branch.id === item.branchId))).toBe(false)
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

describe('playwright chats', () => {
  it('opens a chat for the run and sends only the new turn', async () => {
    const store = new MemoryStore()
    const opened: string[] = []
    const sent: string[] = []
    const runners = createRunners({
      generate: async (request) => {
        const text = request.messages
          .flatMap((message) => message.content)
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        sent.push(`${request.runId}:${request.chat}:${text}`)
        return { raw: 'ok', providerResponse: null, model: 'qwen', provider: 'qwen' }
      }
    })
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({
        id: 'first',
        key: 'first',
        type: 'ai',
        order: 1,
        config: {
          provider: 'qwen',
          model: 'qwen',
          chat: 'analyst',
          messages: [{ id: 'm1', role: 'user', content: 'первый вопрос' }],
          outputFormat: 'text'
        }
      }),
      step({
        id: 'second',
        key: 'second',
        type: 'ai',
        order: 2,
        dependsOn: ['first'],
        config: {
          provider: 'qwen',
          model: 'qwen',
          chat: 'analyst',
          messages: [{ id: 'm2', role: 'user', content: 'второй вопрос' }],
          outputFormat: 'text'
        }
      })
    ]
    const graph = {
      runtime: 'playwright' as const,
      inputs: [],
      chats: [{ key: 'analyst', instruction: 'Ты аналитик упаковки.', scope: 'run' as const }],
      steps
    }
    const advance = (runId: string) =>
      engine.advance({
        runId,
        graph,
        inputs: {},
        openChats: async (request) => {
          opened.push(`${request.runId}:${request.scope}:${request.branchId}`)
        }
      })
    expect(await advance('run-a')).toBe('completed')
    expect(await advance('run-b')).toBe('completed')
    expect(opened).toEqual(['run-a:run:', 'run-b:run:'])
    expect(sent).toEqual(['run-a:analyst:первый вопрос', 'run-a:analyst:второй вопрос', 'run-b:analyst:первый вопрос', 'run-b:analyst:второй вопрос'])
    assert.equal(sent.join('\n').includes('Ты аналитик'), false)
  })

  it('opens a separate chat when a branch starts', async () => {
    const store = new MemoryStore()
    const opened: string[] = []
    const runners = createRunners({
      generate: async () => ({ raw: 'ok', providerResponse: null, model: 'qwen', provider: 'qwen' })
    })
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return ["A", "B"];' }
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
        id: 'shot',
        key: 'shot',
        type: 'ai',
        order: 3,
        dependsOn: ['items'],
        config: {
          provider: 'qwen',
          model: 'qwen',
          chat: 'shots',
          messages: [{ id: 'm', role: 'user', content: '{{item}}' }],
          outputFormat: 'text'
        }
      })
    ]
    await engine.advance({
      runId: 'run',
      graph: {
        runtime: 'playwright',
        inputs: [],
        chats: [{ key: 'shots', instruction: 'Кадры', scope: 'branch' }],
        steps
      },
      inputs: {},
      startManualBranches: true,
      openChats: async (request) => {
        opened.push(request.scope)
      }
    })
    assert.deepEqual(opened, ['run', 'branch', 'branch'])
  })

  it('writes a run chat from inside a branch to the shared chat', async () => {
    const store = new MemoryStore()
    const sent: string[] = []
    const runners = createRunners({
      generate: async (request) => {
        sent.push(`${request.chat}:${request.branchId ?? ''}`)
        return { raw: 'ok', providerResponse: null, model: 'qwen', provider: 'qwen' }
      }
    })
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return ["A", "B"];' }
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
        id: 'make',
        key: 'make',
        type: 'ai',
        order: 3,
        dependsOn: ['items'],
        config: {
          provider: 'qwen',
          model: 'qwen',
          chat: 'concept_maker',
          messages: [{ id: 'm', role: 'user', content: '{{item}}' }],
          outputFormat: 'text'
        }
      })
    ]
    expect(
      await engine.advance({
        runId: 'run',
        graph: {
          runtime: 'playwright',
          inputs: [],
          chats: [{ key: 'concept_maker', instruction: 'Концепт', scope: 'run' }],
          steps
        },
        inputs: {},
        openChats: async () => undefined
      })
    ).toBe('completed')
    expect(sent).toEqual(['concept_maker:', 'concept_maker:'])
  })

  it('does not open a chat when only a transform step is rerun', async () => {
    const store = new MemoryStore()
    const opened: string[] = []
    const sent: string[] = []
    const runners = createRunners({
      generate: async (request) => {
        sent.push(request.chat ?? '')
        return { raw: 'ok', providerResponse: null, model: 'qwen', provider: 'qwen' }
      }
    })
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({ id: 'prep', key: 'prep', type: 'transform', order: 1, config: { mode: 'template', template: 'data' } }),
      step({
        id: 'ask',
        key: 'ask',
        type: 'ai',
        order: 2,
        dependsOn: ['prep'],
        config: {
          provider: 'qwen',
          model: 'qwen',
          chat: 'analyst',
          messages: [{ id: 'm1', role: 'user', content: 'вопрос' }],
          outputFormat: 'text'
        }
      })
    ]
    const workflow = {
      runtime: 'playwright' as const,
      inputs: [],
      chats: [{ key: 'analyst', instruction: 'Ты аналитик.', scope: 'run' as const }],
      steps
    }
    const openChats = async (request: { scope: string }) => {
      opened.push(request.scope)
    }
    expect(await engine.advance({ runId: 'run', graph: workflow, inputs: {}, openChats })).toBe('completed')
    expect(
      await engine.advance({
        runId: 'run',
        graph: workflow,
        inputs: {},
        openChats,
        focus: { stepId: 'prep', branchId: '', mode: 'only' }
      })
    ).toBe('completed')
    expect(opened).toEqual(['run'])
    expect(sent).toEqual(['analyst'])
    expect(store.executions.filter((item) => item.stepId === 'prep')).toHaveLength(2)
  })

  it('opens the run chat again when only an ai step is rerun', async () => {
    const store = new MemoryStore()
    const opened: string[] = []
    const runners = createRunners({
      generate: async () => ({ raw: 'ok', providerResponse: null, model: 'qwen', provider: 'qwen' })
    })
    const engine = new WorkflowEngine(store, runners)
    const steps = [
      step({ id: 'prep', key: 'prep', type: 'transform', order: 1, config: { mode: 'template', template: 'data' } }),
      step({
        id: 'ask',
        key: 'ask',
        type: 'ai',
        order: 2,
        dependsOn: ['prep'],
        config: {
          provider: 'qwen',
          model: 'qwen',
          chat: 'analyst',
          messages: [{ id: 'm1', role: 'user', content: 'вопрос' }],
          outputFormat: 'text'
        }
      })
    ]
    const workflow = {
      runtime: 'playwright' as const,
      inputs: [],
      chats: [{ key: 'analyst', instruction: 'Ты аналитик.', scope: 'run' as const }],
      steps
    }
    const openChats = async (request: { scope: string }) => {
      opened.push(request.scope)
    }
    expect(await engine.advance({ runId: 'run', graph: workflow, inputs: {}, openChats })).toBe('completed')
    expect(
      await engine.advance({
        runId: 'run',
        graph: workflow,
        inputs: {},
        openChats,
        focus: { stepId: 'ask', branchId: '', mode: 'only' }
      })
    ).toBe('completed')
    expect(opened).toEqual(['run', 'run'])
  })

  it('does not open a branch chat when only a transform inside the branch is rerun', async () => {
    const store = new MemoryStore()
    const opened: string[] = []
    const engine = new WorkflowEngine(store)
    const steps = [
      step({
        id: 'concepts',
        key: 'concepts',
        type: 'transform',
        order: 1,
        config: { mode: 'script', script: 'return ["A"];' }
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
        id: 'shape',
        key: 'shape',
        type: 'transform',
        order: 3,
        dependsOn: ['items'],
        config: { mode: 'template', template: '{{item}}' }
      })
    ]
    const workflow = {
      runtime: 'playwright' as const,
      inputs: [],
      chats: [{ key: 'shots', instruction: 'Кадры', scope: 'branch' as const }],
      steps
    }
    const openChats = async (request: { scope: string }) => {
      opened.push(request.scope)
    }
    expect(await engine.advance({ runId: 'run', graph: workflow, inputs: {}, openChats })).toBe('completed')
    const branch = store.branches.find((item) => item.sourceStepId === 'items')
    expect(
      await engine.advance({
        runId: 'run',
        graph: workflow,
        inputs: {},
        openChats,
        focus: { stepId: 'shape', branchId: branch?.id ?? '', mode: 'only' }
      })
    ).toBe('completed')
    expect(opened).toEqual(['run', 'branch'])
    expect(store.executions.filter((item) => item.stepId === 'shape')).toHaveLength(2)
  })
})

describe('ai step', () => {
  it('sends playwright messages one after another and keeps the last reply', async () => {
    let seen: string[] = []
    const outcome = await runAiStep(
      {
        provider: 'qwen',
        model: 'qwen',
        chat: 'analyst',
        outputFormat: 'json',
        jsonSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        messages: [
          { id: '1', role: 'user', content: 'Это оригинал, запомни.' },
          { id: '2', role: 'user', content: 'Это реф. Напиши концепцию.' }
        ]
      },
      { inputs: {}, steps: {}, aliases: {} },
      async (request) => {
        seen = request.messages.map((message) => message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))
        return { raw: '{"title":"тихий свет"}', providerResponse: null, model: 'qwen', provider: 'qwen' }
      },
      undefined,
      { runtime: 'playwright', runId: 'run', branchId: '' }
    )
    assert.equal(seen.length, 2)
    assert.equal(seen[0], 'Это оригинал, запомни.')
    assert.equal(seen[1]?.includes('Это реф. Напиши концепцию.'), true)
    assert.equal(seen[1]?.includes('Return only valid JSON'), true)
    assert.equal(seen[0]?.includes('Return only valid JSON'), false)
    expect(outcome.status).toBe('completed')
    expect(outcome.output).toEqual({ title: 'тихий свет' })
  })

  it('skips a whole message when a referenced value is missing', async () => {
    let seen: string[] = []
    const outcome = await runAiStep(
      {
        provider: 'qwen',
        model: 'qwen',
        chat: 'analyst',
        outputFormat: 'text',
        messages: [
          { id: '1', role: 'user', content: 'Это оригинал.' },
          { id: '2', role: 'user', content: 'Референс {{inputs.ref}}', when: { op: 'and', paths: ['inputs.ref', 'inputs.pose'] } },
          { id: '3', role: 'user', content: 'Запасной {{inputs.alt}}', when: { op: 'or', paths: ['inputs.ref', 'inputs.alt'] } }
        ]
      },
      { inputs: { alt: 'свет', pose: 'профиль' }, steps: {}, aliases: {} },
      async (request) => {
        seen = request.messages.map((message) => message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))
        return { raw: 'ok', providerResponse: null, model: 'qwen', provider: 'qwen' }
      },
      undefined,
      { runtime: 'playwright', runId: 'run', branchId: '' }
    )
    assert.deepEqual(seen, ['Это оригинал.', 'Запасной свет'])
    expect(outcome.status).toBe('completed')
    expect(outcome.output).toBe('ok')
  })

  it('fails when every message is skipped by its condition', async () => {
    const outcome = await runAiStep(
      {
        provider: 'qwen',
        model: 'qwen',
        chat: 'analyst',
        outputFormat: 'text',
        messages: [{ id: '1', role: 'user', content: 'Референс {{inputs.ref}}', when: { op: 'and', paths: ['inputs.ref'] } }]
      },
      { inputs: {}, steps: {}, aliases: {} },
      async () => ({ raw: 'ok', providerResponse: null, model: 'qwen', provider: 'qwen' })
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('пропущен')
  })

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
