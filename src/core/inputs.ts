import type { InputDefinition, InputType, WorkflowGraph } from '@core/types'

export function emptyInputValue(type: InputType): unknown {
  switch (type) {
    case 'string':
    case 'text':
      return ''
    case 'number':
      return null
    case 'boolean':
      return false
    case 'image':
    case 'file':
    case 'json':
      return null
    case 'image[]':
    case 'file[]':
    case 'json[]':
    case 'multi-select':
      return []
    case 'select':
      return ''
  }
}

export function normalizeInputs(graph: WorkflowGraph, inputs: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const input of graph.inputs) {
    if (inputs[input.name] !== undefined) output[input.name] = inputs[input.name]
    else if (input.defaultValue !== undefined) output[input.name] = input.defaultValue
    else output[input.name] = emptyInputValue(input.type)
  }
  return output
}

export function validateInputs(graph: WorkflowGraph, inputs: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const input of graph.inputs) {
    if (!input.required) continue
    if (isEmpty(input, inputs[input.name])) errors.push(`Заполните «${input.label}»`)
  }
  return errors
}

function isEmpty(input: InputDefinition, value: unknown): boolean {
  if (value == null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (input.type === 'number') return typeof value !== 'number' || Number.isNaN(value)
  return false
}
