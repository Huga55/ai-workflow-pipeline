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
    artifacts: []
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

  it('grows a node so the full title fits', () => {
    const short = nodeSize('AI', 'AI', 'pending')
    const long = nodeSize('Формирование JSON по шоту для каждой концепции товара', 'Преобразование', 'pending')
    const word = nodeSize('ОченьДлинноеНазваниеБезПробелов', 'элемент', 'pending')
    assert.ok(long.h > short.h)
    assert.ok(long.w >= short.w)
    assert.ok(word.w > short.w + 40)
  })
})
