const PLACEHOLDER_CHAT_IDS = new Set(['guest', 'new-chat'])

/** Идентификатор чата из адреса Qwen. Служебные /c/guest и /c/new-chat адресом чата не считаются. */
export function chatIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const match = url.match(/\/c\/([A-Za-z0-9-]{8,})\/?(?:[?#].*)?$/)
  if (!match || PLACEHOLDER_CHAT_IDS.has(match[1])) return null
  return match[1]
}
