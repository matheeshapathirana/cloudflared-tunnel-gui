# Auto-update and Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installed copies of the app find, download and (on user click) install new versions published as GitHub Releases, and the NSIS installer plus a tag-triggered CI pipeline produce those releases.

**Architecture:** An injectable `UpdateManager` in the main process wraps `electron-updater` and emits a small state machine over the existing zod-validated IPC (`update.*` commands, `update:state` event). The renderer shows it in Settings, the sidebar and the tray. A GitHub Actions workflow builds and uploads a draft release on a `v*` tag.

**Tech Stack:** Electron 44, electron-builder 26 (NSIS, GitHub publish), `electron-updater`, zod 4, React 19 + TanStack Query, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-15-auto-update-and-installer-design.md`

## Global Constraints

- Public repo `matheeshapathirana/cloudflared-tunnel-gui`; updates are read anonymously, no token in the app.
- Stable releases only: `allowPrerelease = false`, `allowDowngrade = false`; drafts are never visible to the updater.
- `autoDownload = true`, `autoInstallOnAppQuit = false`: never install without the user's click.
- NSIS, x64, per-user (`oneClick: true`, `perMachine: false`), no admin to install or update.
- Check 30 s after launch, then every 6 h, only when `updates.autoCheck` is true (default `true`). Manual check always works.
- `UpdateManager` is inert unless `app.isPackaged`; `npm run dev` never touches the network.
- Uninstall must not delete `%APPDATA%\CloudflaredTunnelGUI` (`deleteAppDataOnUninstall: false`) and never touches cloudflared Windows services or `~/.cloudflared`.
- Releases are created as **drafts**; the owner publishes manually.
- v1 is unsigned; no signing code in this plan.
- Tests must never touch the user's live cloudflared service or `config.yml` tunnel.
- Code style: Prettier (no semicolons, single quotes), ESLint clean, `npm run typecheck` clean. Run `npm run lint`, `npm run typecheck`, `npm test` before every commit.

## Review Focus

- **No release published yet / offline / GitHub 404:** a check fails; the app must show a short non-alarming message in Settings, stay usable, and retry at the next scheduled check. (Task 2 test.)
- **Existing `state.json` written before this feature:** no `updates` key; must load with `autoCheck: true`, not be treated as corrupt and wiped. (Task 1 test.)
- **Renderer opens (or the tray is used) after an update is already `ready`:** the UI must get the current state on mount, not only from later events. (Task 5 test.)
- **User hits "Restart to update" when nothing is ready, or double-clicks it:** `install()` must reject / no-op, never call `quitAndInstall` twice or in the wrong state. (Task 2 test.)
- **App quits mid-download or while a check is pending:** timers must be cleared so the process can exit; no event emitted after `stop()`. (Task 2 test.)

---

### Task 1: Update schemas and the `updates.autoCheck` setting

**Files:**
- Modify: `src/shared/schemas.ts` (add `UpdateStatusSchema`, `UpdateStateSchema`; extend `AppStateSchema`, `defaultAppState`, `SettingsViewSchema`, `SettingsPatchSchema`)
- Modify: `src/main/ipc/registerCommands.ts` (`getSettings` and the `app.setSettings` handler)
- Test: `src/shared/schemas.test.ts`, `src/main/settings/SettingsStore.test.ts`, `src/main/ipc/registerCommands.test.ts`

**Interfaces:**
- Produces (in `src/shared/schemas.ts`):
  - `UpdateStatusSchema`: discriminated union on `state`: `idle {checkedAt?: number}`, `checking`, `available {version: string}`, `downloading {version: string, percent: number}`, `ready {version: string}`, `error {message: string}`.
  - `UpdateStateSchema = z.object({ currentVersion: z.string(), status: UpdateStatusSchema })`, with types `UpdateStatus`, `UpdateState`.
  - `AppState.updates: { autoCheck: boolean }`, **`.default({ autoCheck: true })`** in the schema so old files load. `defaultAppState().updates = { autoCheck: true }`.
  - `SettingsView.updates: { autoCheck: boolean }`; `SettingsPatch.updates?: { autoCheck?: boolean }`.

- [ ] **Step 1: Write the failing tests**
  - `schemas.test.ts`: `UpdateStateSchema` accepts one valid object per status (`idle`, `idle` with `checkedAt`, `checking`, `available`, `downloading` with `percent: 42`, `ready`, `error`) and rejects `{state: 'downloading', version: '1.0.1'}` (no percent) and an unknown state.
  - `SettingsStore.test.ts`: `loads a state file written before the updates setting existed` writes `JSON.stringify` of `defaultAppState()` minus the `updates` key, loads it, and expects `store.get().updates` to equal `{ autoCheck: true }` and **no** `state.json.corrupt-*` file in the dir.
  - `registerCommands.test.ts`: `app.setSettings` with `{ updates: { autoCheck: false } }` returns a view with `updates.autoCheck === false` and persists it in the store; `app.getSettings` includes `updates`. Follow the file's existing setup helper.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/shared/schemas.test.ts src/main/settings/SettingsStore.test.ts src/main/ipc/registerCommands.test.ts`
  Expected: FAIL (missing schemas / `updates` undefined).
