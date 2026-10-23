import { extractJson, validateJsonSchema } from '@core/json'
import { isSharedRef, resolveMessage } from '@core/shared-messages'
import { interpolateParts, messageAllowed } from '@core/variables'
import type {
  AIMessageBody,
  AIRequest,
  AIResponse,
  AIStepConfig,
  ContentPart,
  SharedMessage,
  StepMessageProgress,
  StepMessageStatus,
  StepOutcome,
  VariableContext,
  WorkflowRuntime
} from '@core/types'

export type AiStepCall = {
  runtime: WorkflowRuntime
  runId: string
  branchId: string
  sharedMessages?: SharedMessage[]
  /** С этого сообщения слать в чат. Более ранние уже считаются прошедшими. */
  fromMessageId?: string
  onMessages?: (messages: StepMessageProgress[]) => void
}

export async function runAiStep(
  config: AIStepConfig,
  ctx: VariableContext,
  generate: (request: AIRequest, signal?: AbortSignal) => Promise<AIResponse>,
  signal?: AbortSignal,
  call?: AiStepCall
): Promise<StepOutcome> {
  const bodies: AIMessageBody[] = []
  for (const message of config.messages) {
    const body = resolveMessage(message, call?.sharedMessages ?? [])
    if (!body) {
      const key = isSharedRef(message) ? message.shared : ''
      return { status: 'failed', error: `Нет общего сообщения «${key}»`, rawResponse: null }
    }
    bodies.push(body)
  }
  const active = bodies.filter((message) => messageAllowed(message.when, ctx))
  const progress = bodies.map((message) => ({
    id: message.id,
    status: (active.some((item) => item.id === message.id) ? 'pending' : 'skipped') as StepMessageStatus
  }))
  if (!active.length) return failStep('Все сообщения пропущены: условие не выполнилось', progress, call)

  if (call?.runtime === 'playwright') return runPlaywright(config, ctx, bodies, active, progress, generate, signal, call)

  const messages = active.map((message) => ({
    role: message.role,
    content: interpolateParts(message.content, ctx)
  }))
  if (config.outputFormat === 'json') {
    const schemaText = config.jsonSchema ? `\n${JSON.stringify(config.jsonSchema, null, 2)}` : ''
    messages.push({
      role: 'system',
      content: [
        {
          type: 'text',
          text: config.jsonSchema
            ? `Return only valid JSON matching this JSON Schema.${schemaText}`
            : 'Return only valid JSON.'
        }
      ]
    })
  }

  const request: AIRequest = {
    provider: config.provider,
    model: config.model,
    messages,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    outputFormat: config.outputFormat,
    jsonSchema: config.jsonSchema,
    runtime: 'api'
  }

  const outcome = await finishAiStep(config, request, generate, signal)
  const next: StepMessageStatus = outcome.status === 'completed' ? 'completed' : 'failed'
  for (const row of progress) {
    if (row.status === 'pending') row.status = next
  }
  return attachMessages(outcome, progress, call)
}

async function runPlaywright(
  config: AIStepConfig,
  ctx: VariableContext,
  bodies: AIMessageBody[],
  active: AIMessageBody[],
  progress: StepMessageProgress[],
  generate: (request: AIRequest, signal?: AbortSignal) => Promise<AIResponse>,
  signal: AbortSignal | undefined,
  call: AiStepCall
): Promise<StepOutcome> {
  for (const message of active) {
    if (message.role === 'user') continue
    const row = progress.find((item) => item.id === message.id)
    if (row) row.status = 'skipped'
  }
  const queue = active.filter((message) => message.role === 'user')
  const started = queueFrom(bodies, queue, progress, call.fromMessageId)
  if (!started.ok) return failStep(started.error, progress, call)
  const messages = started.sending.map((message) => ({
    role: message.role,
    content: interpolateParts(message.content, ctx)
  }))
  const turns = playwrightTurns(messages, config)
  if (!turns.length) return failStep('Пустое сообщение в чат', progress, call)

  const planned: AIRequest = {
    provider: 'qwen',
    model: config.model || 'qwen',
    messages: turns.map((content) => ({ role: 'user', content })),
    outputFormat: config.outputFormat,
    jsonSchema: config.jsonSchema,
    runtime: 'playwright',
    chat: config.chat,
    runId: call.runId,
    branchId: call.branchId
  }
  const replies: string[] = []
  let last: AIResponse | null = null
  for (let index = 0; index < turns.length; index += 1) {
    const id = started.sending[index]?.id
    if (!id) break
    setStatus(progress, id, 'running')
    publish(progress, call)
    try {
      const response = await generate({ ...planned, messages: [{ role: 'user', content: turns[index] ?? [] }] }, signal)
      replies.push(response.raw)
      last = response
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка AI-провайдера'
      setStatus(progress, id, 'failed', message)
      publish(progress, call)
      return {
        status: 'failed',
        error: message,
        request: planned,
        rawResponse: message,
        meta: { messages: snapshot(progress) }
      }
    }
    setStatus(progress, id, 'completed')
    publish(progress, call)
  }
  if (!last) return failStep('Пустое сообщение в чат', progress, call)
  const merged: AIResponse = { ...last, providerResponse: mergeTurns(last.providerResponse, replies) }
  const outcome = await finishAiStep(config, planned, async () => merged, signal)
  return attachMessages(outcome, progress, call)
}

