import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SecretStore, type SafeStorageAdapter } from './SecretStore'
import { AppErrorException } from '../../shared/result'

class MockSafeStorageAdapter implements SafeStorageAdapter {
  constructor(public available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`ENC:${plainText}`, 'utf8')
  }

  decryptString(cipherText: Buffer): string {
    const str = cipherText.toString('utf8')
    if (!str.startsWith('ENC:')) {
      throw new Error('Decryption failed: corrupted or invalid payload')
    }
    return str.slice(4)
  }
}

describe('SecretStore', () => {
  let tempDir: string
  let tokenPath: string
  let mockAdapter: MockSafeStorageAdapter
  let store: SecretStore

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'secret-store-test-'))
    tokenPath = path.join(tempDir, 'token.enc')
    mockAdapter = new MockSafeStorageAdapter(true)
    store = new SecretStore(tokenPath, mockAdapter)
  })

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('getToken returns null when no file exists', async () => {
    const token = await store.getToken()
    expect(token).toBeNull()
    expect(await store.hasToken()).toBe(false)
  })

  it('setToken writes encrypted buffer and getToken decrypts it back accurately', async () => {
    const secret = 'cf_api_token_abc123456789'
    await store.setToken(secret)

    expect(await store.hasToken()).toBe(true)

    // Verify raw file on disk is encrypted
    const diskBuffer = await fs.promises.readFile(tokenPath)
    expect(diskBuffer.toString('utf8')).toBe(`ENC:${secret}`)

    // Verify getToken decrypts correctly
    const decrypted = await store.getToken()
    expect(decrypted).toBe(secret)
  })

  it('clearToken deletes file and subsequent getToken returns null', async () => {
    await store.setToken('test-token')
    expect(await store.hasToken()).toBe(true)

    await store.clearToken()
    expect(await store.hasToken()).toBe(false)
    expect(await store.getToken()).toBeNull()

    // Subsequent clearToken on nonexistent file is safe (does not throw)
    await expect(store.clearToken()).resolves.toBeUndefined()
  })

  it('hasToken accurately reflects file presence and readability', async () => {
    expect(await store.hasToken()).toBe(false)

    await store.setToken('token-value')
    expect(await store.hasToken()).toBe(true)

    await store.clearToken()
    expect(await store.hasToken()).toBe(false)
  })

  it('handles corrupted ciphertext gracefully by returning null', async () => {
    // Write invalid, corrupted data that cannot be decrypted
    await fs.promises.writeFile(tokenPath, Buffer.from('NOT_AN_ENCRYPTED_STRING', 'utf8'))

    expect(await store.hasToken()).toBe(true)
    const token = await store.getToken()
    expect(token).toBeNull()
  })

  it('handles empty file gracefully by returning null', async () => {
    await fs.promises.writeFile(tokenPath, Buffer.alloc(0))

    expect(await store.hasToken()).toBe(true)
    const token = await store.getToken()
    expect(token).toBeNull()
  })

  it('throws AppErrorException when encryption is unavailable', async () => {
    mockAdapter.available = false

    await expect(store.setToken('my-token')).rejects.toThrow(
      'Encryption is not available on this system'
    )

    try {
      await store.setToken('my-token')
    } catch (err) {
      expect(err).toBeInstanceOf(AppErrorException)
      expect((err as AppErrorException).code).toBe('INTERNAL')
    }
  })
})