- [ ] **Step 3: Implement the schemas and settings plumbing**
  Add the schemas as specified. In `registerCommands.ts`, return `updates: state.updates` from `getSettings`, and merge `input.updates` into `s.updates` in `app.setSettings` (same pattern as `startup`).
- [ ] **Step 4: Run the three test files, then `npm run typecheck`**
  Expected: PASS; typecheck clean (fix any other fixture that builds a `SettingsView` or `AppState` literal, e.g. renderer or test helpers, by adding `updates`).
- [ ] **Step 5: Commit**
  ```bash
  git add src/shared/schemas.ts src/shared/schemas.test.ts src/main/settings/SettingsStore.test.ts src/main/ipc/registerCommands.ts src/main/ipc/registerCommands.test.ts
  git commit -m "feat(update): add update state schemas and updates.autoCheck setting"
  ```

---

### Task 2: `UpdateManager`

**Files:**
- Create: `src/main/update/UpdateManager.ts`
- Test: `src/main/update/UpdateManager.test.ts`

**Interfaces:**
- Consumes: `UpdateState`, `UpdateStatus` from `@shared/schemas` (Task 1).
- Produces:
  ```ts
  export interface UpdaterLike {
    autoDownload: boolean
    autoInstallOnAppQuit: boolean
    allowPrerelease: boolean
    allowDowngrade: boolean
    on(event: string, listener: (...args: any[]) => void): unknown
    checkForUpdates(): Promise<unknown>
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  }
  export interface UpdateManagerDeps {
    updater: UpdaterLike
    currentVersion: string
    isPackaged: boolean
    getAutoCheck: () => boolean
    beforeInstall: () => void          // index.ts sets isQuitting here
    initialDelayMs?: number            // default 30_000
    intervalMs?: number                // default 6 * 60 * 60 * 1000
  }
  export class UpdateManager extends EventEmitter {
    constructor(deps: UpdateManagerDeps)
    getState(): UpdateState
    start(): void                      // configure updater, subscribe, schedule checks (packaged only)
    stop(): void                       // clear timers, ignore later updater events
    check(): Promise<UpdateState>      // manual or scheduled check; resolves with the state after the check call settles
    install(): void                    // throws AppErrorException('VALIDATION', …) unless status is ready
    // emits 'state' with UpdateState on every change
  }
  ```
  Updater events mapped: `checking-for-update` → `checking`; `update-available` (`info.version`) → `available` then `downloading` at 0%; `download-progress` (`{percent}`) → `downloading` (rounded); `update-downloaded` (`info.version`) → `ready`; `update-not-available` → `idle` with `checkedAt`; `error` (Error) → `error` with a short message.

