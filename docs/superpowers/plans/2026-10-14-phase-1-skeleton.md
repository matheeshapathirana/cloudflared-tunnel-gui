# Phase 1 — Skeleton: Implementation Plan

- **Spec:** `docs/superpowers/specs/2026-10-14-cloudflared-tunnel-gui-design.md`. Read §3, §4, §6.7 (single instance), §6.8 (lookup order and version), §7 (layout), §8 (IPC) and §9.1 (renderer lockdown) before starting.
- **Baseline:** the electron-vite `react-ts` template is already scaffolded and installed (commit `7608908`).
- **Goal:** a running Electron app with the final architecture's foundation: typed IPC, persisted state, the tunnel registry, cloudflared binary detection, and the app-shell UI. No tunnels are run in this phase.

## Hard rules (non-negotiable)

1. Do **not** run any `cloudflared` command except `cloudflared --version`. No `tunnel`, `service`, `login`, `route`.
2. Do **not** run `sc.exe`, `Get-Service`/`Start-Service`/`Stop-Service`, or anything else that touches Windows services or the registry.
3. Do **not** read, list or write `%USERPROFILE%\.cloudflared\` or `C:\ProgramData\cloudflared\`. Tests use temp dirs only.
4. Do **not** modify `docs/` or `node_modules/`, patch installed packages, stub or mock real dependencies to force a gate to pass, weaken `tsconfig` strictness, add `@ts-ignore`/`@ts-expect-error`/`any` to silence errors, or skip or delete tests.
5. Do **not** commit, create branches, or run `npm audit fix`. Leave all changes in the working tree.
6. Do **not** start `npm run dev` / `npm start` (they never exit).

## Dependencies

- Runtime: `zod` (v4 API: `z.uuid()`, `z.object`, …), `@tanstack/react-query`, `lucide-react`, `clsx`, `tailwind-merge`, `class-variance-authority`, plus whatever Radix packages the shadcn components need.
- Dev: `tailwindcss`, `@tailwindcss/vite`, `vitest`.
- shadcn/ui: either use the CLI non-interactively (`npx shadcn@latest …`) or hand-write the components from shadcn source. The components are `button`, `card`, `badge`, `input`, `label`, `switch`, `separator`, `tooltip`. Configure `components.json` aliases to the existing `@renderer/*` alias.
- If anything else is strictly required, add it and report it.

Remove the template demo code: `Versions.tsx`, `electron.svg`, `wavy-lines.svg`, `base.css`, `main.css`.

## File layout

```
src/shared/
  schemas.ts        zod schemas + inferred types: Tunnel, AppState (spec §4.1), TunnelStatus (§4.2), BinaryStatus, SettingsView, SettingsPatch; defaultAppState()
  result.ts         Result<T>, AppError, ErrorCode, AppErrorException
  ipc.ts            command + event contract (below), channel names
src/main/
  index.ts          bootstrap
  window.ts         createMainWindow()
  ipc/IpcRouter.ts
  ipc/registerCommands.ts
  settings/SettingsStore.ts
  tunnels/TunnelRegistry.ts
  binary/BinaryManager.ts
  util/atomicWrite.ts
src/preload/index.ts, index.d.ts
src/renderer/src/
  lib/api.ts        typed client + TanStack Query hooks
  lib/utils.ts      cn()
  components/ui/*   shadcn
  components/AppSidebar.tsx
  components/BinaryBanner.tsx
  pages/TunnelsPage.tsx, QuickSharePage.tsx, SettingsPage.tsx
  App.tsx, main.tsx, styles.css
```

Tests are colocated as `*.test.ts` next to the code they test.

## Shared contract

### `result.ts`

```ts
export type ErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'UNKNOWN_COMMAND' | 'INTERNAL' | 'BINARY_NOT_FOUND'
export type AppError = { code: ErrorCode; message: string; details?: unknown }
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }
export class AppErrorException extends Error { constructor(public code: ErrorCode, message: string, public details?: unknown) }
```

### `schemas.ts`

- `TunnelSchema` matches spec §4.1. A `superRefine` enforces the kind-specific fields:
  - `kind: 'quick'` requires `quick.target`
  - `kind: 'local'` requires `local.configPath` and `cfTunnelId`
  - `kind: 'remote'` requires `cfTunnelId`
  - `runMode: 'service'` requires `serviceName`
  - `kind: 'quick'` cannot have `runMode: 'service'`
- `AppStateSchema` matches §4.1, with `version: z.literal(1)`.
- `defaultAppState()` returns valid defaults: no tunnels, `startup: { launchAtLogin: false, startHidden: true }`, empty arrays and maps.
- `BinaryStatusSchema`:
  - found: `{ found: true, path, source: 'override' | 'managed' | 'path' | 'programFiles', version: string | null, overrideInvalid: boolean }`
  - not found: `{ found: false, searched: string[], overrideInvalid: boolean }`
- `SettingsViewSchema`: `{ startup, binary: { overridePath?: string }, appVersion: string }`.
- `SettingsPatchSchema`: `{ startup?: Partial<startup> }`.

### `ipc.ts`

```ts
const cmd = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output })
export const commands = {
  'tunnels.list':         cmd(z.void(), z.array(TunnelSchema)),
  'tunnels.rename':       cmd(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80) }), TunnelSchema),
  'tunnels.setAutoStart': cmd(z.object({ id: z.uuid(), autoStart: z.boolean() }), TunnelSchema),
  'tunnels.delete':       cmd(z.object({ id: z.uuid() }), z.void()),   // registry-only removal in this phase
  'binary.status':        cmd(z.void(), BinaryStatusSchema),
  'binary.setOverride':   cmd(z.object({ path: z.string().trim().min(1).nullable() }), BinaryStatusSchema),
  'app.getSettings':      cmd(z.void(), SettingsViewSchema),
  'app.setSettings':      cmd(SettingsPatchSchema, SettingsViewSchema),
} as const
export type CommandName = keyof typeof commands
export type CommandInput<K extends CommandName> = z.input<(typeof commands)[K]['input']>
export type CommandOutput<K extends CommandName> = z.output<(typeof commands)[K]['output']>

export const events = {
  'registry:changed': z.array(TunnelSchema),
  'tunnel:status':    z.object({ id: z.string(), status: TunnelStatusSchema }),
  'tunnel:log':       z.object({ id: z.string(), line: z.string() }),
} as const
export type EventName = keyof typeof events
export type EventPayload<K extends EventName> = z.output<(typeof events)[K]>

export const INVOKE_CHANNEL = 'ipc:invoke'   // payload { name, input }
export const EVENT_CHANNEL = 'ipc:event'     // payload { name, payload }
```

Only `registry:changed` is emitted in this phase.

## Main process

### `IpcRouter`

- `register<K>(name: K, handler: (input: z.output<input schema of K>) => CommandOutput<K> | Promise<CommandOutput<K>>)`.
- `dispatch(name: unknown, input: unknown): Promise<Result<unknown>>` is pure and testable without Electron:
  - Unknown name → `UNKNOWN_COMMAND`.
  - Input fails zod → `VALIDATION`, with `details` set to the zod issues.
  - The handler throws `AppErrorException` → return its code, message and details.
  - Any other throw → `INTERNAL`, with the message only (no stack).
- `attach(ipcMain: Pick<IpcMain, 'handle'>, isTrustedSender: (e: IpcMainInvokeEvent) => boolean)` registers `INVOKE_CHANNEL`. Untrusted senders get `INTERNAL` "untrusted sender". The trusted check compares `event.senderFrame.url` with the app's dev URL or its `file://` index.

### `SettingsStore` (`constructor(filePath)`)

- `load(): Promise<AppState>`:
  - Missing file → defaults.
  - Invalid JSON or schema failure → rename the file to `state.json.corrupt-<timestamp>` and use defaults.
- `get(): AppState` returns a deep copy.
- `update(mutator: (draft: AppState) => AppState | void): Promise<AppState>`:
  - Applies the mutator to a copy and validates the result with `AppStateSchema`. An invalid result throws `VALIDATION`, and the file and memory stay unchanged.
  - Writes atomically: a temp file in the same folder, then rename (`util/atomicWrite.ts`).
  - Writes are **serialized** through a promise queue so concurrent updates never interleave or get lost.

### `TunnelRegistry` (`constructor(store: SettingsStore)`, typed event emitter)

- Methods: `list()`, `get(id)`, `add(input: Omit<Tunnel, 'id'>) → Tunnel` (id from `crypto.randomUUID()`), `update(id, patch) → Tunnel`, `remove(id)`.
- A missing id throws `AppErrorException('NOT_FOUND', …)`.
- After every change it emits `'changed'` with the full list.

### `BinaryManager` (detection only in this phase)

- Every dependency is injected:
  - `exists(p): Promise<boolean>`
  - `execFile(p, args, { timeout }): Promise<{ stdout: string; stderr: string }>`
  - `env: { PATH?: string; LOCALAPPDATA?: string; ProgramFiles?: string; 'ProgramFiles(x86)'?: string }`
  - `getOverride(): string | undefined`
- Use `path.win32` everywhere so tests behave the same on every OS.
- `candidates(): { path, source }[]`, in this order:
  1. the override
  2. `%LOCALAPPDATA%\CloudflaredTunnelGUI\bin\cloudflared.exe` (`managed`)
  3. each `PATH` entry + `cloudflared.exe` (`path`)
  4. `%ProgramFiles(x86)%\cloudflared\cloudflared.exe`, then `%ProgramFiles%\cloudflared\cloudflared.exe` (`programFiles`)

  Remove duplicates, ignoring case.
- `status(): Promise<BinaryStatus>`:
  - Returns the first candidate that exists, with its version from `execFile(path, ['--version'], { timeout: 5000 })`. A failure gives `version: null`.
  - If an override is set but doesn't exist, it falls through to the next candidate with `overrideInvalid: true`.
  - If nothing is found → `{ found: false, searched }`.
- Exported pure helpers:
  - `parseVersion(stdout)`: `"cloudflared version 2026.10.0 (built 2026-10-05T08:39 UTC)"` → `"2026.10.0"`, otherwise `null`.
  - `compareVersions(a, b)` → `-1 | 0 | 1`, comparing numeric dot segments.

### Bootstrap (`src/main/index.ts`, `window.ts`)

- Before `ready`: `app.setPath('userData', join(app.getPath('appData'), 'CloudflaredTunnelGUI'))`. The state file is `userData/state.json`.
- Single instance: if `app.requestSingleInstanceLock()` returns false, quit. On `second-instance`, restore, show and focus the window.
- Wire up `SettingsStore` → `TunnelRegistry` → `BinaryManager` (real `fs`/`execFile`/`process.env`; the override comes from the store) → `IpcRouter`, then `registerCommands` and `attach`.
- Registry `'changed'` → `webContents.send(EVENT_CHANNEL, { name: 'registry:changed', payload })`.
- `BrowserWindow`:
  - Size: 1100×720, minimum 900×600.
  - `show: false` until `ready-to-show`, `autoHideMenuBar: true`.
  - `webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false }`.
- `setWindowOpenHandler` → always `{ action: 'deny' }`. It calls `shell.openExternal` only for `https:` URLs whose host is in the allowlist: `dash.cloudflare.com`, `developers.cloudflare.com`, `github.com`.
- `will-navigate` → `preventDefault` unless the target has the app's own origin.
- Keep the template's CSP `<meta>` in `index.html`.

### Preload (sandboxed!)

- Because `sandbox: true`, the preload may import **only** from `'electron'`, plus type-only imports from `src/shared`. Remove `@electron-toolkit/preload` from the preload.
- It exposes this on `window.api`:

  ```ts
  contextBridge.exposeInMainWorld('api', {
    invoke: (name, input) => ipcRenderer.invoke(INVOKE_CHANNEL, { name, input }),
    on: (name, cb) => {
      const l = (_e, msg) => { if (msg?.name === name) cb(msg.payload) }
      ipcRenderer.on(EVENT_CHANNEL, l)
      return () => ipcRenderer.removeListener(EVENT_CHANNEL, l)
    },
  })
  ```

  The channel constants must be inlined or imported in a way that bundles them (no runtime import of anything except `electron`).
- `index.d.ts` types `window.api` with the shared generics: `invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<Result<CommandOutput<K>>>`, and `on<K extends EventName>(name: K, cb: (p: EventPayload<K>) => void): () => void`.

## Renderer

- **Styling:**
  - Tailwind v4 through `@tailwindcss/vite` in the renderer section of `electron.vite.config.ts`; `styles.css` starts with `@import "tailwindcss";` plus shadcn neutral theme tokens.
  - Dark mode follows `prefers-color-scheme`: a `matchMedia` listener toggles a `dark` class on `<html>`.
- **`lib/api.ts`:**
  - `call(name, input)` unwraps `Result` and throws `ApiError { code, message, details }` when `ok: false`.
  - Hooks: `useTunnels()` subscribes to `registry:changed` → `setQueryData`; `useBinaryStatus()`, `useSettings()`; mutations `useSetOverride()`, `useSetSettings()`.
- **Layout:**
  - A fixed left sidebar with the app name and nav items Tunnels, Quick share and Settings, using lucide icons. Navigation is a simple `useState` with no router library.
  - The main content area scrolls.
  - `BinaryBanner` sits at the top of every page when cloudflared isn't found: "cloudflared not found. Set its path in Settings" with a button that goes to Settings.
- **TunnelsPage:**
  - A header with **Refresh** and **New tunnel** buttons. Both are disabled, with the tooltip "Coming in a later phase".
  - A list of tunnels: name, kind badge (Quick / API / Config), run-mode badge (App / Service), and "Stopped" status text.
  - When there are no tunnels, an empty-state card.
- **QuickSharePage:** a placeholder card: "Quick share arrives in Phase 2".
- **SettingsPage:**
  - *cloudflared* card: found path, source and version (or "Not found" with the searched paths). A custom-path input with Save and Clear (`binary.setOverride`) and a Re-check button. Show `overrideInvalid` as a warning.
  - *Startup* card: switches for "Launch at login" and "Start hidden", saved through `app.setSettings`. A note says they are saved but take effect in a later phase.
  - *About* card: the app version.
- **Accessibility:** every control has an accessible label and visible focus styles.

## Tests (Vitest, node environment)

- Add `vitest.config.ts` (include `src/**/*.test.ts`) and the script `"test": "vitest run"`.
- Make sure `src/shared/**/*` is included by **both** `tsconfig.node.json` and `tsconfig.web.json`.
- Cover:
  - **`schemas.test.ts`:** defaults are valid; each kind-specific refinement accepts valid records and rejects invalid ones; an unknown `kind` is rejected.
  - **`IpcRouter.test.ts`:** unknown command; validation error with details; success; `AppErrorException` mapping; a generic error maps to `INTERNAL` with no stack in the message; an untrusted sender is rejected.
  - **`SettingsStore.test.ts`** (real temp dir via `fs.mkdtemp(os.tmpdir())`):
    - a missing file gives defaults
    - a corrupt file is renamed and defaults are used
    - an update persists and a fresh instance reloads it
    - 10 concurrent updates appending to `recentQuickTargets` all land
    - an invalid update is rejected and the file on disk is unchanged
  - **`TunnelRegistry.test.ts`:** add assigns a uuid; update; remove; `NOT_FOUND`; the `changed` event fires; changes persist through the store.
  - **`BinaryManager.test.ts`** (all injected, no real binary):
    - candidate order and case-insensitive dedupe
    - a missing override falls through with `overrideInvalid`
    - not found returns the searched list
    - `parseVersion` on the real sample line, plus garbage input
    - `compareVersions`

## Acceptance gates (all must pass)

1. `npm run typecheck`: 0 errors.
2. `npm test`: all pass, at least 25 tests.
3. `npx electron-vite build`: succeeds.
4. `npm run lint`: 0 errors (warnings OK).
5. Nothing changed under `docs/`, nothing edited in `node_modules/`.

## Report back

- Files created, modified or deleted (paths only).
- Dependencies added, with versions.
- Gate results (test count, error counts).
- Any deviation from this plan, and why.
- Anything left undone.
