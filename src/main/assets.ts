import { join } from 'node:path'
import { app } from 'electron'

/**
 * Path of a file from the project's `resources/` folder (tray and window icons).
 *
 * Packaged, those files sit loose next to the app (electron-builder `extraResources`) because
 * native code such as the tray cannot read from inside `app.asar`. In development they are read
 * straight from the repository.
 */
export function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', name)
    : join(__dirname, '../../resources', name)
}
