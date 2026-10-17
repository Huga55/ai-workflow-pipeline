import { isStoredFile, storedFiles } from '@core/media'
import type { ManualWaiting, StepOutcome, StoredFile, UserActionPayload } from '@core/types'

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
    const files = storedFiles(payload.files ?? [])
    if (!payload.text.trim() && files.length === 0 && !waiting.allowEmpty) return { ok: false, error: 'Введите текст' }
    if (!files.length) return { ok: true, output: payload.text }
    return { ok: true, output: { text: payload.text, files } }
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
    const files = uploadFiles(payload)
    if (!files.length) {
      if (waiting.allowEmpty) return { ok: true, output: null }
      return { ok: false, error: 'Добавьте файл' }
    }
    if (files.some((file) => !isStoredFile(file, expected))) return { ok: false, error: 'Неверный тип файла' }
    return { ok: true, output: files.length === 1 ? files[0] : files }
  }
  return { ok: false, error: 'Неизвестное действие' }
}

function uploadFiles(payload: { file?: StoredFile; files?: StoredFile[] }): StoredFile[] {
  return storedFiles(payload.files?.length ? payload.files : payload.file)
}

export function waitingOutcome(waiting: ManualWaiting, request: unknown): StepOutcome {
  return {
    status: 'waiting_for_user',
    request,
    rawResponse: null,
    meta: { waiting }
  }
}
