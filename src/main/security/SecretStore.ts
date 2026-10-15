import fs from 'node:fs'
import { AppErrorException } from '../../shared/result'
import { atomicWrite } from '../util/atomicWrite'

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(cipherText: Buffer): string
}

export interface ISecretStore {
  setToken(token: string): Promise<void>
  getToken(): Promise<string | null>
  clearToken(): Promise<void>
  hasToken(): Promise<boolean>
}

export class ElectronSafeStorageAdapter implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { safeStorage } = require('electron')
      return safeStorage?.isEncryptionAvailable?.() ?? false
    } catch {
      return false
    }
  }

  encryptString(plainText: string): Buffer {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron')
    return safeStorage.encryptString(plainText)
  }

  decryptString(cipherText: Buffer): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron')
    return safeStorage.decryptString(cipherText)
  }
}

export class SecretStore implements ISecretStore {
  constructor(
    public filePath: string,
    private safeStorage: SafeStorageAdapter = new ElectronSafeStorageAdapter()
  ) {}

  async setToken(token: string): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new AppErrorException('INTERNAL', 'Encryption is not available on this system')
    }
    const encrypted = this.safeStorage.encryptString(token)
    await atomicWrite(this.filePath, encrypted)
  }

  async getToken(): Promise<string | null> {
    try {
      const buffer = await fs.promises.readFile(this.filePath)
      if (buffer.length === 0) {
        return null
      }
      return this.safeStorage.decryptString(buffer)
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      if (code === 'ENOENT') {
        return null
      }
      // Return null on decryption failure or corruption
      return null
    }
  }

  async clearToken(): Promise<void> {
    try {
      await fs.promises.unlink(this.filePath)
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      if (code !== 'ENOENT') {
        throw err
      }
    }
  }

  async hasToken(): Promise<boolean> {
    try {
      await fs.promises.access(this.filePath, fs.constants.R_OK)
      return true
    } catch {
      return false
    }
  }
}