- [ ] **Step 1: Write the failing tests** (fake updater = an `EventEmitter` subclass with `checkForUpdates`/`quitAndInstall` as `vi.fn()`; `vi.useFakeTimers()`)
  - `start() configures the updater`: after `start()`, `autoDownload === true`, `autoInstallOnAppQuit === false`, `allowPrerelease === false`, `allowDowngrade === false`.
  - `walks idle → checking → downloading → ready` when the fake emits `checking-for-update`, `update-available {version:'1.1.0'}`, `download-progress {percent: 41.6}` (state `downloading` with `percent: 42`), `update-downloaded {version:'1.1.0'}`; each change emits `'state'` once.
  - `update-not-available` → `idle` with a `checkedAt` number.
  - `error becomes a state, not an exception`: fake `checkForUpdates` rejects with `new Error('net::ERR_INTERNET_DISCONNECTED')`; `await check()` resolves; status is `error` with a non-empty `message`; a later successful `update-not-available` returns to `idle`.
  - `a 404 for latest.yml gives a friendly message`: error text containing `Cannot find latest.yml` or `404` yields message `No update information found yet.` (no raw stack or URL).
  - `install() outside ready throws` (in `idle`, `checking`, `downloading`): `quitAndInstall` not called.
  - `install() in ready calls beforeInstall then quitAndInstall(false, true)` exactly once; a second `install()` call does not call it again.
  - `check() during checking or downloading does not start a second check`: `checkForUpdates` called once.
  - `not packaged is inert`: with `isPackaged: false`, `start()` schedules nothing and does not touch the updater; `check()` resolves with `idle` and never calls `checkForUpdates`.
  - `scheduling`: with `getAutoCheck` true, one check after `initialDelayMs`, then one per `intervalMs`; with `getAutoCheck` false, scheduled ticks do nothing but `check()` still works.
  - `stop() clears timers and ignores later events`: after `stop()`, advancing timers triggers no check, and a fake `update-downloaded` emits no `'state'`.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/main/update/UpdateManager.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement `UpdateManager`** in `src/main/update/UpdateManager.ts` to the interface above. Single `inFlight` guard for `check()`. Use `AppErrorException` from `@shared/result`. Keep error-message mapping in one small local function.
- [ ] **Step 4: Run the test file, lint, typecheck**
  Expected: PASS, clean.
- [ ] **Step 5: Commit**
  ```bash
  git add src/main/update
  git commit -m "feat(update): add UpdateManager state machine over electron-updater"
  ```

---

### Task 3: IPC commands, event, dependency and main-process wiring

**Files:**
- Modify: `package.json` / `package-lock.json` (add `electron-updater` to `dependencies`)
- Modify: `src/shared/ipc.ts` (commands `update.getState`, `update.check`, `update.install`; event `update:state`)
- Modify: `src/main/ipc/registerCommands.ts` (`RegisterCommandsDeps.updateManager?: UpdateManager`; three handlers)
- Modify: `src/main/index.ts` (construct and start the manager, forward events, tear down)
- Test: `src/main/ipc/registerCommands.test.ts`

**Interfaces:**
- Consumes: `UpdateManager` (Task 2), `UpdateStateSchema` (Task 1).
- Produces: `commands['update.getState']: void → UpdateState`; `['update.check']: void → UpdateState`; `['update.install']: void → void`; `events['update:state']: UpdateState`. `RegisterCommandsDeps.updateManager?: Pick<UpdateManager, 'getState' | 'check' | 'install'>`.

