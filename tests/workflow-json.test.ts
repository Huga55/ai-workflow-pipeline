import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { builderFlowLayout } from '@core/builder-flow'
import { createNeurophotoGraph } from '@core/template'
import { formatWorkflowJson, parseWorkflowJson } from '@core/workflow-json'

function sequence() {
  let n = 0
  return () => `new-${++n}`
}

describe('workflow json', () => {
  it('печатает объект с отступами и возвращает тот же граф', () => {
    const graph = createNeurophotoGraph()
    const text = formatWorkflowJson({ name: 'Full Product Shoot', description: 'Съёмка', graph })
    assert.match(text, /\n  "name": "Full Product Shoot"/)
    assert.match(text, /\n  "inputs": \[/)
    const parsed = parseWorkflowJson(text)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.document.name, 'Full Product Shoot')
    assert.equal(parsed.document.description, 'Съёмка')
    assert.deepEqual(parsed.document.graph, graph)
  })

  it('собирает workflow по ключам, если id не указаны', () => {
    const parsed = parseWorkflowJson(
      `{
      "name": "Черновик",
      "inputs": [{ "label": "Тема", "type": "text" }],
      "steps": [
        {
          "key": "items",
          "name": "Элементы",
          "type": "fanout",
          "iterate": { "over": "{{inputs.tema}}", "alias": "item", "launch": "manual" }
        },
        {
          "name": "Сборка",
          "type": "merge",
          "dependsOn": ["items"],
          "config": { "mode": "collect", "fromFanoutStepId": "items", "fromStepId": "items" }
        }
      ]
    }`,
      { createId: sequence() }
    )
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.document.description, '')
    assert.equal(parsed.document.graph.inputs[0].id, 'new-1')
    assert.equal(parsed.document.graph.inputs[0].name, 'tema')
    const fanout = parsed.document.graph.steps[0]
    const merge = parsed.document.graph.steps[1]
    assert.equal(fanout.id, 'new-2')
    assert.equal(merge.id, 'new-3')
    assert.equal(merge.key, 'sborka')
    assert.equal(merge.dependsOn[0], fanout.id)
    if (merge.type !== 'merge' || merge.config.mode !== 'collect') throw new Error('ожидалась сборка веток')
    assert.equal(merge.config.fromFanoutStepId, fanout.id)
    assert.equal(merge.config.fromStepId, fanout.id)

    const again = parseWorkflowJson(
      `{
      "name": "Черновик",
      "inputs": [{ "label": "Тема", "type": "text" }],
      "steps": [
        {
          "id": "fake-items",
          "key": "items",
          "name": "Элементы",
          "type": "fanout",
          "iterate": { "over": "{{inputs.tema}}", "alias": "item", "launch": "manual" }
        },
        {
          "id": "fake-pack",
          "key": "sborka",
          "name": "Сборка",
          "type": "merge",
          "dependsOn": ["fake-items"],
          "config": { "mode": "collect", "fromFanoutStepId": "fake-items", "fromStepId": "items" }
        }
      ]
    }`,
      {
        previous: parsed.document.graph,
        createId: () => {
          throw new Error('для известных ключей id уже есть')
        }
      }
    )
    assert.equal(again.ok, true)
    if (!again.ok) return
    assert.equal(again.document.graph.inputs[0].id, parsed.document.graph.inputs[0].id)
    assert.equal(again.document.graph.steps[0].id, fanout.id)
    assert.equal(again.document.graph.steps[1].id, merge.id)
    assert.equal(again.document.graph.steps[1].dependsOn[0], fanout.id)
  })

  it('сообщает о синтаксисе, лишних полях, типах и цикле', () => {
    const syntax = parseWorkflowJson('{')
    assert.equal(syntax.ok, false)
    if (!syntax.ok) assert.match(syntax.errors[0], /Некорректный JSON/)

    const extra = parseWorkflowJson('{"name":"","description":"","inputs":[],"steps":[],"note":1}')
    assert.equal(extra.ok, false)
    if (!extra.ok) assert.match(extra.errors.join('\n'), /неизвестное поле «note»/)

    const badType = parseWorkflowJson(`{
      "inputs": [{ "name": "topic", "type": "markdown" }],
      "steps": [{ "key": "draft", "type": "llm", "config": {} }]
    }`)
    assert.equal(badType.ok, false)
    if (!badType.ok) {
      const text = badType.errors.join('\n')
      assert.match(text, /inputs\[0\]\.type/)
      assert.match(text, /steps\[0\]\.type/)
    }

    const cycle = parseWorkflowJson(`{
      "inputs": [],
      "steps": [
        { "key": "a", "name": "A", "type": "transform", "dependsOn": ["b"], "config": { "mode": "template", "template": "x" } },
        { "key": "b", "name": "B", "type": "transform", "dependsOn": ["a"], "config": { "mode": "template", "template": "y" } }
      ]
    }`)
    assert.equal(cycle.ok, false)
    if (!cycle.ok) assert.match(cycle.errors.join('\n'), /цикл/)
  })

  it('заменяет выдуманный id, если шага с таким ключом ещё нет', () => {
    const parsed = parseWorkflowJson(
      `{
      "inputs": [],
      "steps": [
        { "id": "one", "key": "a", "name": "A", "type": "transform", "config": { "mode": "template", "template": "x" } },
        { "id": "two", "key": "b", "name": "B", "type": "transform", "dependsOn": ["one"], "config": { "mode": "template", "template": "{{steps.a.output}}" } }
      ]
    }`,
      { previous: { inputs: [], steps: [] }, createId: sequence() }
    )
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.document.graph.steps[0].id, 'new-1')
    assert.equal(parsed.document.graph.steps[1].id, 'new-2')
    assert.equal(parsed.document.graph.steps[1].dependsOn[0], 'new-1')
  })

  it('проверяет примеры из описания для ChatGPT', () => {
    const doc = readFileSync(new URL('../docs/workflow-json.md', import.meta.url), 'utf8')
    const blocks = [...doc.matchAll(/```json\r?\n([\s\S]*?)```/g)].filter((block) => block[1].includes('\n  "steps"'))
    assert.ok(blocks.length >= 3)
    for (const block of blocks) {
      const parsed = parseWorkflowJson(block[1], { createId: sequence() })
      assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('\n'))
    }
  })

  it('раскладывает sideBranch в рамку под родителем', () => {
    const concept = {
      id: 'c',
      key: 'each_concept',
      name: 'Концепт',
      description: '',
      type: 'fanout' as const,
      order: 1,
      dependsOn: [],
      stopAfter: false,
      iterate: { over: '{{x}}', alias: 'item', launch: 'all' as const },
      config: {}
    }
    const shots = {
      id: 's',
      key: 'shot_generator',
      name: 'Шоты',
      description: '',
      type: 'transform' as const,
      order: 2,
      dependsOn: ['c'],
      stopAfter: false,
      iterate: null,
      config: { mode: 'template' as const, template: 'a' }
    }
    const brief = {
      id: 'b',
      key: 'extra_brief',
      name: 'Доп. brief',
      description: '',
      type: 'manual' as const,
      order: 3,
      dependsOn: ['c'],
      stopAfter: false,
      iterate: null,
      sideBranch: true,
      config: { mode: 'text' as const, prompt: '?', allowEmpty: true }
    }
    const extra = {
      id: 'e',
      key: 'extra_shots',
      name: 'Доп. шоты',
      description: '',
      type: 'transform' as const,
      order: 4,
      dependsOn: ['b'],
      stopAfter: false,
      iterate: null,
      config: { mode: 'template' as const, template: 'b' }
    }
    const layout = builderFlowLayout([concept, shots, brief, extra])
    assert.equal(layout.blocks.length, 2)
    assert.equal(layout.blocks[0].step.key, 'each_concept')
    assert.equal(layout.blocks[0].sides.length, 1)
    assert.deepEqual(
      layout.blocks[0].sides[0].steps.map((item) => item.key),
      ['extra_brief', 'extra_shots']
    )
    assert.equal(layout.blocks[1].step.key, 'shot_generator')
    assert.equal(layout.orphans.length, 0)
  })

  it('читает snippets, use и appendOnRerun', () => {
    const parsed = parseWorkflowJson(
      `{
      "name": "Ссылки",
      "inputs": [{ "name": "notes", "type": "text" }],
      "snippets": [{ "key": "notes_block", "content": "{{#if inputs.notes}}N:{{inputs.notes}}{{/if}}" }],
      "steps": [
        {
          "key": "base",
          "name": "База",
          "type": "ai",
          "config": {
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "messages": [{ "role": "user", "content": "{{snippets.notes_block}}" }],
            "outputFormat": "text"
          }
        },
        {
          "key": "copy",
          "name": "Копия",
          "type": "ai",
          "use": "base",
          "dependsOn": ["base"]
        },
        {
          "key": "items",
          "name": "Элементы",
          "type": "fanout",
          "dependsOn": ["copy"],
          "iterate": { "over": "{{steps.copy.output}}", "alias": "item", "launch": "all", "appendOnRerun": true }
        }
      ]
    }`,
      { createId: sequence() }
    )
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('\n'))
    if (!parsed.ok) return
    assert.equal(parsed.document.graph.snippets?.[0]?.key, 'notes_block')
    const copy = parsed.document.graph.steps.find((item) => item.key === 'copy')
    assert.equal(copy?.use, 'base')
    assert.equal(copy?.type, 'ai')
    if (copy?.type === 'ai') assert.equal(copy.config.messages[0]?.content, '{{snippets.notes_block}}')
    const items = parsed.document.graph.steps.find((item) => item.key === 'items')
    assert.equal(items?.iterate?.appendOnRerun, true)
  })
})
