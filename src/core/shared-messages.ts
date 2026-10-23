import { createId } from '@core/ids'
import { slugify, uniqueKey } from '@core/labels'
import type { AIMessageBody, AIMessageDraft, AIMessageRef, MessageWhen, SharedMessage, StepDefinition, WorkflowGraph } from '@core/types'

export function isSharedRef(message: AIMessageDraft): message is AIMessageRef {
  return 'shared' in message
}

export function messageSignature(message: Pick<AIMessageBody, 'role' | 'content' | 'when'>): string {
  const when = message.when ? `${message.when.op}\0${message.when.paths.join('\0')}` : ''
  return `${message.role}\0${message.content}\0${when}`
}

export function resolveMessage(message: AIMessageDraft, shared: readonly SharedMessage[]): AIMessageBody | null {
  if (!isSharedRef(message)) return message
  const found = shared.find((item) => item.key === message.shared)
  if (!found) return null
  return found.when
    ? { id: message.id, role: found.role, content: found.content, when: found.when }
    : { id: message.id, role: found.role, content: found.content }
}

export function messagePreview(content: string): string {
  const line = content.trim().split('\n')[0] ?? ''
  if (!line) return 'пустое сообщение'
  return line.length > 72 ? `${line.slice(0, 72)}…` : line
}

export type DuplicateMessagePlace = { stepId: string; stepName: string }

export type DuplicateMessageGroup = {
  signature: string
  preview: string
  places: DuplicateMessagePlace[]
  sharedKey?: string
}

export function findDuplicateGroups(graph: WorkflowGraph): DuplicateMessageGroup[] {
  const bySignature = new Map<string, { body: AIMessageBody; places: DuplicateMessagePlace[] }>()
  for (const step of ownedAiSteps(graph)) {
    for (const message of step.config.messages) {
      if (isSharedRef(message) || !message.content.trim()) continue
      const signature = messageSignature(message)
      const bucket = bySignature.get(signature) ?? { body: message, places: [] }
      if (!bucket.places.some((place) => place.stepId === step.id)) {
        bucket.places.push({ stepId: step.id, stepName: step.name })
      }
      bySignature.set(signature, bucket)
    }
  }
  const groups: DuplicateMessageGroup[] = []
  for (const [signature, bucket] of bySignature) {
    if (bucket.places.length < 2) continue
    groups.push({
      signature,
      preview: messagePreview(bucket.body.content),
      places: bucket.places,
      sharedKey: sharedKeyFor(graph, signature)
    })
  }
  return groups
}

export function matchingSharedKey(graph: WorkflowGraph, message: AIMessageDraft): string | undefined {
  if (isSharedRef(message)) return undefined
  return sharedKeyFor(graph, messageSignature(message))
}

/** Сворачивает все одинаковые свои сообщения шагов в одну ссылку. */
export function shareMatchingMessages(graph: WorkflowGraph, signature: string, nextId: () => string = createId): WorkflowGraph {
  const inline = inlineMatches(graph, signature)
  if (!inline.length) return graph
  const stepsWithCopy = new Set(inline.map((item) => item.stepId))
  let shared = graph.sharedMessages ?? []
  let key = sharedKeyFor(graph, signature)
  if (!key && stepsWithCopy.size < 2) return graph
  if (!key) {
    const sample = inline[0]?.message
    if (!sample || isSharedRef(sample)) return graph
    const taken = new Set(shared.map((item) => item.key))
    key = uniqueKey(slugify(sample.content.split('\n')[0] || 'message'), taken)
    const name = messagePreview(sample.content)
    const created: SharedMessage = sample.when
      ? { id: nextId(), key, name, role: sample.role, content: sample.content, when: sample.when }
      : { id: nextId(), key, name, role: sample.role, content: sample.content }
    shared = [...shared, created]
  }
  return {
    ...graph,
    sharedMessages: shared,
    steps: replaceSignature(graph.steps, signature, key)
  }
}

/** Удаляет общее сообщение и возвращает его текст в каждый шаг, где стояла ссылка. */
export function expandSharedMessage(graph: WorkflowGraph, key: string): WorkflowGraph {
  const shared = (graph.sharedMessages ?? []).find((item) => item.key === key)
  if (!shared) return graph
  return {
    ...graph,
    sharedMessages: (graph.sharedMessages ?? []).filter((item) => item.key !== key),
    steps: graph.steps.map((step) => {
      if (step.type !== 'ai') return step
      return {
        ...step,
        config: {
          ...step.config,
          messages: step.config.messages.map((message) => {
            if (!isSharedRef(message) || message.shared !== key) return message
            return shared.when
              ? { id: message.id, role: shared.role, content: shared.content, when: shared.when }
              : { id: message.id, role: shared.role, content: shared.content }
          })
        }
      }
    })
  }
}

export function retargetSharedKey(steps: StepDefinition[], previousKey: string, key: string): StepDefinition[] {
  if (previousKey === key) return steps
  return steps.map((step) => {
    if (step.type !== 'ai') return step
    return {
      ...step,
      config: {
        ...step.config,
        messages: step.config.messages.map((message) =>
          isSharedRef(message) && message.shared === previousKey ? { ...message, shared: key } : message
        )
      }
    }
  })
}

function sharedKeyFor(graph: WorkflowGraph, signature: string): string | undefined {
  return (graph.sharedMessages ?? []).find((item) => messageSignature(item) === signature)?.key
}

function ownedAiSteps(graph: WorkflowGraph): Extract<StepDefinition, { type: 'ai' }>[] {
  return graph.steps.filter((step): step is Extract<StepDefinition, { type: 'ai' }> => step.type === 'ai' && !step.use)
}

function inlineMatches(graph: WorkflowGraph, signature: string): { stepId: string; message: AIMessageDraft }[] {
  const out: { stepId: string; message: AIMessageDraft }[] = []
  for (const step of ownedAiSteps(graph)) {
    for (const message of step.config.messages) {
      if (isSharedRef(message)) continue
      if (messageSignature(message) === signature) out.push({ stepId: step.id, message })
    }
  }
  return out
}

function replaceSignature(steps: StepDefinition[], signature: string, key: string): StepDefinition[] {
  return steps.map((step) => {
    if (step.use || step.type !== 'ai') return step
    return {
      ...step,
      config: {
        ...step.config,
        messages: step.config.messages.map((message) => {
          if (isSharedRef(message) || messageSignature(message) !== signature) return message
          return { id: message.id, shared: key }
        })
      }
    }
  })
}

export function whenText(when: MessageWhen | undefined): string {
  if (!when) return 'отправляется всегда'
  const how = when.op === 'and' ? 'все переменные' : 'хотя бы одна переменная'
  const paths = when.paths.filter((path) => path.trim())
  return paths.length ? `если ${how}: ${paths.join(', ')}` : `если ${how}`
}
