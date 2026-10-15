import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { commands, CommandName, CommandInput, CommandOutput, INVOKE_CHANNEL } from '@shared/ipc'
import { AppErrorException, Result, AppError } from '@shared/result'

type CommandHandler<K extends CommandName> = (
  input: CommandInput<K>
) => CommandOutput<K> | Promise<CommandOutput<K>>

export class IpcRouter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<CommandName, CommandHandler<any>>()

  register<K extends CommandName>(name: K, handler: CommandHandler<K>): this {
    this.handlers.set(name, handler)
    return this
  }

  async dispatch(name: unknown, input: unknown): Promise<Result<unknown>> {
    if (
      typeof name !== 'string' ||
      !Object.prototype.hasOwnProperty.call(commands, name) ||
      !this.handlers.has(name as CommandName)
    ) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_COMMAND',
          message: `Unknown command: ${String(name)}`
        }
      }
    }

    const commandName = name as CommandName
    const cmdSpec = commands[commandName]
    const parseResult = cmdSpec.input.safeParse(input)

    if (!parseResult.success) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'Validation failed',
          details: parseResult.error.issues
        }
      }
    }

    try {
      const handler = this.handlers.get(commandName)!
      const data = await handler(parseResult.data)
      return { ok: true, data }
    } catch (err) {
      if (err instanceof AppErrorException) {
        const error: AppError = {
          code: err.code,
          message: err.message
        }
        if (err.details !== undefined) {
          error.details = err.details
        }
        return { ok: false, error }
      }

      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message
        }
      }
    }
  }

  attach(
    ipcMain: Pick<IpcMain, 'handle'>,
    isTrustedSender: (e: IpcMainInvokeEvent) => boolean
  ): void {
    ipcMain.handle(INVOKE_CHANNEL, async (event, msg: { name: unknown; input: unknown }) => {
      if (!isTrustedSender(event)) {
        return { ok: false, error: { code: 'INTERNAL', message: 'untrusted sender' } }
      }
      return this.dispatch(msg?.name, msg?.input)
    })
  }
}
