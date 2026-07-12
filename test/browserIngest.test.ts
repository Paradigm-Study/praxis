import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import { handleBrowserIngest } from "../src/studio/browserIngest.ts";
import type { Store } from "../src/storage/index.ts";
import { freshStore } from "./helpers.ts";

async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected an IPv4 listener"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withHandlerServer<T>(
  store: Store,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => handleBrowserIngest(store, req, res));
  const port = await listen(server);
  try {
    return await run(`http://127.0.0.1:${port}/api/ingest/browser`);
  } finally {
    await close(server);
  }
}

test("browser ingest stores a valid console and network-error batch", async () => {
  const store = freshStore();
  try {
    await withHandlerServer(store, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              kind: "console_error",
              url: "http://localhost:3000/editor",
              message: "render failed",
              stack: "Error: render failed\n    at render (app.js:10:3)",
              ts: "2026-07-12T18:00:00.000Z",
            },
            {
              kind: "network_error",
              url: "http://127.0.0.1:8080/api/items",
              message: "HTTP 500 Internal Server Error",
              status: 500,
              ts: "2026-07-12T18:00:01.000Z",
            },
          ],
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, ingested: 2 });
    });

    const events = store.events.range({ sources: ["browser_dom"] });
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => ({
        ts: event.ts,
        source: event.source,
        app: event.app,
        window: event.window,
        type: event.type,
        payload: event.payload,
      })),
      [
        {
          ts: "2026-07-12T18:00:00.000Z",
          source: "browser_dom",
          app: "browser",
          window: "http://localhost:3000/editor",
          type: "console_error",
          payload: {
            url: "http://localhost:3000/editor",
            message: "render failed",
            stack: "Error: render failed\n    at render (app.js:10:3)",
          },
        },
        {
          ts: "2026-07-12T18:00:01.000Z",
          source: "browser_dom",
          app: "browser",
          window: "http://127.0.0.1:8080/api/items",
          type: "network_error",
          payload: {
            url: "http://127.0.0.1:8080/api/items",
            message: "HTTP 500 Internal Server Error",
            status: 500,
          },
        },
      ],
    );
  } finally {
    store.close();
  }
});

test("browser ingest rejects malformed JSON without storing events", async () => {
  const store = freshStore();
  try {
    await withHandlerServer(store, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ definitely not JSON",
      });

      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json() as { error?: unknown }).error, "string");
    });
    assert.equal(store.events.count(), 0);
  } finally {
    store.close();
  }
});

test("browser ingest validates a whole batch before writing any item", async () => {
  const store = freshStore();
  try {
    await withHandlerServer(store, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              kind: "console_error",
              url: "http://localhost:3000/",
              message: "valid, but must not be ingested",
              ts: "2026-07-12T18:01:00.000Z",
            },
            { kind: "nope" },
          ],
        }),
      });

      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json() as { error?: unknown }).error, "string");
    });
    assert.equal(store.events.count(), 0);
  } finally {
    store.close();
  }
});

test("browser ingest rejects request bodies larger than 64 KiB", async () => {
  const store = freshStore();
  try {
    await withHandlerServer(store, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [], padding: "x".repeat(70_000) }),
      });

      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: "body too large" });
    });
    assert.equal(store.events.count(), 0);
  } finally {
    store.close();
  }
});

test("browser ingest rejects a non-loopback peer", async () => {
  const req = Readable.from(["ignored request body"]);
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: "192.168.1.50" },
  });

  let statusCode = 200;
  let body = "";
  let finishResponse: (() => void) | undefined;
  const responseFinished = new Promise<void>((resolve) => {
    finishResponse = resolve;
  });
  interface FakeResponse {
    statusCode: number;
    setHeader(name: string, value: string): FakeResponse;
    writeHead(code: number): FakeResponse;
    end(chunk?: string | Uint8Array): FakeResponse;
  }
  const res: FakeResponse = {
    statusCode,
    setHeader(_name: string, _value: string): FakeResponse {
      return this;
    },
    writeHead(code: number): typeof res {
      statusCode = code;
      this.statusCode = code;
      return this;
    },
    end(chunk?: string | Uint8Array): typeof res {
      if (chunk !== undefined) body += String(chunk);
      finishResponse?.();
      return this;
    },
  };

  const store = freshStore();
  try {
    handleBrowserIngest(
      store,
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    await responseFinished;

    assert.equal(statusCode, 403);
    assert.deepEqual(JSON.parse(body), { error: "loopback only" });
    assert.equal(store.events.count(), 0);
  } finally {
    store.close();
  }
});

test("browser ingest truncates messages to 1000 characters", async () => {
  const store = freshStore();
  try {
    const longMessage = "m".repeat(1_250);
    await withHandlerServer(store, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [{
            kind: "console_error",
            url: "http://localhost:5173/",
            message: longMessage,
            ts: "2026-07-12T18:02:00.000Z",
          }],
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, ingested: 1 });
    });

    const event = store.events.range()[0];
    assert.ok(event);
    assert.equal(event.payload.message, "m".repeat(1_000));
    assert.equal((event.payload.message as string).length, 1_000);
  } finally {
    store.close();
  }
});

test("browser extension scripts are syntax-valid JavaScript", () => {
  const contentScript = fileURLToPath(
    new URL("../browser-ext/content.js", import.meta.url),
  );
  const backgroundScript = fileURLToPath(
    new URL("../browser-ext/background.js", import.meta.url),
  );

  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", contentScript]);
  });
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", backgroundScript]);
  });
});
