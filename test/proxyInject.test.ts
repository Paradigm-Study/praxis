import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { openStore, type Store } from "../src/storage/index.ts";
import { makeIngest } from "../src/capture/ingest.ts";
import { AiProxySource } from "../src/capture/sources/aiProxy.ts";
import { startAiProxy } from "../src/capture/sources/aiProxyServer.ts";
import {
  buildInjectionBlock,
  detectBodyShape,
  formatInjectionBlock,
  injectIntoBody,
} from "../src/capture/sources/proxyInject.ts";

const HEADER = "## How this user works (praxis)";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port));
  });
}

// startAiProxy already calls listen(); just await the bound port.
async function portOf(server: Server): Promise<number> {
  if (!server.address()) {
    await new Promise((resolve) => server.once("listening", resolve));
  }
  return (server.address() as { port: number }).port;
}

const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

function seedEpisode(store: Store, goal: string): void {
  store.episodes.put({
    id: "episode_proxy_inject",
    type: "context_episode",
    startTs: "2026-07-12T12:00:00.000Z",
    endTs: "2026-07-12T12:05:00.000Z",
    summary: "Proxy injection work",
    goal,
    actions: [],
    artifacts: [],
    decisionPoints: [],
    rejectedPaths: [],
    uncertainty: [],
  });
}

test("detectBodyShape recognizes supported provider bodies", () => {
  assert.equal(detectBodyShape({ system: "Be helpful" }), "anthropic");
  assert.equal(detectBodyShape({ model: "claude-x" }), "anthropic");
  assert.equal(detectBodyShape({ system: [] }), "anthropic");
  assert.equal(detectBodyShape({ messages: [] }), "openai");
  assert.equal(detectBodyShape({}), "unknown");
});

test("injectIntoBody appends to an Anthropic string system without mutation", () => {
  const body = {
    model: "claude-test",
    system: "Original system",
    messages: [{ role: "user", content: "A task" }],
  };
  const original = structuredClone(body);

  const result = injectIntoBody(body, "anthropic", "Praxis context");

  assert.deepEqual(result, {
    ...original,
    system: "Original system\n\nPraxis context",
  });
  assert.deepEqual(body, original);
  assert.notStrictEqual(result, body);
});

test("injectIntoBody appends to an Anthropic system content array", () => {
  const body = {
    system: [{ type: "text", text: "Original system" }],
  };
  const original = structuredClone(body);

  const result = injectIntoBody(body, "anthropic", "Praxis context");

  assert.deepEqual(result, {
    system: [
      { type: "text", text: "Original system" },
      { type: "text", text: "Praxis context" },
    ],
  });
  assert.deepEqual(body, original);
});

test("injectIntoBody sets a missing Anthropic system", () => {
  const body = { model: "claude-test", messages: [] };
  const result = injectIntoBody(body, "anthropic", "Praxis context");

  assert.deepEqual(result, {
    model: "claude-test",
    messages: [],
    system: "Praxis context",
  });
});

test("injectIntoBody updates or prepends an OpenAI system message without mutation", () => {
  const withSystem = {
    model: "gpt-test",
    messages: [
      { role: "system", content: "Original system" },
      { role: "user", content: "A task" },
    ],
  };
  const withSystemOriginal = structuredClone(withSystem);
  const appended = injectIntoBody(withSystem, "openai", "Praxis context");
  assert.deepEqual(appended, {
    model: "gpt-test",
    messages: [
      { role: "system", content: "Original system\n\nPraxis context" },
      { role: "user", content: "A task" },
    ],
  });
  assert.deepEqual(withSystem, withSystemOriginal);

  const withoutSystem = {
    model: "gpt-test",
    messages: [{ role: "user", content: "A task" }],
  };
  const withoutSystemOriginal = structuredClone(withoutSystem);
  const prepended = injectIntoBody(withoutSystem, "openai", "Praxis context");
  assert.deepEqual(prepended, {
    model: "gpt-test",
    messages: [
      { role: "system", content: "Praxis context" },
      { role: "user", content: "A task" },
    ],
  });
  assert.deepEqual(withoutSystem, withoutSystemOriginal);

  const withoutMessages = { model: "gpt-test" };
  const withoutMessagesOriginal = structuredClone(withoutMessages);
  const created = injectIntoBody(withoutMessages, "openai", "Praxis context");
  assert.deepEqual(created, {
    model: "gpt-test",
    messages: [{ role: "system", content: "Praxis context" }],
  });
  assert.deepEqual(withoutMessages, withoutMessagesOriginal);
});

test("injectIntoBody appends to OpenAI system content arrays", () => {
  const body = {
    messages: [{ role: "system", content: [{ type: "text", text: "Original" }] }],
  };
  const original = structuredClone(body);

  const result = injectIntoBody(body, "openai", "Praxis context");

  assert.deepEqual(result, {
    messages: [{
      role: "system",
      content: [
        { type: "text", text: "Original" },
        { type: "text", text: "Praxis context" },
      ],
    }],
  });
  assert.deepEqual(body, original);
});

test("injectIntoBody leaves unknown shapes unchanged while returning a copy", () => {
  const body = { model: "other", input: { text: "A task" } };
  const original = structuredClone(body);

  const result = injectIntoBody(body, "unknown", "Praxis context");

  assert.deepEqual(result, original);
  assert.deepEqual(body, original);
  assert.notStrictEqual(result, body);
});

