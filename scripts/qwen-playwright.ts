import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContentPart } from '../src/core/types.ts'
import { QwenBrowser } from '../src/main/qwen-browser.ts'

const profileDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.qwen-profile')
mkdirSync(profileDir, { recursive: true })

const args = process.argv.slice(2)
let imagePath: string | undefined
const words: string[] = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--image') {
    imagePath = args[index + 1]
    index += 1
    continue
  }
  words.push(args[index])
}
const prompt = words.join(' ').trim() || 'Ответь одним словом: да'
const parts: ContentPart[] = [{ type: 'text', text: prompt }]
if (imagePath) parts.push({ type: 'image', path: imagePath, mime: 'image/png', name: imagePath })

const browser = new QwenBrowser(
  profileDir,
  () => null,
  () => undefined,
  () => ({ token: null, refreshToken: null })
)
try {
  console.log('Открываю чат Qwen. Если спросят вход, войдите в этом окне.')
  const answer = await browser.ensure({ runId: 'manual', chatKey: 'once', branchId: '', parts })
  console.log('\n--- ответ ---\n')
  console.log(answer ?? '')
} finally {
  await browser.close()
}
