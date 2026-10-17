import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false })

export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const direct = tryParse(trimmed)
  if (direct.ok) return direct.value
  const withoutGutter = stripCodeGutter(trimmed)
  if (withoutGutter !== trimmed) {
    const stripped = tryParse(withoutGutter)
    if (stripped.ok) return stripped.value
  }
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

/** Пробует обычный разбор, затем экранирует кавычки внутри строк и висячие запятые. Не бросает исключение. */
export function repairJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    if (!text.trim()) return { ok: false, error: 'Не удалось починить JSON: ответ пустой.' }
    const seen = new Set<string>()
    for (const source of jsonCandidates(text)) {
      if (seen.has(source)) continue
      seen.add(source)
      const escaped = escapeLooseQuotes(source)
      for (const variant of [source, escaped, stripTrailingCommas(source), stripTrailingCommas(escaped)]) {
        const parsed = tryParse(variant)
        if (parsed.ok) return parsed
      }
    }
    return { ok: false, error: 'Не удалось починить JSON. В ответе другая ошибка, кнопка её не исправляет.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Не удалось починить JSON' }
  }
}

export function stripCodeGutter(text: string): string {
  const lines = text.replace(/\u00a0/g, ' ').split('\n')
  let index = 0
  while (index < lines.length && !lines[index].trim()) index += 1
  if (/^(json|javascript|js|ts|txt|text)$/i.test(lines[index]?.trim() ?? '')) index += 1
  const numbersAt = index
  while (index < lines.length && /^\d+$/.test(lines[index].trim())) index += 1
  if (index - numbersAt < 3) return text.trim()
  return lines.slice(index).join('\n').trim()
}

export function stitchChunks(chunks: string[]): string {
  let acc: string[] = []
  for (const chunk of chunks) {
    const next = chunk.split('\n')
    if (!acc.length) {
      acc = next
      continue
    }
    let overlap = 0
    const limit = Math.min(acc.length, next.length)
    for (let size = limit; size > 0; size -= 1) {
      const same = acc.slice(-size).every((line, index) => line.trim() === next[index]?.trim())
      if (same) {
        overlap = size
        break
      }
    }
    acc = acc.concat(next.slice(overlap))
  }
  return acc.join('\n')
}

function jsonCandidates(text: string): string[] {
  const trimmed = text.trim().replace(/^\uFEFF/, '')
  const list = [trimmed]
  const withoutGutter = stripCodeGutter(trimmed)
  if (withoutGutter !== trimmed) list.push(withoutGutter)
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) list.push(fence[1].trim())
  const extras: string[] = []
  for (const source of list) {
    const object = sliceBetween(source, '{', '}')
    const array = sliceBetween(source, '[', ']')
    if (object) extras.push(object)
    if (array) extras.push(array)
  }
  return [...list, ...extras]
}

function escapeLooseQuotes(text: string): string {
  const out: string[] = []
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (!inString) {
      out.push(char)
      if (char === '"') inString = true
      continue
    }
    if (escaped) {
      out.push(char)
      escaped = false
      continue
    }
    if (char === '\\') {
      out.push(char)
      escaped = true
      continue
    }
    if (char === '"') {
      if (closesString(text, index + 1)) {
        out.push(char)
        inString = false
      } else out.push('\\"')
      continue
    }
    if (char === '\n') {
      out.push('\\n')
      continue
    }
    if (char === '\r') {
      out.push('\\r')
      continue
    }
    out.push(char)
  }
  return out.join('')
}

function closesString(text: string, from: number): boolean {
  let index = from
  while (index < text.length && /\s/.test(text[index])) index += 1
  if (index >= text.length) return true
  const next = text[index]
  return next === ',' || next === '}' || next === ']' || next === ':'
}

function stripTrailingCommas(text: string): string {
  const out: string[] = []
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out.push(char)
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out.push(char)
      continue
    }
    if (char === ',') {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next])) next += 1
      if (text[next] === '}' || text[next] === ']') continue
    }
    out.push(char)
  }
  return out.join('')
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
