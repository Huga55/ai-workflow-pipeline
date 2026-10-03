import { readFileSync } from 'node:fs'
import type { AIProvider, AIRequest, AIResponse, ContentPart, ProviderInfo } from '@core/types'

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    implemented: true,
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini']
  },
  { id: 'anthropic', label: 'Anthropic', implemented: false, models: [] },
  { id: 'google', label: 'Google', implemented: false, models: [] },
  { id: 'syntx', label: 'SYNTX', implemented: false, models: [] }
]

export function createProvider(providerId: string, apiKey: string): AIProvider {
  if (providerId === 'openai') return new OpenAIProvider(apiKey)
  const known = PROVIDERS.find((item) => item.id === providerId)
  if (known && !known.implemented) {
    throw new Error(`Провайдер ${known.label} ещё не подключён. Workflow уже может ссылаться на него, вызов добавится отдельно.`)
  }
  throw new Error(`Неизвестный провайдер «${providerId}»`)
}

class OpenAIProvider implements AIProvider {
  readonly id = 'openai'

  constructor(private apiKey: string) {}

  async generate(request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: toOpenAIContent(message.content)
      }))
    }
    if (typeof request.temperature === 'number') body.temperature = request.temperature
    if (typeof request.maxTokens === 'number') body.max_completion_tokens = request.maxTokens
    if (request.outputFormat === 'json') body.response_format = { type: 'json_object' }

    const payload = await this.post(body, signal)
    const content = payload?.choices?.[0]?.message?.content
    const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    return {
      raw,
      providerResponse: payload,
      model: typeof payload.model === 'string' ? payload.model : request.model,
      provider: this.id,
      usage: payload.usage
    }
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<OpenAIPayload> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const payload = (await response.json().catch(() => ({}))) as OpenAIPayload
    if (response.ok) return payload
    if (response.status === 400 && body.max_completion_tokens && !body.max_tokens) {
      const next = { ...body }
      next.max_tokens = next.max_completion_tokens
      delete next.max_completion_tokens
      return this.post(next, signal)
    }
    const message = payload.error?.message || `OpenAI вернул статус ${response.status}`
    const error = new Error(message) as Error & { body?: unknown }
    error.body = payload
    throw error
  }
}

type OpenAIPayload = {
  model?: string
  usage?: unknown
  choices?: { message?: { content?: unknown } }[]
  error?: { message?: string }
}

function toOpenAIContent(parts: ContentPart[]): string | Record<string, unknown>[] {
  const images = parts.filter((part) => part.type === 'image')
  const text = parts
    .filter((part) => part.type === 'text' && part.text.trim())
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
  if (!images.length) return text
  const content: Record<string, unknown>[] = []
  if (text.trim()) content.push({ type: 'text', text })
  for (const part of images) {
    if (part.type !== 'image') continue
    const bytes = readFileSync(part.path)
    content.push({
      type: 'image_url',
      image_url: { url: `data:${part.mime};base64,${bytes.toString('base64')}` }
    })
  }
  return content
}
