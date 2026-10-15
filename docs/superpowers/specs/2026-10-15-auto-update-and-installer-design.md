# Auto-update and installer: design

Date: 2026-10-15. Status: draft, awaiting review.

## Goal

Let people install Cloudflared Tunnel GUI on other Windows computers with a normal installer, and let installed copies find and install new versions published as GitHub Releases, with the user clicking to apply each update.

## Decisions (agreed with the project owner)

| Topic          | Decision                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting        | Public GitHub repo `matheeshapathirana/cloudflared-tunnel-gui`. Updates are read anonymously, with no token in the app.                                         |
| Updater        | `electron-updater`, GitHub provider.                                                                                                                            |
| Update UX      | Check automatically, download in the background, then ask the user to "Restart to update". Never install silently.                                               |
| Channels       | Stable only. Pre-releases and drafts are never offered.                                                                                                         |
| Installer      | NSIS, x64, per-user, no admin rights needed to install or update.                                                                                               |
| Release flow   | GitHub Actions on a `v*` tag builds, tests and uploads to a **draft** release. The owner publishes the draft manually.                                          |
| Code signing   | Not in this spec. v1 ships unsigned. SignPath Foundation (free for open source) is a separate follow-up. This design leaves a place for it (see "Signing later"). |
| Platform       | Windows 10/11 x64 only.                                                                                                                                         |

## Non-goals

- Signing the installer (follow-up).
- Beta or pre-release channel.
- macOS or Linux builds.
- Updating the `cloudflared` binary. That stays with `BinaryManager` and is unaffected.
- Showing release notes inside the app. A "What's new" link to the GitHub release page is enough.

## 1. Installer

Keep the existing `nsis` target and make the scope explicit in `electron-builder.yml`:

- `nsis.oneClick: true`, `nsis.perMachine: false`. It installs to `%LOCALAPPDATA%\Programs`, with no UAC prompt.
- Keep the existing `artifactName` (`${name}-${version}-setup.exe`), the desktop shortcut and the Start Menu shortcut.
- `nsis.deleteAppDataOnUninstall: false`. Settings, tunnels and logs under `%APPDATA%` survive an uninstall and a reinstall.
- The uninstaller removes only the app. It never touches `cloudflared` Windows services or `~/.cloudflared`. The service uninstall flow already in the app remains the only way those are removed.
- The installer closes a running copy of the app before replacing files. The app is tray-resident, so the installer relies on electron-builder's built-in running-process check. We verify this in testing (see section 7).

Add `publish` to `electron-builder.yml`:

```yaml
publish:
  provider: github
  owner: matheeshapathirana
  repo: cloudflared-tunnel-gui
  releaseType: draft
```

This makes `electron-builder --publish always` upload `…-setup.exe`, `…-setup.exe.blockmap` and `latest.yml` to a draft release, and bakes `app-update.yml` into the installed app so it knows where to look.

## 2. `UpdateManager` (main process)

New file `src/main/update/UpdateManager.ts` with a colocated test. It follows the pattern of `BinaryManager` and `ServiceManager`: dependencies are injected so the logic is testable without Electron.

**State** (a discriminated union, exported as a zod schema in `src/shared/schemas.ts`):

```
idle            { checkedAt?: number }
checking
available       { version }              // brief; download starts automatically
downloading     { version, percent }
ready           { version }              // downloaded, waiting for the user
error           { message }
```

It also exposes `currentVersion` (`app.getVersion()`) and the `autoCheck` flag.

**Behaviour**

- Active only when `app.isPackaged`. In dev the manager reports `idle` and `check()` is a no-op that returns the current version, so `npm run dev` never touches the network.
- Configures `electron-updater` with `autoDownload = true`, `autoInstallOnAppQuit = false`, `allowPrerelease = false` and `allowDowngrade = false`.
- Checks 30 seconds after launch, then every 6 hours, only if `autoCheck` is on. Manual "Check for updates" always works.
- Maps `electron-updater` events (`checking-for-update`, `update-available`, `download-progress`, `update-downloaded`, `update-not-available`, `error`) to the state above and emits `update:state` on every change.
- An error never crashes or blocks the app. It becomes the `error` state, a short message is shown in Settings, and the next scheduled check retries.
- `install()` is valid only in `ready`. It calls `quitAndInstall(false, true)`: not silent, so the user sees the installer's progress, and force-run the app after install.
- A single in-flight check at a time. A manual check during `checking` or `downloading` returns the current state.

**Safe restart.** `install()` calls `quitAndInstall`, which makes electron-updater call `app.quit()`. The existing `before-quit` handler in `src/main/index.ts` sets `isQuitting` before Electron closes any window, so close-to-tray cannot swallow the quit, and the same handler stops supervised tunnels. `isQuitting` is deliberately not set up front: `quitAndInstall` signals failure with an `error` event and does not quit, and setting the flag early would leave close-to-tray disabled for the rest of the session. `install()` resets its re-entrancy flag on such an error so the user can retry. After the update, the new version launches and auto-start tunnels start as they do on any launch. Installed Windows services are separate processes and keep running throughout.

The manager is constructed in `src/main/index.ts` with the real `autoUpdater`, and `UpdateManager.stop()` clears its timer on quit.

