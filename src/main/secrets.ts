import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

type SecretFile = Record<string, string>

export class SecretStore {
  constructor(private filePath: string) {}

  get(providerId: string): string | null {
    const secrets = this.read()
    const encoded = secrets[providerId]
    if (!encoded) return null
    if (!safeStorage.isEncryptionAvailable()) return Buffer.from(encoded, 'base64').toString('utf8')
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  }

  set(providerId: string, apiKey: string): void {
    const secrets = this.read()
    const buffer = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(apiKey.trim())
      : Buffer.from(apiKey.trim(), 'utf8')
    secrets[providerId] = buffer.toString('base64')
    this.write(secrets)
  }

  clear(providerId: string): void {
    const secrets = this.read()
    delete secrets[providerId]
    this.write(secrets)
  }

  has(providerId: string): boolean {
    return Boolean(this.read()[providerId])
  }

  entries(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const providerId of Object.keys(this.read())) {
      const value = this.get(providerId)
      if (value) out[providerId] = value
    }
    return out
  }

  private read(): SecretFile {
    if (!existsSync(this.filePath)) return {}
    return JSON.parse(readFileSync(this.filePath, 'utf8')) as SecretFile
  }

  private write(secrets: SecretFile): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(secrets), 'utf8')
  }
}