/** Сообщения до выбранного в чат уже ушли: помечаем их прошедшими и не шлём снова. */
function queueFrom(
  bodies: AIMessageBody[],
  queue: AIMessageBody[],
  progress: StepMessageProgress[],
  fromMessageId?: string
): { ok: true; sending: AIMessageBody[] } | { ok: false; error: string } {
  const fromId = fromMessageId?.trim()
  if (!fromId) return { ok: true, sending: queue }
  const at = bodies.findIndex((message) => message.id === fromId)
  if (at < 0) return { ok: false, error: 'Нет такого сообщения' }
  const start = queue.findIndex((message) => bodies.findIndex((item) => item.id === message.id) >= at)
  if (start < 0) return { ok: false, error: 'С этого сообщения отправлять нечего' }
  for (const message of queue.slice(0, start)) setStatus(progress, message.id, 'completed')
  return { ok: true, sending: queue.slice(start) }
}

function setStatus(progress: StepMessageProgress[], id: string, status: StepMessageStatus, error?: string) {
  const row = progress.find((item) => item.id === id)
  if (!row) return
  row.status = status
  if (error) row.error = error
  else delete row.error
}

function snapshot(progress: StepMessageProgress[]): StepMessageProgress[] {
  return progress.map((row) => ({ ...row }))
}

function publish(progress: StepMessageProgress[], call?: AiStepCall) {
  call?.onMessages?.(snapshot(progress))
}

function attachMessages(outcome: StepOutcome, progress: StepMessageProgress[], call?: AiStepCall): StepOutcome {
  const messages = snapshot(progress)
  publish(progress, call)
  return { ...outcome, meta: { ...(outcome.meta ?? {}), messages } }
}

function failStep(error: string, progress: StepMessageProgress[], call?: AiStepCall): StepOutcome {
  const messages = snapshot(progress)
  call?.onMessages?.(messages)
  return { status: 'failed', error, rawResponse: null, meta: { messages } }
}

function mergeTurns(providerResponse: unknown, turns: string[]): unknown {
  const base = providerResponse && typeof providerResponse === 'object' ? { ...(providerResponse as Record<string, unknown>) } : {}
  return { ...base, turns }
}

function playwrightTurns(
  messages: { role: 'system' | 'user' | 'assistant'; content: ContentPart[] }[],
  config: AIStepConfig
): ContentPart[][] {
  const turns = messages.filter((message) => message.role === 'user').map((message) => message.content)
  if (!turns.length) return []
  if (turns.some((parts) => !parts.some((part) => (part.type === 'text' ? part.text.trim() : true)))) return []
  if (config.outputFormat !== 'json') return turns
  const schemaText = config.jsonSchema ? `\n${JSON.stringify(config.jsonSchema, null, 2)}` : ''
  const note = config.jsonSchema
    ? `Return only valid JSON matching this JSON Schema.${schemaText}`
    : 'Return only valid JSON.'
  const lastTurn = turns[turns.length - 1]
  const last = lastTurn[lastTurn.length - 1]
  if (last?.type === 'text') last.text = last.text.trim() ? `${last.text}\n\n${note}` : note
  else lastTurn.push({ type: 'text', text: note })
  return turns
}

async function finishAiStep(
  config: AIStepConfig,
  request: AIRequest,
  generate: (request: AIRequest, signal?: AbortSignal) => Promise<AIResponse>,
  signal?: AbortSignal
): Promise<StepOutcome> {
  let response: AIResponse
  try {
    response = await generate(request, signal)
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Ошибка AI-провайдера',
      request,
      rawResponse: error instanceof Error ? error.message : null
    }
  }

  if (config.outputFormat === 'text') {
    return {
      status: 'completed',
      output: response.raw,
      request,
      rawResponse: response.raw,
      meta: {
        provider: response.provider,
        model: response.model,
        providerResponse: response.providerResponse,
        usage: response.usage
      }
    }
  }

  try {
    const parsed = extractJson(response.raw)
    if (config.jsonSchema) {
      const validated = validateJsonSchema(config.jsonSchema, parsed)
      if (!validated.ok) {
        return {
          status: 'failed',
          error: `Проверка схемы не пройдена:\n${validated.error}`,
          request,
          rawResponse: response.raw,
          parsed,
          meta: {
            provider: response.provider,
            model: response.model,
            providerResponse: response.providerResponse,
            usage: response.usage
          }
        }
      }
    }
    return {
      status: 'completed',
      output: parsed,
      request,
      rawResponse: response.raw,
      parsed,
      meta: {
        provider: response.provider,
        model: response.model,
        providerResponse: response.providerResponse,
        usage: response.usage
      }
    }
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Не удалось разобрать JSON',
      request,
      rawResponse: response.raw,
      meta: {
        provider: response.provider,
        model: response.model,
        providerResponse: response.providerResponse,
        usage: response.usage
      }
    }
  }
}
