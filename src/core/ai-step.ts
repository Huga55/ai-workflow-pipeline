import { extractJson, validateJsonSchema } from '@core/json'
import { interpolateParts, messageAllowed } from '@core/variables'
import type { AIRequest, AIResponse, AIStepConfig, ContentPart, StepOutcome, VariableContext, WorkflowRuntime } from '@core/types'

export type AiStepCall = {
  runtime: WorkflowRuntime
  runId: string
  branchId: string
}

export async function runAiStep(
  config: AIStepConfig,
  ctx: VariableContext,
  generate: (request: AIRequest, signal?: AbortSignal) => Promise<AIResponse>,
  signal?: AbortSignal,
  call?: AiStepCall
): Promise<StepOutcome> {
  const active = config.messages.filter((message) => messageAllowed(message.when, ctx))
  if (!active.length) {
    return { status: 'failed', error: 'Все сообщения пропущены: условие не выполнилось', rawResponse: null }
  }
  const messages = active.map((message) => ({
    role: message.role,
    content: interpolateParts(message.content, ctx)
  }))
  if (call?.runtime === 'playwright') {
    const turns = playwrightTurns(messages, config)
    if (!turns.length) return { status: 'failed', error: 'Пустое сообщение в чат', rawResponse: null }
    const request: AIRequest = {
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
    return finishAiStep(config, request, generate, signal)
  }
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

  return finishAiStep(config, request, generate, signal)
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