## 3. Settings

Add one persisted setting, `updates.autoCheck` (boolean, default `true`), to the settings schema in `src/shared/schemas.ts` and `SettingsStore`. The old settings files without the key must load with the default (the store's existing migration/default handling covers this; the test must prove it).

## 4. IPC

In `src/shared/ipc.ts`:

- `'update.getState'`: `void → UpdateStateSchema` (also returns `currentVersion`).
- `'update.check'`: `void → UpdateStateSchema`.
- `'update.install'`: `void → void` (rejects if not in `ready`).
- Event `'update:state'`: `UpdateStateSchema`.

Handlers are registered in `src/main/ipc/registerCommands.ts` in the same style as the others. `autoCheck` goes through the existing `app.getSettings` / `app.setSettings`.

## 5. UI

- **Settings → "About & Updates" card** (new section in `SettingsPage.tsx`, or a small component under `components/` to keep that already-large file from growing):
  - Current version.
  - State line: "Up to date", "Checking…", "Downloading 1.2.0 (42%)", "1.2.0 is ready", or the error text.
  - **Check for updates** button, and **Restart to update** button (shown only in `ready`).
  - "Check automatically" switch (`updates.autoCheck`).
  - "What's new" link to the GitHub releases page, opened through the existing `externalLinks` allow-list (add the repo's releases URL to it).
- **Sidebar:** a small badge on the Settings item while the state is `ready`.
- **Tray:** a menu item "Restart to update to vX" while `ready`.

No modal popups. The app manages live tunnels, so it should never interrupt the user.

## 6. Release pipeline

`.github/workflows/release.yml`, triggered on push of tags matching `v*`, running on `windows-latest`:

1. Checkout, set up Node 24, `npm ci`.
2. **Version guard:** fail if the tag (`v1.2.3`) does not equal `package.json` `version`. This prevents publishing an installer whose embedded version disagrees with its tag, which would make the updater loop or skip updates.
3. `npm run lint`, `npm run typecheck`, `npm test`.
4. `npm run build` then `npx electron-builder --win --publish always` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `permissions: contents: write`.
5. The result is a **draft** release containing the installer, blockmap and `latest.yml`. The owner reviews, edits notes (or uses GitHub's generated notes), tests the installer, then clicks **Publish**. Installed apps see the update only after that.

Release procedure for the README: `npm version <patch|minor|major>` (creates the commit and the `v*` tag) and `git push --follow-tags`, then publish the draft.

Risk: some existing tests run real PowerShell and read Windows service state. They should be safe on a clean CI runner (it has no `cloudflared` services). The first CI run confirms this, and any test that cannot run there gets skipped on CI explicitly rather than weakened.

## 7. Testing and verification

**Unit tests**

- `UpdateManager`: each event produces the right state and emits `update:state`. `install()` outside `ready` rejects. Errors become the `error` state and the next check recovers. The periodic check respects `autoCheck`. In dev (`isPackaged` false) nothing hits the updater. Stopping clears the timer. Use a fake updater and fake timers.
- Schemas and IPC: `UpdateStateSchema` accepts every state and rejects bad shapes. Old settings without `updates.autoCheck` load with `true`.

**End-to-end (manual, on a throwaway install, never the live service)**

1. Build 1.0.0 and 1.0.1 locally.
2. Serve 1.0.1's `latest.yml`, installer and blockmap from a local HTTP server, using `electron-updater`'s generic provider via a test-only `app-update.yml` (not committed).
3. Install 1.0.0 per-user and confirm no UAC prompt. Confirm it finds 1.0.1, downloads, shows "ready", then restarts into 1.0.1.
4. Confirm the installer closes the app when it's minimised to the tray, that settings and tunnels survive the update, and that an installed cloudflared service keeps running across it.
5. Uninstall and confirm `%APPDATA%` data and services are left alone.
6. Push a real `v1.0.1` tag to the real repo's CI once, confirm the draft release has all three files, and confirm `latest.yml`'s hash and size match the uploaded installer.

## Signing later (out of scope here)

Unsigned builds have two consequences. SmartScreen shows "Unknown publisher" on first install, and the updater can only check the SHA-512 in `latest.yml`, not the publisher. A compromised GitHub account could therefore push a malicious update, so the repo owner should enable 2FA and protect the `v*` tag and release permissions.

When SignPath Foundation approves the project, the follow-up adds a signing step to the workflow and `publisherName` to the Windows build config. The updater then verifies the signing identity on every update. No change to `UpdateManager` is needed.

## Files touched

New: `src/main/update/UpdateManager.ts` (+ test), `.github/workflows/release.yml`, an About & Updates UI component.
Changed: `electron-builder.yml`, `package.json` (add `electron-updater`), `src/shared/schemas.ts`, `src/shared/ipc.ts`, `src/main/ipc/registerCommands.ts`, `src/main/settings/SettingsStore.ts`, `src/main/index.ts`, `src/main/tray/TrayController.ts`, `src/main/externalLinks.ts`, `src/renderer/src/pages/SettingsPage.tsx`, `src/renderer/src/components/AppSidebar.tsx`, `README.md`.
