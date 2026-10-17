export function pathsFromUriList(text: string): string[] {
  const found: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\0/g, '')
    if (!line || line.startsWith('#')) continue
    const filePath = pathFromClipboardToken(line)
    if (filePath && !found.includes(filePath)) found.push(filePath)
  }
  return found
}

function pathFromClipboardToken(line: string): string | null {
  if (/^[a-zA-Z]:[\\/]/.test(line)) return line.replace(/\//g, '\\')
  if (!line.toLowerCase().startsWith('file:')) return null
  try {
    const url = new URL(line.replace(/\\/g, '/'))
    const pathname = decodeURIComponent(url.pathname)
    if (/^\/[a-zA-Z]:\//.test(pathname)) return pathname.slice(1).replace(/\//g, '\\')
    return pathname
  } catch {
    return null
  }
}
