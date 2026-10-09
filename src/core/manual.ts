import type { ManualWaiting, StepOutcome, UserActionPayload } from '@core/types'

export function applyManualAction(
  waiting: ManualWaiting,
  payload: UserActionPayload
): { ok: true; output: unknown; stopBranch?: boolean; skipped?: boolean } | { ok: false; error: string } {
  if (payload.type === 'skip') return { ok: true, output: waiting.value ?? null, skipped: true }
  if (payload.type === 'select_one') {
    if (waiting.mode !== 'select_one') return { ok: false, error: 'Этот шаг не ожидает одиночный выбор' }
    const option = waiting.options?.find((item) => item.id === payload.optionId)
    if (!option) return { ok: false, error: 'Выбранный вариант не найден' }
    return { ok: true, output: option.value }
  }
  if (payload.type === 'select_many') {
    if (waiting.mode !== 'select_many') return { ok: false, error: 'Этот шаг не ожидает множественный выбор' }
    const selected = (waiting.options ?? []).filter((item) => payload.optionIds.includes(item.id))
    if (!waiting.allowEmpty && selected.length === 0) return { ok: false, error: 'Выберите хотя бы один элемент' }
    return { ok: true, output: selected.map((item) => item.value) }
  }
  if (payload.type === 'text') {
    if (waiting.mode !== 'text') return { ok: false, error: 'Этот шаг не ожидает текст' }
    if (!payload.text.trim() && !waiting.allowEmpty) return { ok: false, error: 'Введите текст' }
    return { ok: true, output: payload.text }
  }
  if (payload.type === 'confirm') {
    if (waiting.mode !== 'confirm') return { ok: false, error: 'Этот шаг не ожидает подтверждение' }
    if (!payload.accepted) return { ok: true, output: { accepted: false, value: waiting.value ?? null }, stopBranch: true }
    return { ok: true, output: waiting.value ?? { accepted: true } }
  }
  if (payload.type === 'edit_json') {
    if (waiting.mode !== 'edit_json') return { ok: false, error: 'Этот шаг не ожидает правку JSON' }
    return { ok: true, output: payload.value }
  }
  if (payload.type === 'upload') {
    const expected = waiting.mode === 'upload_image' ? 'image' : waiting.mode === 'upload_file' ? 'file' : null
    if (!expected) return { ok: false, error: 'Этот шаг не ожидает файл' }
    if (payload.file.kind !== expected) return { ok: false, error: 'Неверный тип файла' }
    return { ok: true, output: payload.file }
  }
  return { ok: false, error: 'Неизвестное действие' }
}

export function waitingOutcome(waiting: ManualWaiting, request: unknown): StepOutcome {
  return {
    status: 'waiting_for_user',
    request,
    rawResponse: null,
    meta: { waiting }
  }
}
