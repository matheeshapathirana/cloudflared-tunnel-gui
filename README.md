# Cloudflared Tunnel GUI

A Windows desktop app for managing [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) on your own machine, without living in a terminal. Built with Electron, React and TypeScript.

It supports all three kinds of tunnel in one list:

| Kind                     | What it is                                                                                            | Needs                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Quick**                | A throwaway `*.trycloudflare.com` URL for a local port.                                               | Nothing: no account, no domain.          |
| **Remote** (API-managed) | A named tunnel on your own domain, with hostnames and DNS records managed through the Cloudflare API. | A Cloudflare API token (see below).      |
| **Local** (config-file)  | A named tunnel defined by `~/.cloudflared/*.yml` and a credentials file.                              | `cloudflared tunnel login` (`cert.pem`). |

## Features

- Start and stop tunnels, with live status and logs; crashed tunnels restart with a back-off.
- Quick share: expose a port or URL in one click and copy or open the public URL.
- Remote tunnels: create and delete tunnels, add and remove public hostnames (the routing rule and the DNS record together).
- Local tunnels: edit ingress rules in a form or as raw YAML (validated by `cloudflared` before saving, with automatic backups you can restore), create and delete tunnels.
- Import: finds your existing tunnels from `~/.cloudflared`, the Cloudflare API and installed `cloudflared` Windows services.
- Windows services: see, start, stop, restart, install and uninstall `cloudflared` services, and "adopt" an existing one so the app can show its live status and logs (each action asks for administrator approval).
- Tray icon, close-to-tray, launch at login and auto-start for chosen tunnels.
- Detects `cloudflared`, shows its version, and can download updates (checked against its published SHA-256 and Cloudflare's code signature).
- Light, dark, or follow-Windows theme.

## Requirements

- Windows 10 or 11 (64-bit).
- [`cloudflared`](https://github.com/cloudflare/cloudflared/releases) installed, or let the app download it from Settings.
- Node.js 24 and npm to build from source.

## Connecting a Cloudflare account (optional)

Remote tunnels and DNS routing use a Cloudflare API token. In **Settings → Cloudflare Account → Connect Account**, use _Create token in Dashboard_. It opens Cloudflare's token page with these permissions pre-filled:

- Account → Cloudflare Tunnel → Edit
- Zone → DNS → Edit
- Zone → Zone → Read

Then choose your account under _Account Resources_ and your domains under _Zone Resources_, create the token, and paste it into the app. The token is stored encrypted with Windows DPAPI (`safeStorage`) and never leaves the main process. The app checks the token before saving it and tells you which permission is missing.

> Tokens can have an expiry date. If the app starts showing authorization errors, check the token's TTL in the Cloudflare dashboard.

## Development

```bash
npm install
npm run dev          # run the app with hot reload
npm run typecheck
npm run lint
npm test             # Vitest; some tests run real PowerShell and read-only Windows APIs
```

## Building

```bash
npm run build:unpack # unpacked app in dist/win-unpacked
npm run build:win    # NSIS installer in dist/
```

The installer is **not code-signed**, so Windows SmartScreen will warn when it is first run.

## Where things are stored

| What                                 | Where                                                        |
| ------------------------------------ | ------------------------------------------------------------ |
| App state (tunnel list, preferences) | `%APPDATA%\CloudflaredTunnelGUI\state.json`                  |
| Encrypted API token                  | `%APPDATA%\CloudflaredTunnelGUI\token.enc`                   |
| Downloaded `cloudflared`             | `%LOCALAPPDATA%\CloudflaredTunnelGUI\bin\`                   |
| Services the app installs            | `C:\ProgramData\CloudflaredTunnelGUI\` (administrators-only) |
| Local tunnel configs and credentials | `~/.cloudflared/` (managed by `cloudflared`)                 |

## Deleting tunnels

Deleting a tunnel is permanent. For a local tunnel the app deletes the tunnel in Cloudflare and then its own config file, that config's backups and its `<tunnel-id>.json` credentials, and only after the Cloudflare step succeeds. It never touches `cert.pem`, and it refuses to delete a tunnel that a Windows service is running.

## Status and known limitations

- Windows only.
- The **Windows service** actions were tested end to end on Windows 11 with disposable services: install (with the token kept in an administrators-only file), restart, adopt (including a service shaped like `cloudflared service install`, which keeps its original arguments), uninstall, and refusing a duplicate. They have not been tested on other Windows versions, and the tunnel-token file's restricted permissions mean the app itself cannot read it back, by design.
- Service log files (`--logfile`) are not rotated; a long-running service's log keeps growing until the service is uninstalled.
- No auto-update for the app itself.

## Project layout

```
src/main       Electron main process: tunnel supervision, Cloudflare API, services, storage, IPC
src/preload    The typed bridge exposed to the UI
src/renderer   React UI (Tailwind, shadcn/ui, TanStack Query)
src/shared     Schemas and the IPC contract shared by both sides
docs/          Design spec and implementation plans
```

The design is described in [`docs/superpowers/specs/2026-10-14-cloudflared-tunnel-gui-design.md`](docs/superpowers/specs/2026-10-14-cloudflared-tunnel-gui-design.md).

## License

Released under the [MIT License](LICENSE). The open-source libraries bundled with the app, and their licenses, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (regenerate it with `npm run notices` after changing dependencies).

## Credits and disclaimer

This project was inspired by [hidumou/cloudflared-tunnel-gui](https://github.com/hidumou/cloudflared-tunnel-gui), a small Electron app for managing a single `cloudflared` tunnel. This is an independent implementation; it contains no code from that project.

Cloudflared Tunnel GUI is an independent, community project. It is **not affiliated with, endorsed by, or sponsored by Cloudflare, Inc.** "Cloudflare", "Cloudflare Tunnel" and "cloudflared" are trademarks of Cloudflare, Inc., used here only to describe what the app works with.
