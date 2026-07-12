# Praxis Dev Telemetry

Praxis Dev Telemetry is a Chrome Manifest V3 extension for local development. It captures browser-side failures from pages served on `localhost` or `127.0.0.1` and sends them into the Praxis event ledger.

It captures:

- `console.error` calls
- uncaught script errors
- unhandled promise rejections
- failed `fetch` and `XMLHttpRequest` requests, including HTTP responses with status 400 or higher and network failures

Resource-load errors are not recorded in v0 because they tend to create noisy, low-value telemetry. Response bodies, request bodies, and request or response headers are never captured.

## Scope and delivery

The extension runs only on pages matching `http://localhost/*` and `http://127.0.0.1/*`. Chrome match patterns ignore ports, so local development servers on any port are covered. It never runs on the open web.

Queued events are sent in batches every three seconds to:

```text
POST http://127.0.0.1:4319/api/ingest/browser
```

If the Praxis studio server is unavailable, the batch is dropped silently and is not retried. The telemetry endpoint itself is excluded from network-error capture to prevent feedback loops.

## Payload

Each request has this shape:

```json
{
  "events": [
    {
      "kind": "console_error",
      "url": "http://localhost:3000/dashboard",
      "message": "Example failure",
      "stack": "Error: Example failure\n    at ...",
      "ts": "2026-07-12T20:00:00.000Z"
    },
    {
      "kind": "network_error",
      "url": "http://localhost:3000/api/items",
      "message": "HTTP 500 Internal Server Error",
      "status": 500,
      "ts": "2026-07-12T20:00:01.000Z"
    }
  ]
}
```

`kind` is either `console_error` or `network_error`. `stack` and `status` are optional. Messages are truncated to 1,000 characters and stacks to 2,000 characters in the extension; the server applies the same limits as defense in depth.

## Load the extension

1. Start Praxis studio on its default loopback address and port, `127.0.0.1:4319`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose this `browser-ext` directory.
6. Open or reload a page served from `localhost` or `127.0.0.1`.

## Privacy and security

- Capture is limited by the manifest to local HTTP development pages; no open-web pages are matched.
- Delivery stays on loopback at `127.0.0.1`.
- Request and response bodies and headers are not captured.
- Messages and stacks are truncated before delivery.
- The server independently enforces a loopback-only caller check, a 64 KiB request-body limit, strict batch validation, and its own truncation limits.

## v0 architecture

The content script runs in Chrome's `MAIN` world so its `console`, `fetch`, and `XMLHttpRequest` patches observe the page's real traffic. In v0 it posts batches directly to the loopback Praxis endpoint using a pristine reference to the page's native `fetch` function.

The Manifest V3 background service worker is intentionally thin. It is retained as the future relay point for centralized batching across tabs, but it does not participate in network delivery today.
