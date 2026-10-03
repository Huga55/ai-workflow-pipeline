import { extractJson, validateJsonSchema } from '@core/json'
import { interpolateParts } from '@core/variables'
import type { AIRequest, AIResponse, AIStepConfig, StepOutcome, VariableContext } from '@core/types'

export async function runAiStep(
  config: AIStepConfig,
  ctx: VariableContext,
  generate: (request: AIRequest, signal?: AbortSignal) => Promise<AIResponse>,
  signal?: AbortSignal
): Promise<StepOutcome> {
  const messages = config.messages.map((message) => ({
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
    jsonSchema: config.jsonSchema
  }

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