- [ ] **Step 1: Write the failing tests** in `registerCommands.test.ts`, with a stub `updateManager`: `update.getState` returns the stub's state; `update.check` returns the stub's check result; `update.install` calls `install` once; when `install` throws `AppErrorException('VALIDATION', …)` the router result is `{ ok: false, error.code: 'VALIDATION' }`; without `updateManager` in deps, `update.getState` returns `{ currentVersion: <appVersion>, status: { state: 'idle' } }`.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/main/ipc/registerCommands.test.ts`
  Expected: FAIL (unknown commands).
- [ ] **Step 3: Implement**
  - `npm install electron-updater` (runtime dependency, not dev).
  - Add the commands and event to `src/shared/ipc.ts` using the file's `cmd(...)` helper.
  - Register the three handlers in `registerCommands.ts`.
  - In `src/main/index.ts`: `import { autoUpdater } from 'electron-updater'`; create `new UpdateManager({ updater: autoUpdater, currentVersion: app.getVersion(), isPackaged: app.isPackaged, getAutoCheck: () => store.get().updates.autoCheck, beforeInstall: () => { isQuitting = true } })`; pass it to `registerCommands`; `updateManager.on('state', (payload) => mainWindow?.webContents.send(EVENT_CHANNEL, { name: 'update:state', payload }))`; call `updateManager.start()` after `store.load()` inside `app.whenReady()`; call `updateManager.stop()` in `before-quit`. (The tray hookup is Task 4.)
- [ ] **Step 4: Run the full suite, lint, typecheck**
  Run: `npm test && npm run lint && npm run typecheck`
  Expected: all PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add package.json package-lock.json src/shared/ipc.ts src/main/ipc src/main/index.ts
  git commit -m "feat(update): expose update commands and event over IPC and wire UpdateManager"
  ```

---

### Task 4: Tray "Restart to update" item

**Files:**
- Modify: `src/main/tray/TrayController.ts`
- Modify: `src/main/index.ts` (pass `onInstallUpdate`, call `setUpdateReady`)
- Test: `src/main/tray/TrayController.test.ts`

**Interfaces:**
- Consumes: `UpdateManager` `'state'` event (Task 2/3).
- Produces: `TrayControllerDeps.onInstallUpdate: () => void`; `TrayController.setUpdateReady(version: string | null): void`, which stores the value and rebuilds the menu from the last `tunnels`/`statuses` given to `updateMenu`. When non-null the menu has an item labelled `Restart to update to v${version}` above `Quit`, whose `click` calls `onInstallUpdate`.

- [ ] **Step 1: Write the failing tests** (existing mock harness): after `init()` there is no update item; after `setUpdateReady('1.2.0')` the template contains an item with label `Restart to update to v1.2.0` and clicking it calls `onInstallUpdate` once; `setUpdateReady(null)` removes it; the item survives a later `updateMenu(...)` call; `setUpdateReady` before `init()` (tray null) does not throw.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/main/tray/TrayController.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement** in `TrayController.ts`: keep `lastTunnels`/`lastStatuses` fields updated by `updateMenu`; `setUpdateReady` stores the version and calls `updateMenu(lastTunnels, lastStatuses)`. In `index.ts`: pass `onInstallUpdate: () => { try { updateManager.install() } catch { /* not ready: ignore */ } }`; in the `'state'` listener also call `trayController?.setUpdateReady(payload.status.state === 'ready' ? payload.status.version : null)`.
- [ ] **Step 4: Run the tray tests, full suite, lint, typecheck**
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add src/main/tray src/main/index.ts
  git commit -m "feat(update): tray menu item to restart into a downloaded update"
  ```

---

### Task 5: Renderer: hook, "About & Updates" card, sidebar badge

**Files:**
- Modify: `src/renderer/src/lib/api.ts` (add `useUpdateState`, `useCheckForUpdate`, `useInstallUpdate`)
- Create: `src/renderer/src/components/UpdatesCard.tsx`
- Modify: `src/renderer/src/pages/SettingsPage.tsx` (replace the existing "About" card, lines ~807-824, with `<UpdatesCard />`; keep version and environment rows inside it)
- Modify: `src/renderer/src/components/AppSidebar.tsx` (optional `updateReady?: boolean` prop: small dot on the Settings item, with `aria-label` "Settings, update ready")
- Modify: `src/renderer/src/App.tsx` (pass `updateReady` from `useUpdateState()`)
- Test: renderer has no test setup in this repo, so unit-test the pure part: create `src/renderer/src/lib/updateText.ts` (+ `updateText.test.ts`) exporting `describeUpdate(state: UpdateState): string`, and verify the UI manually in Step 4.

**Interfaces:**
- Consumes: `update.getState`, `update.check`, `update.install`, `update:state`, `app.setSettings` with `{ updates: { autoCheck } }`, `SettingsView.updates` (Tasks 1-3).
- Produces:
  - `useUpdateState(): UpdateState | undefined`: initial value from `call('update.getState')` via `useQuery(['update','state'])`, then `getApi().on('update:state', …)` writes into the query cache with `setQueryData` (same pattern as `useTunnels`). This gives the mount-after-`ready` case from the Review Focus.
  - `useCheckForUpdate()`, `useInstallUpdate()` mutations.
  - `describeUpdate(state)`: `idle` → `Up to date` (plus ` · checked HH:MM` when `checkedAt` is set), `checking` → `Checking for updates…`, `available` → `Update ${version} found`, `downloading` → `Downloading ${version} (${percent}%)`, `ready` → `${version} is ready to install`, `error` → `Couldn't check for updates: ${message}`.

