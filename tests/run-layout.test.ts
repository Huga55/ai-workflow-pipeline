import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { layoutRun, nodeSize } from '@core/run-layout'
import type { Branch, RunDetails, StepDefinition } from '@core/types'

function step(partial: Partial<StepDefinition> & Pick<StepDefinition, 'id' | 'key' | 'type' | 'config'>): StepDefinition {
  return {
    name: partial.name ?? partial.key,
    description: '',
    order: partial.order ?? 1,
    dependsOn: partial.dependsOn ?? [],
    stopAfter: false,
    iterate: partial.iterate ?? null,
    ...partial
  }
}

function branch(partial: Pick<Branch, 'id' | 'parentBranchId' | 'sourceStepId' | 'itemIndex' | 'label'> & { batch?: number }): Branch {
  return {
    runId: 'run',
    alias: 'item',
    item: { title: partial.label },
    note: '',
    noteAlias: '',
    status: 'pending',
    ...partial,
    batch: partial.batch ?? 0
  }
}

function details(steps: StepDefinition[], branches: Branch[]): RunDetails {
  return {
    run: { id: 'run' },
    graph: { inputs: [], steps },
    versionNumber: 1,
    workflowName: 't',
    branches,
    executions: [],
    artifacts: [],
    chats: []
  } as unknown as RunDetails
}

function center(node: { x: number; w: number }): number {
  return node.x + node.w / 2
}

