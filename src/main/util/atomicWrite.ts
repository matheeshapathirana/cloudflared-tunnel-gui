import fs from 'node:fs'
import path from 'node:path'

export async function atomicWrite(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
  try {
    if (typeof data === 'string') {
      await fs.promises.writeFile(tmp, data, 'utf8')
    } else {
      await fs.promises.writeFile(tmp, data)
    }
    let renamed = false
    let lastErr: unknown
    for (let i = 0; i < 5; i++) {
      try {
        await fs.promises.rename(tmp, filePath)
        renamed = true
        break
      } catch (err: unknown) {
        lastErr = err
        const code = (err as { code?: string }).code
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
          await new Promise((r) => setTimeout(r, 25 * (i + 1)))
        } else {
          throw err
        }
      }
    }
    if (!renamed) {
      throw lastErr
    }
  } catch (err) {
    try {
      await fs.promises.unlink(tmp)
    } catch {
      // Ignore if tmp does not exist
    }
    throw err
  }
}
