# Local control-plane authentication

Packaged Paradigm launches must set `PRAXIS_LOCAL_TOKEN` to at least 32 random
bytes (64 hexadecimal characters is the recommended representation) in the
environment of Praxis Studio, capture, and the AI proxy.

Studio requires `Authorization: Bearer <token>` for every `/api/*` and `/mcp`
request except the minimal `GET /api/health`. When the variable is absent,
developer source checkouts retain the historical unauthenticated loopback
behavior. Packaged builds must treat absence as a configuration failure.

The transparent AI proxy uses `Proxy-Authorization: Bearer <token>` so the
ordinary `Authorization` header remains available for the upstream model
provider. The CLI proxy is also disabled unless invoked with `--enable` or
`PRAXIS_PROXY_ENABLED=1`.

Electron supervisor contract:

1. Generate a cryptographically random token once per installed profile and
   store it in the OS credential store / Electron `safeStorage`.
2. Pass it only through each daemon's `PRAXIS_LOCAL_TOKEN` environment.
3. Attach the Studio bearer in Electron main/preload transport. Do not expose
   the token to arbitrary renderer JavaScript or log it.
4. Attach the proxy bearer through `Proxy-Authorization` when proxy routing is
   explicitly enabled.
5. Rotate the token by restarting all local daemons with the new value.

## Packaged data-encryption key

Electron materializes its `safeStorage`-wrapped Praxis master key into an
owner-only runtime file and sets:

- `PRAXIS_DATA_KEY_FILE`: file containing base64url/base64 that decodes to
  exactly 32 bytes; the file must be mode `0600`.
- `PRAXIS_DATA_KEY_VERSION`: positive integer, initially `1`.

Praxis prefers this key over its development keyring and never copies it into
the data directory or a backup. During future rotation/recovery, old keys may
be supplied temporarily as comma-separated `version:path` entries through
`PRAXIS_PREVIOUS_DATA_KEY_FILES`.

## Runtime power/suspend contract

Electron main sends authenticated `PUT /api/runtime/resources` requests with:

```json
{ "powerSource": "ac", "suspended": false, "batteryAware": true }
```

`powerSource` is `ac` or `battery`. This state lives in the runtime heartbeat,
not PrivacyControl: it never changes the user's consent. `suspended: true`
suppresses all ingest and remote observations while preserving the process and
pipe for a safe resume. Battery plus `batteryAware: true` suppresses screen
frames and remote observer calls while retaining cheaper local signals. The
same state and `effectiveState` are returned by `GET /api/capture/status`.
