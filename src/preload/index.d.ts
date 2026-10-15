import type { CommandName, CommandInput, CommandOutput, EventName, EventPayload } from '@shared/ipc'
import type { Result } from '@shared/result'

export interface WindowApi {
  invoke<K extends CommandName>(
    name: K,
    ...args: CommandInput<K> extends void ? [input?: void] : [input: CommandInput<K>]
  ): Promise<Result<CommandOutput<K>>>
  on<K extends EventName>(name: K, cb: (payload: EventPayload<K>) => void): () => void
}

declare global {
  interface Window {
    api: WindowApi
  }
}
