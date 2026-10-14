# Cloudflared Tunnel GUI — Design Spec

- **Date:** 2026-10-14
- **Status:** Draft, awaiting review
- **Working name:** Cloudflared Tunnel GUI (data folders use `CloudflaredTunnelGUI`)

## 1. Purpose

A Windows desktop app for managing Cloudflare Tunnels on a personal dev machine. It replaces
[hidumou/cloudflared-tunnel-gui](https://github.com/hidumou/cloudflared-tunnel-gui), which is
macOS-tested only and limited to one locally-managed tunnel plus a single `config.yml`.

### What success looks like

- Every existing tunnel on the machine and in the Cloudflare account appears in one list. That
  includes tunnels run by Windows services.
- Mapping a new public hostname (e.g. `app.example.com → http://localhost:3000`) takes under a
  minute, with no terminal.
- A quick tunnel (`*.trycloudflare.com`) can be shared in one click.
- A tunnel can be moved between "run by the app" and "run as a Windows service" in either direction.

### Context gathered on the target machine

- Windows 11, Node 24, `cloudflared 2026.10.0` at `C:\Program Files (x86)\cloudflared\`.
- A `Cloudflared` Windows service (LocalSystem, automatic start) runs a **token-based** tunnel:
  `cloudflared.exe tunnel run --token-file C:\ProgramData\cloudflared\token`.
- `~/.cloudflared/` contains a **config-file** tunnel: `config.yml`, `<tunnel-id>.json`, `cert.pem`.
- The user has a domain on Cloudflare.

## 2. Scope

### In scope (v1)

| Area | Included |
|---|---|
| Tunnel kinds | Quick tunnels, API-managed ("remote") named tunnels, config-file ("local") named tunnels |
| Import | Existing Windows services, `~/.cloudflared/*.yml`, and account tunnels via the API |
| Routes | Public hostname add/remove for remote tunnels (ingress + DNS); ingress editing for local tunnels |
| Running | Start/stop from the app, status for each tunnel, live logs, auto-restart on crash |
| Windows services | Detect, link, start/stop/restart, install, uninstall, adopt |
| Background | Close to tray, tray menu, launch at login, auto-start chosen tunnels |
| cloudflared binary | Detect, show version, check latest release, download/update with SHA-256 check |
| Packaging | Windows NSIS installer built locally |

### Out of scope (v1)

- macOS and Linux builds. Platform-specific code stays behind interfaces so a port is possible later.
- Metrics dashboards, drop/reconnect notifications, and Cloudflare Access protection.
- More than one Cloudflare account at a time, multi-user/team features, and localization (English only).
- Code signing and app auto-update.

## 3. Architecture

Electron app with three layers. The **main process** holds all state. The **renderer** is a
sandboxed React UI that talks to the main process only through a typed IPC bridge exposed by the **preload** script.

```
┌──────── Renderer: React + Tailwind + shadcn/ui (no Node access) ────────┐
│  Tunnels list · Tunnel detail · Quick share · Settings · Onboarding    │
└────────────────▲──────── typed IPC via preload contextBridge ──────────┘
                 │  invoke(command, payload)  /  subscribe(event)
┌────────────────┴──────────────── Main process ─────────────────────────┐
│ TunnelRegistry    ProcessSupervisor   CloudflareApi    LocalConfigStore │
│ ServiceManager    BinaryManager       SecretStore      ImportService    │
│ TrayController    StartupManager      SettingsStore    IpcRouter        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Tech stack

| Concern | Choice |
|---|---|
| Shell / build | Electron + electron-vite (`react-ts` template) |
| UI | React, Tailwind CSS v4, shadcn/ui, TanStack Query |
| Validation | zod (IPC payloads, persisted state, YAML shapes) |
| YAML | `yaml` package (keeps comments and key order on round-trip) |
| Cloudflare API | Official `cloudflare` TypeScript SDK |
| Packaging | electron-builder (NSIS) |
| Tests | Vitest (unit + integration) |

### 3.2 Main-process modules

Each module is a class behind an interface, and its dependencies are passed in through the
constructor so it can be tested on its own. Only `ServiceManager` and `StartupManager` contain
Windows-specific code.

| Module | Responsibility | Depends on |
|---|---|---|
| `SettingsStore` | Reads/writes `%APPDATA%\CloudflaredTunnelGUI\state.json` (tunnel registry and preferences); validated with zod; atomic writes | fs |
| `SecretStore` | Encrypts and decrypts the Cloudflare API token with Electron `safeStorage` (DPAPI); the token never leaves the main process | Electron |
| `TunnelRegistry` | The single list of `Tunnel` records; CRUD; emits change events | `SettingsStore` |
| `ImportService` | Discovers tunnels from services, config files and the API; merges them by Cloudflare tunnel ID | `ServiceManager`, `LocalConfigStore`, `CloudflareApi`, `TunnelRegistry` |
| `ProcessSupervisor` | Spawns and stops app-run cloudflared processes; assigns metrics ports; polls `/ready` and `/quicktunnel`; keeps a log ring buffer for each tunnel; restarts with backoff; cleans up orphans | `BinaryManager` |
| `CloudflareApi` | Wraps the SDK: verify token, list accounts and zones, tunnel CRUD, get/put remote ingress config, DNS record CRUD, get tunnel token, list connections | `SecretStore` |
| `LocalConfigStore` | Finds, parses, edits and validates `config.yml` files; timestamped backups; runs `cloudflared tunnel create/login/route dns` | `BinaryManager` |
| `ServiceManager` | Lists cloudflared services and parses their command lines; queries state; runs elevated scripts for start/stop/restart/install/uninstall/adopt | `BinaryManager` |
| `BinaryManager` | Finds the cloudflared binary, reports its version, checks GitHub releases, downloads and verifies the binary | fs, net |
| `TrayController` | Tray icon and menu (tunnel toggles, Quick share, Open, Quit) | `TunnelRegistry`, `ProcessSupervisor` |
| `StartupManager` | Launch at login (`app.setLoginItemSettings`, starts hidden); auto-starts tunnels marked `autoStart` | `TunnelRegistry`, `ProcessSupervisor` |
| `IpcRouter` | Registers IPC commands, validates payloads with zod, maps domain errors to typed results | all of the above |

## 4. Data model

### 4.1 Persisted

```ts
type Tunnel = {
  id: string                        // app-local uuid
  name: string
  kind: 'quick' | 'remote' | 'local'
  cfTunnelId?: string               // remote + local
  runMode: 'app' | 'service'
  serviceName?: string              // set when runMode = 'service'
  autoStart: boolean                // app mode: start when the app launches
  quick?: { target: string }        // e.g. http://localhost:3000
  local?: { configPath: string }    // absolute path to the tunnel's YAML
}

type AppState = {
  version: 1
  tunnels: Tunnel[]
  account?: { accountId: string; accountName: string }  // the token itself lives in SecretStore
  binary: { overridePath?: string }
  startup: { launchAtLogin: boolean; startHidden: boolean }
  recentQuickTargets: string[]       // last 10
  runningPids: Record<string, number> // tunnel id → pid, used for orphan cleanup
}
```

**Routes are not stored in the app.** For remote tunnels, Cloudflare's API holds them. For local
tunnels, the YAML file holds them. Either way they are re-read when needed, so nothing drifts out of sync.

### 4.2 Runtime only

```ts
type TunnelStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'connected'; connections: number; quickUrl?: string }
  | { state: 'degraded'; reason: string }            // process up, 0 connections
  | { state: 'crashed'; exitCode: number | null; lastLines: string[] }
  | { state: 'unknown' }                             // e.g. service without a metrics port
```

## 5. Import

Import runs on first launch and when the user presses **Refresh**. Each source produces candidate
records. Candidates are merged by `cfTunnelId`, and existing registry entries keep the user's
settings (name, autoStart).

1. **Windows services.** List services whose image is `cloudflared.exe` (from `Win32_Service`) and parse each `PathName`:
   - `--token-file <path>` or `--token <value>`: decode the token (base64 JSON; `t` is the tunnel ID, `a` the account tag) and link the service to that remote tunnel. If the token file cannot be read without elevation, the service is listed as **unlinked**. A "Link…" picker lets the user choose the tunnel, or an elevated read can be run on request.
   - `--config <path>`: link the service to the local tunnel defined in that file.
   - No usable flags: list it as unlinked.
2. **Config files.** Scan `~/.cloudflared/*.yml` and `*.yaml` for `tunnel:` and `credentials-file:`. Each valid file becomes a `local` tunnel.
3. **API** (only when a token is configured). List the account's `cfd_tunnel`s that are not deleted:
   - `config_src: cloudflare` becomes a `remote` tunnel.
   - `config_src: local` is matched to a config file by tunnel ID. With no match, it is shown as **"config not on this machine"**: it can be deleted but not run.

Without an API token, import still finds services and config files. Remote tunnels found through
services appear with limited features, and the UI prompts the user to add a token.

## 6. Flows

### 6.1 Onboarding (first run)

1. **cloudflared:** detect the binary. If it is missing, offer a download (§6.8).
2. **Cloudflare API token** (can be skipped). The app opens the dashboard's API token page with
   the permission groups pre-filled: *Account › Cloudflare Tunnel › Edit*, *Zone › DNS › Edit*,
   *Zone › Zone › Read*. The user pastes the token. The app verifies it, lists accounts (or asks
   the user to pick one if there are several), lists zones, and names any missing permission.
3. **Import:** run §5 and show the result.

### 6.2 Quick share

1. The user enters a port or URL; a bare port becomes `http://localhost:<port>`.
2. The app spawns: `cloudflared tunnel --no-autoupdate --output json --metrics 127.0.0.1:<port> --config <empty-file> --url <target>`.
   `<empty-file>` is an empty YAML file in the app data folder. It stops cloudflared from picking up
   `~/.cloudflared/config.yml`, which otherwise blocks quick tunnels (to be verified in the spike, §10).
3. The app polls `GET /quicktunnel` until `hostname` is set, then shows the URL with Copy and Open buttons.
4. Quick tunnels go away when stopped. The target is added to `recentQuickTargets`.

### 6.3 Remote tunnels (API-managed)

- **Create:** name → `POST cfd_tunnel` with `config_src: "cloudflare"` → the record is added to the registry.
- **Add hostname:** pick a zone, enter a subdomain (or use the zone apex), and enter the service (`http://localhost:3000`, or `https://…` with an optional *no TLS verify* option). Then:
  1. `GET` the current remote config, add the rule **before** the catch-all, and make sure the last rule is `http_status:404`. `PUT` the config back.
  2. Create a proxied `CNAME <hostname> → <tunnelId>.cfargotunnel.com`. If a record already exists, show what it points to and ask before overwriting it.
  3. No restart is needed: cloudflared picks up remote config changes live.
- **Remove hostname:** remove the ingress rule. Delete the DNS record only if it points to this tunnel.
- **Delete tunnel:** confirm first. Stop the tunnel (app or service), remove its DNS records that point to it, then delete the tunnel through the API.
- **Run (app mode):** get the tunnel token through the API, then spawn
  `cloudflared tunnel --no-autoupdate --output json --metrics 127.0.0.1:<port> run` with
  `TUNNEL_TOKEN` passed **as an env var** (never in argv).

### 6.4 Local tunnels (config-file)

- **Edit:** a form editor (ordered rules with hostname, path and service, plus a few common
  `originRequest` options) and a **Raw YAML** tab. On save:
  1. Write to a temp file and run `cloudflared tunnel ingress validate --config <temp>`.
  2. If validation passes, back up the existing file as `<name>.bak-<timestamp>.yml` (keep the last 5), then write atomically.
  3. If the tunnel is running, offer to restart it.
- **Restore backup:** list the backups, show a diff preview, then restore.
- **DNS route for a hostname:** use the API when a token is configured. Otherwise run `cloudflared tunnel route dns <tunnel> <hostname>`.
- **Create:** requires `cert.pem`. If it is missing, a **Login** button runs `cloudflared tunnel login`, which opens the browser. Then `cloudflared tunnel create <name>` runs and the app writes `~/.cloudflared/<name>.yml` with `tunnel`, an absolute `credentials-file`, and a catch-all rule.
- **Run (app mode):** `cloudflared tunnel --no-autoupdate --output json --metrics 127.0.0.1:<port> --config <path> run`.

### 6.5 Process supervision (app mode)

- **Metrics port:** the app asks the OS for a free port (listen on `127.0.0.1:0`, read the port, close), then passes it to `--metrics`.
- **Status:** poll `GET /ready` every 2 s. `200` with `readyConnections ≥ 1` → `connected`. `503` while the process is alive → `starting` for the first 30 s, then `degraded`.
- **Logs:** cloudflared writes JSON lines to stderr. These go into a ring buffer (2,000 lines per tunnel), are streamed to the renderer, and can be exported.
- **Crashes:** unexpected exits restart with backoff: 1 s, 2 s, 5 s, 15 s, 30 s. After 5 failures within 10 minutes the tunnel goes to `crashed`, with the exit code and the last 50 lines.
- **Stop:** `taskkill /PID <pid> /T /F`. Node cannot send a console Ctrl+C to a windowless child on Windows, so the stop is forced. cloudflared keeps no local state, and the edge drops the connector's connections. The supervisor marks the exit as intentional so no restart is triggered.
- **Orphans:** PIDs are recorded in `runningPids`. On launch, any recorded PID that is still alive and is a `cloudflared.exe` process gets terminated, because it has lost its supervisor.
- **Conflict guard:** the app refuses to start a tunnel in app mode while a linked service for the same `cfTunnelId` is running.

### 6.6 Windows services

All changes go through **one elevated PowerShell script per action**
(`Start-Process powershell -Verb RunAs`). Each script is generated from validated values: the
service name must match `^cftunnel-[a-z0-9-]{1,40}$`, and paths are resolved and quoted. Each
script undoes its earlier steps if a later one fails, and returns a JSON result through a temp
file that the app reads.

- **Service binary:** services run `C:\ProgramData\CloudflaredTunnelGUI\bin\cloudflared.exe`, copied there during install. Only Administrators and SYSTEM can write to that folder. A LocalSystem service must never run a binary from a folder the user can write to, such as `%LOCALAPPDATA%`.
- **Install (remote):**
  1. Write the token to `C:\ProgramData\CloudflaredTunnelGUI\tokens\<tunnelId>`. Access: SYSTEM and Administrators only.
  2. Create the service: `sc.exe create cftunnel-<slug> binPath= "\"<svc-bin>\" tunnel --no-autoupdate --metrics 127.0.0.1:<port> --logfile \"<ProgramData>\logs\<slug>.log\" run --token-file \"<token-path>\"" start= delayed-auto DisplayName= "Cloudflare Tunnel (<name>)"`.
  3. Set recovery actions: `sc.exe failure … actions= restart/5000/restart/5000/restart/5000`.
  4. Start the service.
- **Install (local):** same as remote, except the service uses `--config "<abs path>"` instead of a token file. First the app checks that `credentials-file` is an absolute path, rewriting `~` after confirmation, because `~` resolves to the system profile under LocalSystem.
- **Move service → app:** stop and delete the service, delete the token file, then start the tunnel in the app.
- **Start / stop / restart / uninstall** are available for any linked cloudflared service, including the pre-existing `Cloudflared` service.
- **Adopt** (for services the app did not create): rewrite `binPath` to add `--metrics 127.0.0.1:<port>` and `--logfile`, so live status and logs work. Everything else is kept.
- **Status:** combine the service state (`sc query`) with `/ready` on the service's metrics port when known. Otherwise, for remote tunnels, use the API's active connections count. If neither is available, show `unknown`.
- **Logs:** tail the service's `--logfile`. The log folder is readable by Users.
- **Update service binary:** an elevated copy of the current app binary to `<svc-bin>`, then restart the services that use it. Each service shows its binary version, and services on an older version are flagged.

### 6.7 Tray and startup

- Closing the window hides it to the tray; **Quit** is in the tray menu and the app menu.
- **Tray menu:** each tunnel with a status dot and an on/off toggle, then Quick share…, Open, and Quit.
- **Quit:** if app-run tunnels are running, confirm first, then stop them all. Service tunnels are not affected.
- **Launch at login:** uses `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`. On launch, tunnels with `autoStart: true` start.
- **Single instance:** `app.requestSingleInstanceLock()`; a second launch focuses the existing window.

### 6.8 cloudflared binary manager

- **Binary lookup order:**
  1. User override path
  2. App-managed copy at `%LOCALAPPDATA%\CloudflaredTunnelGUI\bin\cloudflared.exe`
  3. `PATH`
  4. `C:\Program Files (x86)\cloudflared\` and `C:\Program Files\cloudflared\`
- **Version:** `cloudflared --version`, parsed.
- **Update check:** `GET https://api.github.com/repos/cloudflare/cloudflared/releases/latest`, comparing tag versions.
- **Download:** fetch `cloudflared-windows-amd64.exe` to a temp file with progress. Verify its SHA-256 against the checksum in the release notes. If no checksum can be found, warn and require explicit confirmation. Then move it into the app-managed location. Running app tunnels are offered a restart.

## 7. UI

- **Layout:** a sidebar with *Tunnels*, *Quick share* and *Settings*. Light/dark theme follows the system.
- **Tunnels list:** one row per tunnel showing name, kind badge (Quick / API / Config), run mode badge (App / Service), status dot with text, primary hostname, and a start/stop toggle. Includes a Refresh (import) button and a "New tunnel" menu (API-managed or config-file).
- **Tunnel detail tabs:**
  - *Overview:* status, connections, run mode with a switch action, auto-start toggle, binary version
  - *Routes:* hostnames for remote tunnels, or the ingress editor with a Raw YAML tab and Backups for local tunnels
  - *Logs:* live, filterable by level, with search and export
  - *Danger zone:* delete tunnel, uninstall service
- **Quick share:** target input with recent targets, running quick tunnels with URL, copy/open, and stop.
- **Settings:**
  - *Cloudflare account:* connected account, zones, replace/remove token
  - *cloudflared:* path, version, check/update, override path
  - *Startup:* launch at login, start hidden
  - *About*
- **Onboarding:** the three-step wizard from §6.1.

## 8. IPC contract

Commands are request/response calls (`ipcRenderer.invoke`). Every payload is validated with zod in
the main process. Results use `{ ok: true, data } | { ok: false, error: { code, message, details? } }`.

| Group | Commands |
|---|---|
| tunnels | `list`, `refresh` (import), `start`, `stop`, `rename`, `setAutoStart`, `delete` |
| quick | `start`, `stop`, `recentTargets` |
| remote | `create`, `listHostnames`, `addHostname`, `removeHostname` |
| local | `readConfig`, `saveConfig`, `validate`, `listBackups`, `restoreBackup`, `create`, `login`, `routeDns` |
| services | `list`, `start`, `stop`, `restart`, `install`, `uninstall`, `adopt`, `link`, `updateBinary` |
| account | `status`, `setToken`, `clearToken`, `listZones`, `tokenCreationUrl` |
| binary | `status`, `checkUpdate`, `download`, `setOverride` |
| app | `getSettings`, `setSettings`, `quit` |

Events (main → renderer, pushed): `tunnel:status`, `tunnel:log`, `registry:changed`, `binary:downloadProgress`.

## 9. Security and error handling

### 9.1 Security

- **Renderer lockdown:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a strict CSP, and no remote content. External links open in the default browser through `shell.openExternal`, restricted to an allowlist (dash.cloudflare.com, github.com, trycloudflare.com URLs, the user's own hostnames).
- **API token:** encrypted with `safeStorage` and never sent to the renderer. The renderer only receives account and zone metadata.
- **Tunnel tokens:** passed to app-run tunnels through the `TUNNEL_TOKEN` env var. Service tunnels read them from token files that only SYSTEM and Administrators can access. They are never put in argv and never logged; log lines are scrubbed for token-shaped strings.
- **Elevated scripts:** built only from validated values; user text is never interpolated directly. Script generation has snapshot tests.
- **Service binaries:** run only from the admin-write-only folder (§6.6).

### 9.2 Error handling

| Failure | Behaviour |
|---|---|
| cloudflared exits unexpectedly | Restart with backoff, then `crashed` with the exit code and the last 50 lines (§6.5) |
| API: missing permission | A message naming the missing permission group, with a link to edit the token |
| API: rate limited / 5xx | Up to 3 retries with exponential backoff, then an error toast |
| API: DNS record exists | A dialog showing the current target, with an overwrite option |
| Config fails validation | No write. cloudflared's validation output is shown inline |
| UAC declined / elevated script fails | The action is cancelled and earlier steps are undone. The error is shown with the script's JSON result |
| cloudflared binary missing / not runnable | A blocking banner with Download and Set path actions |
| Token file unreadable during import | The service is listed as unlinked, with Link… and "Read with admin" actions |
| Attempt to start a tunnel already run by a service | Blocked with "Managed by service X" and a Switch to app mode action |

## 10. Testing

- **Spike (before anything else).** Throwaway code that answers two questions:
  1. Does `cloudflared.exe` run correctly as a **second** service with a custom name (`cftunnel-test`) created through `sc.exe create`, including the stop signal and the recovery actions?
  2. With `~/.cloudflared/config.yml` present, does `--config <empty-file>` make quick tunnels work? If not, find another workaround (e.g. a temporary `HOME`/`USERPROFILE` override).

  The service and process designs in §6.2 and §6.6 are adjusted if either answer is no.
- **Unit (Vitest)** for the pure logic: YAML ingress editing round-trip (comments kept), ingress ordering and catch-all enforcement, service `PathName` parsing, token decoding, import/merge, binary version parsing and comparison, checksum extraction from release notes, elevated-script generation (snapshots), and status derivation from `/ready` responses.
- **Integration:** `ProcessSupervisor` against a **fake cloudflared**, a Node script that serves `/ready` and `/quicktunnel`, writes JSON log lines, and can be told to crash or hang. It covers start, stop, crash/backoff, and orphan cleanup with no network. `CloudflareApi` is tested against mocked HTTP responses.
- **Manual smoke checklist** against the real account:
  - import the existing token service tunnel and the `config.yml` tunnel
  - quick share
  - create a throwaway remote tunnel
  - add and remove a hostname
  - move it to a service and back
  - update the binary

  The checklist never touches the live `Cloudflared` service or its hostnames unless the user runs that step on purpose.

## 11. Delivery phases

Each phase ends in a working, testable app.

0. **Spike:** the two questions in §10.
1. **Skeleton:** electron-vite project, IPC router with zod, `SettingsStore`, `TunnelRegistry`, binary detection, app shell UI, single instance.
2. **Quick tunnels:** `ProcessSupervisor`, fake cloudflared, logs view, Quick share page, tray.
3. **Local tunnels:** config import, ingress editor, validation, backups, run in app, create/login.
4. **Remote tunnels:** token onboarding, `SecretStore`, `CloudflareApi`, import from API, hostnames and DNS, create/delete.
5. **Windows services:** detect/link, start/stop/restart, install/uninstall, adopt, service status and logs.
6. **Finishing:** binary download/update, launch at login and auto-start, NSIS packaging, smoke checklist.
