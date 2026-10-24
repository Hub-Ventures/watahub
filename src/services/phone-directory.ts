import type { PhoneConfig, PhoneDirectory } from '../deps.js'

export class InMemoryPhoneDirectory implements PhoneDirectory {
  private readonly phones = new Map<string, PhoneConfig>()

  constructor(initial: Record<string, PhoneConfig> | Map<string, PhoneConfig> = {}) {
    if (initial instanceof Map) {
      this.phones = new Map(initial)
    } else {
      for (const [id, cfg] of Object.entries(initial)) {
        this.phones.set(id, cfg)
      }
    }
  }

  set(phoneNumberId: string, config: PhoneConfig): void {
    this.phones.set(phoneNumberId, config)
  }

  get(phoneNumberId: string): PhoneConfig | undefined {
    return this.phones.get(phoneNumberId)
  }

  delete(phoneNumberId: string): boolean {
    return this.phones.delete(phoneNumberId)
  }

  clear(): void {
    this.phones.clear()
  }

  lookup(phoneNumberId: string): Promise<PhoneConfig | null> {
    return Promise.resolve(this.phones.get(phoneNumberId) ?? null)
  }
}

export const defaultPhoneDirectory = new InMemoryPhoneDirectory()
