import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/core')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@core/')) {
    const file = path.join(coreDir, `${specifier.slice('@core/'.length)}.ts`)
    return { url: pathToFileURL(file).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
