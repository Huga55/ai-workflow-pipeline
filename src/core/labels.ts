import type { ArtifactKind, ExecutionStatus, InputType, RunStatus, StepType } from '@core/types'

export const STEP_TYPE_LABEL: Record<StepType, string> = {
  ai: 'AI',
  transform: 'Преобразование',
  parse: 'Разбор',
  manual: 'Ручной шаг',
  merge: 'Сборка',
  input: 'Вход'
}

export const STEP_TYPE_HINT: Record<StepType, string> = {
  ai: 'Отправляет промпт выбранной модели и сохраняет ответ. Если задана JSON-схема, ответ проверяется по ней. Исходный текст модели остаётся в запуске.',
  transform: 'Меняет данные без модели: склеить текст из переменных, достать поле, отфильтровать массив или посчитать значение коротким скриптом.',
  parse: 'Разбирает текст предыдущего шага в структуру: JSON, регулярное выражение или разделитель. Если модель уже вернула JSON по схеме, этот шаг обычно не нужен.',
  manual: 'Останавливает ветку и ждёт вас: выбрать элементы, ввести текст, подтвердить результат, поправить его или загрузить файл.',
  merge: 'Собирает результаты нескольких шагов в один объект, чтобы следующий шаг получил их вместе.',
  input: 'Берёт уже заполненные входы запуска и кладёт выбранные из них в результат шага. Нужен, когда в промпт надо отдать не все входы, а только часть, или собрать их в один объект.'
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  draft: 'Черновик',
  running: 'Выполняется',
  paused: 'Пауза',
  completed: 'Завершён',
  failed: 'Ошибка',
  cancelled: 'Отменён'
}

export const EXEC_STATUS_LABEL: Record<ExecutionStatus, string> = {
  pending: 'Ожидает',
  running: 'Выполняется',
  completed: 'Готово',
  failed: 'Ошибка',
  paused: 'Пауза',
  waiting_for_user: 'Ждёт вас',
  skipped: 'Пропущен',
  cancelled: 'Отменён'
}

export const INPUT_TYPE_LABEL: Record<InputType, string> = {
  string: 'Строка',
  text: 'Текст',
  number: 'Число',
  boolean: 'Да / нет',
  image: 'Изображение',
  'image[]': 'Изображения',
  file: 'Файл',
  'file[]': 'Файлы',
  json: 'JSON',
  'json[]': 'JSON-массив',
  select: 'Выбор',
  'multi-select': 'Множественный выбор'
}

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  text: 'Текст',
  json: 'JSON',
  number: 'Число',
  boolean: 'Логическое',
  image: 'Изображение',
  file: 'Файл',
  array: 'Массив',
  object: 'Объект'
}

export function inferKind(value: unknown): ArtifactKind {
  if (isImageValue(value)) return 'image'
  if (isFileValue(value)) return 'file'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'text'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      return value === null ? 'json' : 'object'
    default:
      return 'json'
  }
}

function isImageValue(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { kind?: string }).kind === 'image'
}

function isFileValue(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { kind?: string }).kind === 'file'
}

export function slugify(input: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
  }
  const lower = input.trim().toLowerCase()
  let out = ''
  for (const ch of lower) out += map[ch] ?? ch
  out = out.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_')
  if (!out || !/^[a-z_]/.test(out)) out = `step_${out || 'item'}`
  return out.slice(0, 48)
}

export function uniqueKey(base: string, taken: Set<string>): string {
  let key = base
  let n = 2
  while (taken.has(key)) {
    key = `${base}_${n}`
    n += 1
  }
  return key
}

export function branchLabel(item: unknown, index: number): string {
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>
    for (const field of ['title', 'name', 'label', 'id']) {
      if (typeof record[field] === 'string' && record[field].trim()) return record[field].trim()
    }
  }
  if (typeof item === 'string' && item.trim()) return item.trim().slice(0, 80)
  return `Элемент ${index + 1}`
}

export function formatRunNumber(n: number): string {
  return `Run #${String(n).padStart(3, '0')}`
}

export function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? ''
}