test("formatInjectionBlock renders focus and whole claim bullets within budget", () => {
  const formatted = formatInjectionBlock(
    ["Prefers small modules.", "Runs focused tests first."],
    "Implement proxy injection.",
    2000,
  );
  assert.equal(formatted, [
    HEADER,
    "Current focus: Implement proxy injection.",
    "- Prefers small modules.",
    "- Runs focused tests first.",
  ].join("\n"));

  const first = "A".repeat(130);
  const second = "B".repeat(130);
  const budgeted = formatInjectionBlock([first, second], undefined, 200);
  assert.equal(budgeted, `${HEADER}\n- ${first}`);
  assert.ok(budgeted!.length <= 200);
  assert.doesNotMatch(budgeted!, /B/);

  assert.equal(formatInjectionBlock([], undefined, 2000), null);
});

test("buildInjectionBlock returns null for an empty store", () => {
  const store = openStore({ memory: true });
  try {
    const block = buildInjectionBlock(store, { prompt: "Implement the proxy injection module" });
    assert.equal(block, null);
  } finally {
    store.close();
  }
});

test("buildInjectionBlock includes the latest episode goal", () => {
  const store = openStore({ memory: true });
  try {
    const goal = "Finish the proxy injection safely.";
    seedEpisode(store, goal);

    const block = buildInjectionBlock(store, { prompt: "Implement the proxy injection module" });

    assert.ok(block);
    assert.match(block, /How this user works/);
    assert.ok(block.includes(goal));
    assert.ok(block.length <= 2000);
  } finally {
    store.close();
  }
});

test("buildInjectionBlock enforces default and explicit size budgets", () => {
  const store = openStore({ memory: true });
  try {
    seedEpisode(store, "G".repeat(10_000));

    const defaultBlock = buildInjectionBlock(store, {
      prompt: "Implement the proxy injection module",
    });
    const smallBlock = buildInjectionBlock(
      store,
      { prompt: "Implement the proxy injection module" },
      { maxChars: 300 },
    );

    assert.ok(defaultBlock);
    assert.ok(defaultBlock.length <= 2000);
    assert.ok(smallBlock);
    assert.ok(smallBlock.length <= 300);
  } finally {
    store.close();
  }
});

interface ProxyRoundTripOptions {
  injectionEnv: string | undefined;
  passStore: boolean;
  goal?: string;
  rawBody: string;
}

async function proxyRoundTrip(opts: ProxyRoundTripOptions): Promise<string> {
  const previousEnv = process.env.PRAXIS_PROXY_INJECT;
  const store = openStore({ memory: true });
  const source = new AiProxySource();
  let upstreamSawBody = "";
  const upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      upstreamSawBody = raw;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "claude-test", content: [] }));
    });
  });
  let proxy: Server | undefined;

  try {
    if (opts.injectionEnv === undefined) delete process.env.PRAXIS_PROXY_INJECT;
    else process.env.PRAXIS_PROXY_INJECT = opts.injectionEnv;
    if (opts.goal) seedEpisode(store, opts.goal);

    const upstreamPort = await listen(upstream);
    source.start(makeIngest(store).ingest);
    const proxyBase = {
      source,
      port: 0,
      upstreamBase: `http://localhost:${upstreamPort}`,
    };
    proxy = startAiProxy(opts.passStore ? { ...proxyBase, store } : proxyBase);
    const proxyPort = await portOf(proxy);

    const response = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-praxis-app": "Codex" },
      body: opts.rawBody,
    });
    await response.text();
    assert.equal(response.status, 200);
    return upstreamSawBody;
  } finally {
    source.stop();
    if (proxy?.listening) await close(proxy);
    if (upstream.listening) await close(upstream);
    store.close();
    if (previousEnv === undefined) delete process.env.PRAXIS_PROXY_INJECT;
    else process.env.PRAXIS_PROXY_INJECT = previousEnv;
  }
}

test("AI proxy injects only when enabled, store-backed context exists", async (t) => {
  const messages = [{
    role: "user",
    content: "Please implement the proxy injection module.",
  }];
  const rawBody = `{
  "model": "claude-test",
  "system": "Original system text.",
  "messages": ${JSON.stringify(messages)}
}`;
  const goal = "Preserve transparent proxy behavior.";

  await t.test("disabled injection preserves the raw body byte-for-byte", async () => {
    const seen = await proxyRoundTrip({
      injectionEnv: "0",
      passStore: true,
      goal,
      rawBody,
    });
    assert.equal(seen, rawBody);
  });

  await t.test("enabled injection without a proxy store preserves the raw body", async () => {
    const seen = await proxyRoundTrip({
      injectionEnv: "1",
      passStore: false,
      goal,
      rawBody,
    });
    assert.equal(seen, rawBody);
  });

  await t.test("enabled injection with an empty ledger preserves the raw body", async () => {
    const seen = await proxyRoundTrip({
      injectionEnv: "1",
      passStore: true,
      rawBody,
    });
    assert.equal(seen, rawBody);
  });

  await t.test("enabled injection adds context without changing messages", async () => {
    const seen = await proxyRoundTrip({
      injectionEnv: "1",
      passStore: true,
      goal,
      rawBody,
    });
    const forwarded = JSON.parse(seen) as { system?: unknown; messages?: unknown };
    assert.equal(typeof forwarded.system, "string");
    assert.match(forwarded.system as string, /Original system text\./);
    assert.match(forwarded.system as string, /How this user works/);
    assert.deepEqual(forwarded.messages, messages);
  });
});
