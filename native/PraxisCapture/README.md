# PraxisCapture (native macOS client)

The Layer 1 native capture client. It multiplexes four OS taps and emits
normalized **NDJSON raw events** on stdout for the TypeScript ingest bridge
(`src/capture/sources/nativeBridge.ts`) to consume.

| Tap | API | Emits | Permission |
|-----|-----|-------|------------|
| Focus timeline | `NSWorkspace` | `focus_timeline / app_focused` | none |
| Input events | `CGEventTap` | `input_events / key_down`, `mouse_click` | Accessibility |
| Clipboard | `NSPasteboard` | `clipboard / clipboard_changed` (body read only after policy) | Accessibility (window exclusion preflight) |
| Accessibility | `AXUIElement` | `accessibility / focused_text_changed`, `ui_snapshot` | Accessibility |
| Conversations | AX tree walk | `accessibility / conversation_bubble_added` — **any chat UI**, no per-app code | Accessibility |
| Screen frames | `ScreenCaptureKit` | `screen_video / frame` per display (+ PNG blob, OCR'd EN/中文; change-detected) | Screen Recording |
| System audio | `SCStream capturesAudio` | `audio / transcript_segment`, `playback_state` — on-device transcription, transcripts only | Screen Recording (same grant) |
| Microphone | `AVAudioEngine` | `audio / transcript_segment` (channel `mic`) | Microphone + Speech Recognition |

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
swift run praxis-capture --dev-policy-compat           # standalone development
.build/debug/praxis-capture --dev-policy-compat --once # single development snapshot
.build/debug/praxis-capture --dev-policy-compat --no-prompt # don't pop the prompt
```

Flags: `--frame-interval=3.0`, `--ax-interval=2.0`, `--once`, `--no-prompt`,
`--audio-system`, `--audio-mic` (audio is opt-in per channel; raw audio is never
written — only on-device transcripts and playback transitions), and
`--dev-policy-compat` (explicit fail-open compatibility for standalone
development only).

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

## Acquisition-time privacy fence

Production capture requires the atomically published, versioned policy at
`data/native-acquisition-policy.json` (or `PRAXIS_NATIVE_POLICY_PATH`). Missing,
corrupt, unknown-version, and stale policy files fail closed. The native client
checks private/timed-pause state, each native source toggle, suspend and battery
state, plus excluded apps/windows before screenshot, AX tree, input, audio, or
clip-buffer work. `sources.screen_video` controls local pixels; the separate
cloud screenshot consent remains an egress-only observer control.

The Node `CaptureManager` writes the first snapshot before sources start and
renews its 30-second lease every 10 seconds. Direct native development must opt
into the compatibility flag shown above; PraxisBar always uses required mode.

The native clipboard poller baselines pasteboard generations while policy is
denied without reading their bodies, preventing content copied in a private or
excluded window from appearing after resume. The legacy Node `pbpaste` poller
is not used by consumer/native capture.

Permission-host integrations can query/request the exact capture executable's
TCC identity with `--permission-status`, `--request-screen-recording`, and
`--request-accessibility`. Each mode prints exactly one JSON status line and
exits; packaged callers should use the signed capture-host app, not the Electron
process's unrelated permission state.

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
