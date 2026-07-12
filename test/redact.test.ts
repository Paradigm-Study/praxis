import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactWorkFrame } from "../src/mesh/redact.ts";
import type { WorkFrame } from "../src/mesh/types.ts";

test("redactText removes email addresses", () => {
  assert.equal(
    redactText("Contact alice.smith+mesh@example.co.uk for access"),
    "Contact [redacted] for access",
  );
});

test("redactText removes supported API key and token forms", () => {
  const cases: Array<[string, string]> = [
    ["sk-abcdefghij_123", "[redacted]"],
    ["ghp_abcdefghij123", "[redacted]"],
    ["gho_abcdefghij123", "[redacted]"],
    ["AKIA1234567890ABCDEF", "[redacted]"],
    ["xoxb-abcdefghij-12", "[redacted]"],
    [`eyJ${"a".repeat(20)}.${"b".repeat(12)}.${"c".repeat(12)}`, "[redacted]"],
    ["Bearer abcdefghijklmnop", "Bearer [redacted]"],
  ];

  for (const [secret, expected] of cases) {
    assert.equal(redactText(secret), expected);
  }
});

test("redactText removes long hex and base64-ish runs", () => {
  assert.equal(redactText("0123456789abcdef".repeat(2)), "[redacted]");
  assert.equal(
    redactText("QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA="),
    "[redacted]",
  );
});

test("redactText removes quoted literals longer than 80 characters", () => {
  for (const quote of ["'", "\"", "`"]) {
    assert.equal(redactText(`${quote}${"x".repeat(81)}${quote}`), "[redacted]");
  }
  assert.equal(redactText(`"${"x".repeat(80)}"`), `"${"x".repeat(80)}"`);
});

test("redactText truncates deterministically and preserves benign text", () => {
  const benign = "fix the login retry logic in auth.ts";
  assert.equal(redactText(benign), benign);
  assert.equal(redactText("abcdefghij", { maxChars: 5 }), "abcde");

  const sensitive = "Email alice@example.com and use sk-abcdefghijklm";
  assert.equal(redactText(sensitive), redactText(sensitive));
});

test("redactWorkFrame redacts text and drops secret-looking artifacts", () => {
  const frame: WorkFrame = {
    v: 0,
    id: "frame-1",
    kind: "workframe",
    person: "alice",
    device: "laptop",
    project: "praxis",
    ts: "2026-07-12T00:00:00.000Z",
    intent: "Email alice@example.com",
    status: "active",
    artifacts: [
      { repo: "praxis", path: ".env" },
      { repo: "praxis", path: "config/.env.local" },
      { repo: "praxis", path: "~/.ssh/id_rsa" },
      { repo: "praxis", path: "certs/server.pem" },
      { repo: "praxis", path: "aws/credentials" },
      { repo: "praxis", path: "src/index.ts" },
    ],
    uncertainty: ["Token sk-abcdefghijklm may be stale"],
    claimsTouched: ["claim-1"],
    evidenceRefs: ["hash-1"],
  };

  const result = redactWorkFrame(frame);

  assert.notEqual(result, frame);
  assert.equal(result.intent, "Email [redacted]");
  assert.deepEqual(result.uncertainty, ["Token [redacted] may be stale"]);
  assert.deepEqual(result.artifacts, [{ repo: "praxis", path: "src/index.ts" }]);
  assert.equal(frame.artifacts.length, 6, "source frame remains unchanged");
});
