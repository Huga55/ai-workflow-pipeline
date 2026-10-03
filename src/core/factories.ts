import { createId } from '@core/ids'
import { slugify, uniqueKey } from '@core/labels'
import type {
  AIStepConfig,
  InputDefinition,
  InputType,
  IterateConfig,
  ManualStepConfig,
  MergeStepConfig,
  ParseStepConfig,
  StepDefinition,
  StepType,
  TransformStepConfig,
  WorkflowGraph
} from '@core/types'

export function emptyGraph(): WorkflowGraph {
  return { inputs: [], steps: [] }
}

export function createInput(partial: Partial<InputDefinition> & { label?: string } = {}): InputDefinition {
  const label = partial.label ?? 'Новый вход'
  return {
    id: createId(),
    name: partial.name ?? slugify(label),
    label,
    type: partial.type ?? 'string',
    required: partial.required ?? false,
    description: partial.description ?? '',
    defaultValue: partial.defaultValue,
    options: partial.options
  }
}

export function createStep(type: StepType, graph: WorkflowGraph, name?: string): StepDefinition {
  const taken = new Set(graph.steps.map((step) => step.key))
  const label = name ?? defaultStepName(type)
  const order = graph.steps.reduce((max, step) => Math.max(max, step.order), 0) + 1
  const previous = [...graph.steps].sort((a, b) => a.order - b.order).at(-1)
  const base = {
    id: createId(),
    key: uniqueKey(slugify(label), taken),
    name: label,
    description: '',
    order,
    dependsOn: previous ? [previous.id] : [],
    stopAfter: false,
    iterate: null as IterateConfig | null
  }
  switch (type) {
    case 'ai':
      return { ...base, type, config: defaultAiConfig() }
    case 'transform':
      return { ...base, type, config: { mode: 'template', template: '' } }
    case 'parse':
      return { ...base, type, config: { source: '', mode: 'json' } }
    case 'manual':
      return {
        ...base,
        type,
        config: { mode: 'select_many', source: '', prompt: 'Выберите элементы', labelField: 'title', descriptionField: 'description' }
      }
    case 'merge':
      return { ...base, type, config: { mode: 'object', sources: [{ key: 'value', ref: '' }] } }
    case 'input':
      return { ...base, type, config: { keys: graph.inputs.map((input) => input.name) } }
  }
}

function defaultStepName(type: StepType): string {
  switch (type) {
    case 'ai':
      return 'AI шаг'
    case 'transform':
      return 'Преобразование'
    case 'parse':
      return 'Разбор'
    case 'manual':
      return 'Ручной шаг'
    case 'merge':
      return 'Сборка'
    case 'input':
      return 'Входные данные'
  }
}

export function defaultAiConfig(): AIStepConfig {
  return {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    temperature: 0.7,
    messages: [
      { id: createId(), role: 'system', content: '' },
      { id: createId(), role: 'user', content: '' }
    ],
    outputFormat: 'json'
  }
}

export function inputTypeNeedsOptions(type: InputType): boolean {
  return type === 'select' || type === 'multi-select'
}

export type { TransformStepConfig, ParseStepConfig, ManualStepConfig, MergeStepConfig }
