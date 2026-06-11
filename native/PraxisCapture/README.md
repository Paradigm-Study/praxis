# PraxisCapture (native macOS client)

The Layer 1 native capture client. It multiplexes four OS taps and emits
normalized **NDJSON raw events** on stdout for the TypeScript ingest bridge
(`src/capture/sources/nativeBridge.ts`) to consume.

| Tap | API | Emits | Permission |
|-----|-----|-------|------------|
| Focus timeline | `NSWorkspace` | `focus_timeline / app_focused` | none |
| Input events | `CGEventTap` | `input_events / key_down`, `mouse_click` | Accessibility |
| Accessibility | `AXUIElement` | `accessibility / focused_text_changed`, `ui_snapshot` | Accessibility |
| Conversations | AX tree walk | `accessibility / conversation_bubble_added` — **any chat UI**, no per-app code | Accessibility |
| Screen frames | `ScreenCaptureKit` | `screen_video / frame` (+ PNG blob, OCR'd) | Screen Recording |

The **conversation tap** is the universal alternative to a proxy-per-app: it
walks the focused window's AX tree, *baselines* each app on first sight, then
emits only newly-appeared text as bubbles — so "what you sent / what came back"
is captured for ChatGPT web, Claude desktop, Cursor, Discord, iMessage, etc. with
zero per-app logic. The reconstructor infers the *user's* message generically by
matching bubble text against the recent draft. Disable with `--no-scrape`.

## Build

```sh
swift build                      # from this directory
# or from the praxis root:
npm run native:build
```

Builds with Command Line Tools (no full Xcode required).

## Run

```sh
swift run praxis-capture                 # long-running, low-FPS
.build/debug/praxis-capture --once       # single snapshot then exit
.build/debug/praxis-capture --no-prompt  # don't pop the Screen Recording dialog
```

Flags: `--frame-interval=3.0`, `--ax-interval=2.0`, `--once`, `--no-prompt`.

Usually you don't run it directly — the TS pipeline spawns it:

```sh
npm run capture -- --native      # CaptureManager → NativeCaptureSource → ledger
```

## Permissions

Real screen/AX/input data requires granting TCC permissions in
**System Settings → Privacy & Security**:

- **Accessibility** → enables the input tap and AX snapshots.
- **Screen Recording** → enables frame capture.

The client launches regardless and **degrades gracefully**: with no permissions
it still emits the focus timeline (which alone drives `switched_app`
reconstruction). Each tap is gated on the permission it needs.

Privacy: the input tap reports only control keys (Enter, Cmd-…, Tab/Esc) and
click coordinates — never raw typed text. Draft content comes from the
Accessibility tap, not keylogging.

## Wire format

One JSON object per line on stdout:

```json
{"ts":"2026-06-08T12:00:00.000Z","source":"screen_video","app":"Codex",
 "window":"Codex","type":"frame","payload":{"w":1280,"h":800},
 "blobFiles":[{"kind":"image","path":"/tmp/praxis-frames/<uuid>.png"}]}
```

`blobFiles` reference temp files the client wrote; the bridge reads each into the
content-addressed blob store and deletes it. Diagnostics go to **stderr** so they
never corrupt the NDJSON on stdout.
