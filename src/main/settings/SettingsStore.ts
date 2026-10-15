import fs from 'node:fs'
import { AppState, AppStateSchema, defaultAppState } from '@shared/schemas'
import { AppErrorException } from '@shared/result'
import { atomicWrite } from '../util/atomicWrite'

export class SettingsStore {
  private state: AppState = defaultAppState()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(public filePath: string) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => {})
    return result
  }

  get(): AppState {
    return structuredClone(this.state)
  }

  async load(): Promise<AppState> {
    return this.enqueue(async () => {
      let data: string
      try {
        data = await fs.promises.readFile(this.filePath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.state = defaultAppState()
          return structuredClone(this.state)
        }
        throw err
      }

      try {
        const json = JSON.parse(data)
        const parsed = AppStateSchema.parse(json)
        this.state = parsed
        return structuredClone(this.state)
      } catch {
        // Corrupt JSON or schema failure
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`
        try {
          await fs.promises.rename(this.filePath, corruptPath)
        } catch {
          // Ignore rename error
        }
        this.state = defaultAppState()
        return structuredClone(this.state)
      }
    })
  }

  async update(
    mutator: (draft: AppState) => AppState | void | Promise<AppState | void>
  ): Promise<AppState> {
    return this.enqueue(async () => {
      const draft = structuredClone(this.state)
      const res = await mutator(draft)
      const candidate = res !== undefined ? res : draft

      const parsed = AppStateSchema.safeParse(candidate)
      if (!parsed.success) {
        throw new AppErrorException('VALIDATION', 'Invalid app state', parsed.error.issues)
      }

      await atomicWrite(this.filePath, JSON.stringify(parsed.data, null, 2))
      this.state = parsed.data
      return structuredClone(this.state)
    })
  }
}
