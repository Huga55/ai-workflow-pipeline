import type { StoredFile } from '@core/types'

export function encodePath(path: string): string {
  const bytes = new TextEncoder().encode(path)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function decodePath(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const bin = atob(padded + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function toMediaUrl(absPath: string): string {
  return `pipeline://local/${encodePath(absPath)}`
}

export function isStoredFile(value: unknown, kind?: 'image' | 'file'): value is StoredFile {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.path !== 'string' || typeof v.mime !== 'string' || typeof v.name !== 'string') return false
  if (kind) return v.kind === kind
  return v.kind === 'image' || v.kind === 'file'
}

export function storedFiles(value: unknown): StoredFile[] {
  if (Array.isArray(value)) return value.filter((item) => isStoredFile(item))
  return isStoredFile(value) ? [value] : []
}

export function isTextWithFiles(value: unknown): value is { text: string; files: StoredFile[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.text === 'string' && Array.isArray(record.files) && record.files.length > 0 && record.files.every((item) => isStoredFile(item))
}

export function textWithFilesDisplay(value: { text: string; files: StoredFile[] }): string {
  const names = value.files.map((file) => file.name).filter(Boolean)
  if (!value.text) return names.join('\n')
  if (!names.length) return value.text
  return `${value.text}\n${names.join('\n')}`
}
