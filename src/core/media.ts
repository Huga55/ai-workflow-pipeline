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

export function isStoredFile(value: unknown, kind?: 'image' | 'file'): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.path !== 'string' || typeof v.mime !== 'string' || typeof v.name !== 'string') return false
  if (kind) return v.kind === kind
  return v.kind === 'image' || v.kind === 'file'
}
