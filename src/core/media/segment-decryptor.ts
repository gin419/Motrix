import { createDecipheriv } from 'node:crypto'
import { admitHttpSource } from '@core/task/source-admission'
import { cancelResponseBody, fetchSource } from './fetch-source'

type FetchKey = (
  uri: string,
  headers: Record<string, string>
) => Promise<Uint8Array>

export class SegmentDecryptor {
  private keyCache: Map<string, Promise<Uint8Array>>

  private defaultFetchKey: FetchKey

  constructor(fetchKey?: FetchKey) {
    this.keyCache = new Map()

    if (fetchKey) {
      this.defaultFetchKey = fetchKey
    } else {
      this.defaultFetchKey = async (uri, headers) => {
        const response = await fetchSource(uri, { headers })
        if (!response.ok) {
          await cancelResponseBody(response)
          throw new Error(`Key request failed: HTTP ${response.status}`)
        }
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Key must be 16 bytes')
        const key = new Uint8Array(16)
        let size = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (size + value.byteLength > key.length)
              throw new Error('Key must be 16 bytes')
            key.set(value, size)
            size += value.byteLength
          }
          if (size !== key.length) throw new Error('Key must be 16 bytes')
          return key
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      }
    }
  }

  decrypt(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
    // Validate key and IV lengths
    if (key.length !== 16) {
      throw new Error(`Key must be 16 bytes, got ${key.length}`)
    }
    if (iv.length !== 16) {
      throw new Error(`IV must be 16 bytes, got ${iv.length}`)
    }

    // Convert Uint8Array to Buffer for crypto operations
    const keyBuffer = Buffer.from(key)
    const ivBuffer = Buffer.from(iv)
    const ciphertextBuffer = Buffer.from(ciphertext)

    // Try with PKCS7 auto-padding first
    try {
      const decipher = createDecipheriv('aes-128-cbc', keyBuffer, ivBuffer)
      const plaintext = Buffer.concat([
        decipher.update(ciphertextBuffer),
        decipher.final(),
      ])
      return new Uint8Array(plaintext)
    } catch (err) {
      // Only fall back if error is PKCS7-padding related
      const msg = err instanceof Error ? err.message.toLowerCase() : ''
      const isPaddingError =
        msg.includes('bad decrypt') || msg.includes('final block')
      if (!isPaddingError) {
        throw err
      }

      // PKCS7 padding error, retry with no auto-padding
      const decipher = createDecipheriv('aes-128-cbc', keyBuffer, ivBuffer)
      decipher.setAutoPadding(false)
      const plaintext = Buffer.concat([
        decipher.update(ciphertextBuffer),
        decipher.final(),
      ])
      return new Uint8Array(plaintext)
    }
  }

  /**
   * Fetch (once) the AES-128 key at `uri`, sending `headers` (the caller
   * restricts them to what the key host may see). Concurrent and later
   * calls share one request per URI and header set; a failed request is
   * forgotten so the next media task can try again.
   */
  async getKey(
    uri: string,
    headers: Record<string, string> = {}
  ): Promise<Uint8Array> {
    uri = admitHttpSource(uri)
    const cacheKey = keyCacheKey(uri, headers)
    // Return cached promise if available (concurrent-safe)
    const cached = this.keyCache.get(cacheKey)
    if (cached) {
      return cached
    }

    // Store the promise immediately to handle concurrent calls
    const keyPromise = this.defaultFetchKey(uri, { ...headers })
    this.keyCache.set(cacheKey, keyPromise)
    keyPromise.catch(() => {
      if (this.keyCache.get(cacheKey) === keyPromise)
        this.keyCache.delete(cacheKey)
    })

    return keyPromise
  }
}

function keyCacheKey(uri: string, headers: Record<string, string>): string {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([uri, entries])
}