describe('run layout', () => {
  it('stacks the chain downward and places sibling items side by side', () => {
    const steps = [
      step({ id: 'prep', key: 'prep', name: 'Подготовка', type: 'transform', order: 1, config: { mode: 'template', template: '' } }),
      step({
        id: 'items',
        key: 'items',
        name: 'Элементы концепций',
        type: 'fanout',
        order: 2,
        dependsOn: ['prep'],
        iterate: { over: '{{steps.prep.output}}', alias: 'item', launch: 'manual' },
        config: {}
      }),
      step({
        id: 'use',
        key: 'use',
        name: 'Отправка ответов модели',
        type: 'transform',
        order: 3,
        dependsOn: ['items'],
        config: { mode: 'template', template: '' }
      }),
      step({
        id: 'nested',
        key: 'nested',
        name: 'Шоты',
        type: 'fanout',
        order: 4,
        dependsOn: ['use'],
        iterate: { over: '{{steps.use.output}}', alias: 'shot', launch: 'all' },
        config: {}
      }),
      step({
        id: 'leaf',
        key: 'leaf',
        name: 'Формирование JSON по шоту',
        type: 'transform',
        order: 5,
        dependsOn: ['nested'],
        config: { mode: 'template', template: '' }
      }),
      step({
        id: 'collect',
        key: 'collect',
        name: 'Сборка',
        type: 'merge',
        order: 6,
        dependsOn: ['items'],
        config: { mode: 'collect', fromFanoutStepId: 'items', fromStepId: 'leaf' }
      })
    ]
    const laid = layoutRun(
      details(steps, [
        branch({ id: 'b0', parentBranchId: '', sourceStepId: 'items', itemIndex: 0, label: 'Тихий финал' }),
        branch({ id: 'b1', parentBranchId: '', sourceStepId: 'items', itemIndex: 1, label: 'Крупный план' }),
        branch({ id: 'n0', parentBranchId: 'b0', sourceStepId: 'nested', itemIndex: 0, label: 'Общий план' }),
        branch({ id: 'n1', parentBranchId: 'b0', sourceStepId: 'nested', itemIndex: 1, label: 'Деталь' })
      ])
    )
    const prep = laid.nodes.find((node) => node.stepId === 'prep')
    const split = laid.nodes.find((node) => node.role === 'split' && node.stepId === 'items')
    const items = laid.nodes.filter((node) => node.role === 'item' && node.stepId === 'items').sort((a, b) => a.x - b.x)
    const nested = laid.nodes.filter((node) => node.role === 'item' && node.stepId === 'nested').sort((a, b) => a.x - b.x)
    const nestedSplit = laid.nodes.find((node) => node.role === 'split' && node.stepId === 'nested')
    const collect = laid.nodes.find((node) => node.stepId === 'collect')
    assert.ok(prep && split && nestedSplit && collect)
    assert.equal(items.length, 2)
    assert.equal(items[0].y, items[1].y)
    assert.ok(items[1].x >= items[0].x + items[0].w)
    assert.ok(items[0].y > split.y + split.h)
    assert.ok(Math.abs(center(prep) - center(split)) < 1)
    assert.ok(prep.y + prep.h < split.y)
    const use = laid.nodes.find((node) => node.stepId === 'use' && node.branchId === 'b0')
    assert.ok(use)
    assert.ok(use.y > items[0].y)
    assert.ok(Math.abs(center(use) - center(items[0])) < 1)
    assert.equal(nested.length, 2)
    assert.equal(nested[0].y, nested[1].y)
    assert.ok(nested[1].x >= nested[0].x + nested[0].w)
    assert.ok(nested[0].y > nestedSplit.y + nestedSplit.h)
    const bottoms = laid.nodes.filter((node) => node.stepId === 'leaf').map((node) => node.y + node.h)
    assert.ok(collect.y > Math.max(...bottoms))
  })

  it('places steps after a fanout into every branch', () => {
    const steps = [
      step({
        id: 'items',
        key: 'items',
        name: 'Элемент концепции',
        type: 'fanout',
        order: 1,
        iterate: { over: '{{steps.prep.output}}', alias: 'item', launch: 'manual' },
        config: {}
      }),
      step({
        id: 'note',
        key: 'note',
        name: 'Комментарий',
        type: 'manual',
        order: 2,
        dependsOn: ['items'],
        config: { mode: 'text', prompt: '' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        name: 'Формирование шотов по концепции',
        type: 'ai',
        order: 3,
        dependsOn: [],
        config: { provider: 'openai', model: 'gpt', messages: [], outputFormat: 'text' }
      })
    ]
    const laid = layoutRun(
      details(steps, [
        branch({ id: 'b0', parentBranchId: '', sourceStepId: 'items', itemIndex: 0, label: 'Фруктовая абстракция' }),
        branch({ id: 'b1', parentBranchId: '', sourceStepId: 'items', itemIndex: 1, label: 'Лёгкий дождь' })
      ])
    )
    const shots = laid.nodes.filter((node) => node.stepId === 'shots').sort((a, b) => a.x - b.x)
    assert.equal(shots.length, 2)
    assert.equal(shots[0].branchId, 'b0')
    assert.equal(shots[1].branchId, 'b1')
    assert.equal(shots[0].y, shots[1].y)
    assert.equal(shots[0].status, 'pending')
    assert.ok(shots[1].x >= shots[0].x + shots[0].w)
  })

  it('places a later batch under the existing items', () => {
    const steps = [
      step({
        id: 'items',
        key: 'items',
        name: 'Шоты',
        type: 'fanout',
        order: 1,
        iterate: { over: '{{steps.prep.output}}', alias: 'item', launch: 'all' },
        config: {}
      })
    ]
    const laid = layoutRun(
      details(steps, [
        branch({ id: 'b0', parentBranchId: '', sourceStepId: 'items', itemIndex: 0, label: 'Первый', batch: 0 }),
        branch({ id: 'b1', parentBranchId: '', sourceStepId: 'items', itemIndex: 1, label: 'Второй', batch: 0 }),
        branch({ id: 'b2', parentBranchId: '', sourceStepId: 'items', itemIndex: 2, label: 'Доп', batch: 1 })
      ])
    )
    const first = laid.nodes.find((node) => node.branchId === 'b0')
    const second = laid.nodes.find((node) => node.branchId === 'b1')
    const extra = laid.nodes.find((node) => node.branchId === 'b2')
    assert.ok(first && second && extra)
    assert.equal(first.y, second.y)
    assert.ok(second.x >= first.x + first.w)
    assert.ok(extra.y >= first.y + first.h)
  })

  it('draws one side branch from the concept item, not under each shot', () => {
    const steps = [
      step({
        id: 'items',
        key: 'items',
        name: 'Элемент концепции',
        type: 'fanout',
        order: 1,
        iterate: { over: '{{steps.prep.output}}', alias: 'concept', launch: 'all' },
        config: {}
      }),
      step({
        id: 'note',
        key: 'note',
        name: 'Комментарий',
        type: 'manual',
        order: 2,
        dependsOn: ['items'],
        config: { mode: 'text', prompt: '' }
      }),
      step({
        id: 'shots',
        key: 'shots',
        name: 'Завершить шоты',
        type: 'fanout',
        order: 3,
        dependsOn: ['note'],
        iterate: { over: '{{steps.note.output}}', alias: 'shot', launch: 'all' },
        config: {}
      }),
      step({
        id: 'json',
        key: 'json',
        name: 'Формирование JSON по шоту',
        type: 'transform',
        order: 4,
        dependsOn: ['shots'],
        config: { mode: 'template', template: '' }
      }),
      step({
        id: 'extra',
        key: 'extra',
        name: 'Дополнительные шоты — требования',
        type: 'manual',
        order: 9,
        dependsOn: ['items'],
        sideBranch: true,
        config: { mode: 'text', prompt: '', allowEmpty: true }
      }),
      step({
        id: 'extra_ai',
        key: 'extra_ai',
        name: 'Формирование дополнительных шотов',
        type: 'transform',
        order: 10,
        dependsOn: ['extra'],
        config: { mode: 'template', template: '' }
      })
    ]
    const laid = layoutRun(
      details(steps, [
        branch({ id: 'c0', parentBranchId: '', sourceStepId: 'items', itemIndex: 0, label: 'Городская динамика' }),
        branch({ id: 's0', parentBranchId: 'c0', sourceStepId: 'shots', itemIndex: 0, label: 'Общий' }),
        branch({ id: 's1', parentBranchId: 'c0', sourceStepId: 'shots', itemIndex: 1, label: 'Деталь' })
      ])
    )
    const concept = laid.nodes.find((node) => node.role === 'item' && node.branchId === 'c0')
    const extras = laid.nodes.filter((node) => node.stepId === 'extra')
    const extraAi = laid.nodes.filter((node) => node.stepId === 'extra_ai')
    const json = laid.nodes.filter((node) => node.stepId === 'json')
    assert.ok(concept)
    assert.equal(extras.length, 1)
    assert.equal(extraAi.length, 1)
    assert.equal(extras[0].branchId, 'c0')
    assert.equal(extraAi[0].branchId, 'c0')
    assert.equal(json.length, 2)
    assert.ok(json.every((node) => node.branchId === 's0' || node.branchId === 's1'))
    assert.ok(laid.edges.some((edge) => edge.from === concept.id && edge.to === extras[0].id))
    assert.ok(extras[0].x >= concept.x + concept.w)
    assert.ok(extraAi[0].y > extras[0].y)
    assert.equal(laid.frames.length, 1)
    assert.equal(laid.frames[0].label, 'Доп. ветка')
    assert.ok(laid.frames[0].x <= extras[0].x)
    assert.ok(laid.frames[0].y <= extras[0].y)
  })

  it('keeps a side chain visible when it contains its own fanout', () => {
    const steps = [
      step({
        id: 'items',
        key: 'items',
        name: 'Элемент концепции',
        type: 'fanout',
        order: 1,
        iterate: { over: '{{steps.prep.output}}', alias: 'concept', launch: 'all' },
        config: {}
      }),
      step({
        id: 'shots',
        key: 'shots',
        name: 'Элемент шота',
        type: 'fanout',
        order: 2,
        dependsOn: ['items'],
        iterate: { over: '{{steps.items.output}}', alias: 'shot', launch: 'all' },
        config: {}
      }),
      step({
        id: 'json',
        key: 'json',
        name: 'Формирование JSON по шоту',
        type: 'transform',
        order: 3,
        dependsOn: ['shots'],
        config: { mode: 'template', template: '' }
      }),
      step({
        id: 'extra',
        key: 'extra',
        name: 'Дополнительные шоты — требования',
        type: 'manual',
        order: 4,
        dependsOn: ['items'],
        sideBranch: true,
        config: { mode: 'text', prompt: '', allowEmpty: true }
      }),
      step({
        id: 'extra_list',
        key: 'extra_list',
        name: 'Разбор дополнительных шотов',
        type: 'transform',
        order: 5,
        dependsOn: ['extra'],
        config: { mode: 'template', template: '' }
      }),
      step({
        id: 'extra_items',
        key: 'extra_items',
        name: 'Элементы дополнительных шотов',
        type: 'fanout',
        order: 6,
        dependsOn: ['extra_list'],
        iterate: { over: '{{steps.extra_list.output}}', alias: 'extra_shot', launch: 'all' },
        config: {}
      }),
      step({
        id: 'extra_json',
        key: 'extra_json',
        name: 'JSON-промпт дополнительного шота',
        type: 'transform',
        order: 7,
        dependsOn: ['extra_items'],
        config: { mode: 'template', template: '' }
      })
    ]
    const laid = layoutRun(
      details(steps, [
        branch({ id: 'c0', parentBranchId: '', sourceStepId: 'items', itemIndex: 0, label: 'Городская динамика' }),
        branch({ id: 's0', parentBranchId: 'c0', sourceStepId: 'shots', itemIndex: 0, label: 'Общий' })
      ])
    )
    const concept = laid.nodes.find((node) => node.role === 'item' && node.branchId === 'c0')
    const extra = laid.nodes.find((node) => node.stepId === 'extra')
    const extraFan = laid.nodes.find((node) => node.stepId === 'extra_items')
    assert.ok(concept && extra && extraFan)
    assert.equal(extra.branchId, 'c0')
    assert.equal(extraFan.branchId, 'c0')
    assert.equal(laid.nodes.filter((node) => node.stepId === 'extra').length, 1)
    assert.ok(laid.edges.some((edge) => edge.from === concept.id && edge.to === extra.id))
    assert.ok(extra.x >= concept.x + concept.w)
  })

  it('places chat presets above the first step', () => {
    const steps = [step({ id: 'ask', key: 'ask', type: 'ai', config: { provider: 'qwen', model: 'qwen', messages: [], outputFormat: 'text' } })]
    const laid = layoutRun({
      ...details(steps, []),
      graph: {
        runtime: 'playwright',
        inputs: [],
        steps,
        chats: [
          { key: 'analyst', instruction: 'смотри', scope: 'run' },
          { key: 'shots', instruction: 'кадр', scope: 'branch' }
        ]
      },
      chats: [
        { key: 'analyst', scope: 'run', branchId: '', label: 'на запуск', status: 'completed', url: 'https://chat.qwen.ai/c/abc', error: null },
        { key: 'shots', scope: 'branch', branchId: '', label: '1 из 2 веток', status: 'running', url: null, error: null }
      ]
    })
    const analyst = laid.nodes.find((node) => node.role === 'chat' && node.title === 'analyst')
    const shots = laid.nodes.find((node) => node.role === 'chat' && node.title === 'shots')
    const ask = laid.nodes.find((node) => node.stepId === 'ask')
    assert.ok(analyst && shots && ask)
    assert.equal(analyst.status, 'completed')
    assert.equal(shots.status, 'running')
    assert.ok(analyst.y + analyst.h < ask.y)
    assert.ok(laid.edges.some((edge) => edge.from === analyst.id && edge.to === `step:ask:`))
  })

  it('grows a node so the full title fits', () => {
    const short = nodeSize('AI', 'AI', 'pending')
    const long = nodeSize('Формирование JSON по шоту для каждой концепции товара', 'Преобразование', 'pending')
    const word = nodeSize('ОченьДлинноеНазваниеБезПробелов', 'элемент', 'pending')
    assert.ok(long.h > short.h)
    assert.ok(long.w >= short.w)
    assert.ok(word.w > short.w + 40)
  })
})
