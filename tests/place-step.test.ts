import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { placeStepAfterDependency } from '@core/builder-flow'
import type { StepDefinition } from '@core/types'

function step(id: string, order: number, dependsOn: string[] = [], sideBranch = false): StepDefinition {
  return {
    id,
    key: id,
    name: id,
    description: '',
    type: 'transform',
    order,
    dependsOn,
    stopAfter: false,
    iterate: null,
    ...(sideBranch ? { sideBranch: true } : {}),
    config: { mode: 'template', template: '' }
  }
}

function ids(steps: StepDefinition[]) {
  return [...steps].sort((a, b) => a.order - b.order).map((item) => item.id)
}

describe('placeStepAfterDependency', () => {
  it('ставит шаг основной ветки сразу после зависимости', () => {
    const steps = [
      step('a', 1),
      step('b', 2, ['a']),
      step('c', 3, ['a'])
    ]
    assert.deepEqual(ids(placeStepAfterDependency(steps, 'c')), ['a', 'c', 'b'])
  })

  it('держит доп. ветки целиком перед продолжением основной ветки', () => {
    const steps = [
      step('a', 1),
      step('b', 2, ['a']),
      step('s1', 10, ['a'], true),
      step('s1b', 11, ['s1']),
      step('s2', 12, ['a'], true)
    ]
    assert.deepEqual(ids(placeStepAfterDependency(steps, 's2')), ['a', 's1', 's1b', 's2', 'b'])
  })

  it('новую доп. ветку ставит после уже существующих, а основной шаг — после веток', () => {
    const steps = [
      step('a', 1),
      step('b', 2, ['a']),
      step('s1', 3, ['a'], true),
      step('s1b', 4, ['s1']),
      step('s2', 5, ['a'], true),
      step('d', 6, ['a'], true)
    ]
    assert.deepEqual(ids(placeStepAfterDependency(steps, 'd')), ['a', 's1', 's1b', 's2', 'd', 'b'])
  })

  it('основной шаг, который зависит от общей опоры, встаёт после всех её доп. веток', () => {
    const steps = [
      step('a', 1),
      step('b', 2, ['a']),
      step('s1', 3, ['a'], true),
      step('s1b', 4, ['s1']),
      step('s2', 5, ['a'], true),
      step('d', 6, ['a'])
    ]
    assert.deepEqual(ids(placeStepAfterDependency(steps, 'd')), ['a', 's1', 's1b', 's2', 'd', 'b'])
  })

  it('шаг внутри доп. ветки встаёт сразу после своей зависимости', () => {
    const steps = [
      step('r', 1),
      step('s', 2, ['r'], true),
      step('a', 3, ['s']),
      step('b', 4, ['s']),
      step('x', 10, ['a'])
    ]
    assert.deepEqual(ids(placeStepAfterDependency(steps, 'x')), ['r', 's', 'a', 'x', 'b'])
  })

  it('не меняет порядок, если зависимости зациклены', () => {
    const steps = [step('a', 1, ['b']), step('b', 4, ['a'])]
    const placed = placeStepAfterDependency(steps, 'a')
    assert.equal(placed, steps)
  })
})
