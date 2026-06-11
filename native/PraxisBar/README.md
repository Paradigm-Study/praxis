# PraxisBar (menu bar app)

A small macOS menu-bar launcher for the whole Praxis pipeline — start/stop
capture, open the Studio, run the AI proxy, grant permissions, and build the
native client, all from a few buttons. It spawns the existing `praxis` Node CLI
as child processes.

## Run

```sh
npm run bar            # from the praxis/ root  (swift run praxis-bar)
# or build once:
npm run bar:build && ./native/PraxisBar/.build/debug/praxis-bar
```

An ◉ icon appears in your menu bar. Click it:

| Button | Does |
|--------|------|
| **Start / Stop Capture** | `praxis capture --native --agent` — live taps + reconstruction + agent loop |
| **Open Studio** | starts `praxis studio` (if needed) and opens http://localhost:4319 |
| **Start / Stop AI Proxy** | `praxis proxy` on :4318 — point an AI tool's base URL here |
| **Request Screen Recording…** | triggers the macOS Screen-Recording prompt |
| **Request Accessibility…** | triggers the macOS Accessibility prompt |
| **Open Privacy Settings…** | jumps to the Privacy & Security pane |
| **Build Native Client** | `swift build` the capture client |
| **Reveal Data Folder / View Logs** | open `data/` and `data/logs/` |

The menu shows live status (🟢/⚪️ for Capture/Studio/Proxy) and permission state
(✓/✗ for Screen + Accessibility).

## Permissions

Click **Request Screen Recording…** and **Request Accessibility…** once and
approve the prompts. The grants attach to the Praxis bar app, which is launching
the capture tree. If screen/AX events still don't appear in the Studio, open
**Privacy Settings…** and confirm the app (or, in dev, the terminal you launched
from) is enabled — then toggle Capture off/on.

## Configuration

- `PRAXIS_HOME` — path to the `praxis/` project (auto-detected by climbing up
  from the launch directory / executable; set this if auto-detection fails).
- `PRAXIS_NODE` — path to the `node` binary (defaults to `node` on `PATH`; set
  this if you use nvm and launch outside a login shell).

## Packaged app + run at login (recommended)

```sh
npm run app:package      # → dist/Praxis.app (signed; capture binary bundled inside)
npm run app:install      # → launchd LaunchAgent: starts now + at every login
npm run app:uninstall    # stop + remove the LaunchAgent
```

`package-app.sh` release-builds both binaries, assembles `dist/Praxis.app`
(`LSUIElement`, bundle id `com.paradigm.praxis`), bundles `praxis-capture`
**inside** the app — the bar exports `PRAXIS_NATIVE_BIN` so the whole capture
tree runs under the app's identity — and signs it:

- **Developer ID Application** cert in your keychain → signs with it (+ hardened
  runtime). Notarize with `xcrun notarytool submit` if you want to distribute.
- otherwise → **ad-hoc** signature. Works fine locally; the one caveat is that
  re-packaging produces a new code hash, so macOS may re-ask for the
  Screen-Recording/Accessibility grants after a rebuild.

`install-launchagent.sh` writes `~/Library/LaunchAgents/com.paradigm.praxis.plist`
with `PRAXIS_HOME` + `PRAXIS_NODE` baked in (launchd has a minimal environment),
bootstraps it into your GUI session, and verifies it's alive. Logs land in
`data/logs/launchd.log`.

Grant permissions once via the menu's **Request…** buttons — they attach to the
packaged app's stable bundle identity.
