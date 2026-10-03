export function createId(): string {
  return globalThis.crypto.randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}