- [ ] **Step 1: Write the failing test** `updateText.test.ts` with one assertion per status above (exact strings; for `checkedAt` assert it starts with `Up to date · checked `).
- [ ] **Step 2: Run to verify it fails**
  Run: `npx vitest run src/renderer/src/lib/updateText.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement**
  - `describeUpdate` and the three hooks.
  - `UpdatesCard`: card titled "About & Updates"; rows: Version (`state.currentVersion`), status line (`describeUpdate`), a **Check for updates** button (disabled while `checking`/`downloading`), a **Restart to update** primary button only in `ready` (calls the install mutation), a "Check automatically" `Switch` bound to `settings.updates.autoCheck` via `useSetSettings`, and a "What's new" link `href="https://github.com/matheeshapathirana/cloudflared-tunnel-gui/releases"` with `target="_blank"` (existing pattern, already allowed by `externalLinks`). Use the same `Card`/`Button`/`Switch` components and text sizes as the neighbouring cards. No modals.
  - Sidebar badge and `App.tsx` wiring.
- [ ] **Step 4: Verify**
  - Run: `npx vitest run src/renderer/src/lib/updateText.test.ts && npm run lint && npm run typecheck` → PASS.
  - Run `npm run dev`, open Settings, confirm the card shows the version and "Up to date" (dev is inert), the toggle persists across a restart, and **Check for updates** does not error or hit the network. With the browser/Playwright preview only if the Electron shell cannot be driven; say what was and wasn't verified.
- [ ] **Step 5: Commit**
  ```bash
  git add src/renderer
  git commit -m "feat(update): About & Updates card, sidebar badge and update hooks"
  ```

---

### Task 6: Installer config, release workflow and docs

**Files:**
- Modify: `electron-builder.yml` (nsis scope, `deleteAppDataOnUninstall: false`, `publish`)
- Create: `.github/workflows/release.yml`
- Create: `scripts/check-release-version.mjs` (exits non-zero unless `process.argv[2]` with a leading `v` stripped equals `package.json` `version`)
- Test: `scripts/check-release-version.test.mjs` (Vitest picks up if the `vitest` config includes it; otherwise run with `node --test`, state which)
- Modify: `package.json` (`"release:check": "node scripts/check-release-version.mjs"`)
- Modify: `README.md` (Releasing and Updating sections; fix the "Building" note on SmartScreen to mention updates)

**Interfaces:**
- Produces: workflow trigger `push: tags: ['v*']`; `release:check <tag>` exit code 0/1.

- [ ] **Step 1: Write the failing test** for the version check: `v1.0.0` passes against a `1.0.0` package; `v1.0.1`, `1.0.0` (no `v`) and `v1.0.0-beta.1` against `1.0.0` behave as follows: `v1.0.1` fails, `1.0.0` passes (leading `v` optional), `v1.0.0-beta.1` fails. Implement the check as an exported function `matchesTag(tag: string, version: string): boolean` that the CLI wrapper calls, and test the function directly.
- [ ] **Step 2: Run to verify it fails**
  Run: `npx vitest run scripts/check-release-version.test.mjs` (or `node --test scripts`)
  Expected: FAIL.
- [ ] **Step 3: Implement**
  - `electron-builder.yml`: add under `nsis`: `oneClick: true`, `perMachine: false`, `deleteAppDataOnUninstall: false`; add top-level `publish: { provider: github, owner: matheeshapathirana, repo: cloudflared-tunnel-gui, releaseType: draft }`.
  - `release.yml`: `permissions: contents: write`; job on `windows-latest`; steps: checkout, `actions/setup-node` (Node 24, npm cache), `npm ci`, `npm run release:check -- ${{ github.ref_name }}`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npx electron-builder --win --publish always` with `env: GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. Pin actions to major versions.
  - README: **Releasing** (`npm version patch|minor|major`, `git push --follow-tags`, wait for CI, test the installer from the draft, click Publish) and **Updating** (apps check on launch and every 6 h; Settings → About & Updates). Tell the owner to enable 2FA and restrict who can push `v*` tags.
- [ ] **Step 4: Run the test, lint, typecheck; validate the build locally**
  Run: `npm run build:win` (no publish; `electron-builder` without `--publish` only builds).
  Expected: `dist/cloudflared-tunnel-gui-1.0.0-setup.exe`, a `.blockmap`, and `latest.yml` exist; `dist/win-unpacked/resources/app-update.yml` names the GitHub repo.
- [ ] **Step 5: Commit**
  ```bash
  git add electron-builder.yml .github scripts package.json README.md
  git commit -m "feat(release): per-user installer config, GitHub publish and tag-triggered release workflow"
  ```

---

### Task 7: Create the repo, first release, and end-to-end verification

No new code. **Needs the owner's confirmation before each outward-facing step** (creating the repo, pushing, tagging).

- [ ] **Step 1: Local end-to-end upgrade test (throwaway install, never the live service)**
  Build `1.0.0`, then bump to `1.0.1` and build again. Serve the `1.0.1` `latest.yml`, installer and blockmap with a local static HTTP server. Install `1.0.0` (confirm no UAC prompt, installs under `%LOCALAPPDATA%\Programs`), point it at the local server using a throwaway `app-update.yml` in that install's `resources` folder (generic provider, local URL), and confirm: it finds 1.0.1, downloads, shows "ready" in Settings, the tray shows "Restart to update to v1.0.1", and the button restarts into 1.0.1 with settings and tunnels intact. Confirm the update works while the window is hidden in the tray. Confirm an installed cloudflared service (use a disposable one, never the user's) keeps running through the update, then uninstall and confirm `%APPDATA%\CloudflaredTunnelGUI` is kept.
- [ ] **Step 2: Create the public GitHub repo** (after confirmation)
  Run: `gh repo create matheeshapathirana/cloudflared-tunnel-gui --public --source . --remote origin` then push `main` and the working branch, per the owner's instruction on branching.
- [ ] **Step 3: First real release** (after confirmation)
  Bump the version, tag `vX.Y.Z`, push with `git push --follow-tags`. Expect the Actions run to go green and a **draft** release to hold the `-setup.exe`, `.blockmap` and `latest.yml`; confirm the `latest.yml` `sha512` and `size` match the uploaded installer. Install it on a second machine or user account, publish the draft, then publish a later patch release and confirm the installed app updates.
- [ ] **Step 4: Record results** in the README release notes section or the PR description: what was verified, and the one thing not verifiable until signing exists (publisher check).
