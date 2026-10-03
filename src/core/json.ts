import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false })

export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const direct = tryParse(trimmed)
  if (direct.ok) return direct.value
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    const fenced = tryParse(fence[1].trim())
    if (fenced.ok) return fenced.value
  }
  const object = sliceBetween(trimmed, '{', '}')
  if (object) {
    const parsed = tryParse(object)
    if (parsed.ok) return parsed.value
  }
  const array = sliceBetween(trimmed, '[', ']')
  if (array) {
    const parsed = tryParse(array)
    if (parsed.ok) return parsed.value
  }
  throw new Error('Ответ не содержит корректный JSON')
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function sliceBetween(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

export function validateJsonSchema(schema: unknown, data: unknown): { ok: true } | { ok: false; error: string } {
  if (!schema || typeof schema !== 'object') return { ok: true }
  let validate: ReturnType<typeof ajv.compile>
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Некорректная JSON Schema' }
  }
  if (validate(data)) return { ok: true }
  const error = (validate.errors ?? [])
    .map((item) => `${item.instancePath || '/'} ${item.message ?? ''}`.trim())
    .join('\n')
  return { ok: false, error: error || 'JSON не соответствует схеме' }
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key])
  return out
}
