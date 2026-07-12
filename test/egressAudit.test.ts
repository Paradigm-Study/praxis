import assert from "node:assert/strict";
import { test } from "node:test";
import { EgressAuditor } from "../src/privacy/egress.ts";

test("egress audit stores metadata only and strips URL paths/query/credentials", () => {
  const auditor = new EgressAuditor();
  auditor.record({
    destination: "https://user:secret@example.com/v1/messages?token=raw-secret",
    purpose: "remote_observer",
    categories: ["screenshots", "reconstructed_actions", "screenshots"],
    bytes: 1234,
    digest: "abc123",
    outcome: "succeeded",
    status: 200,
  });
  const [record] = auditor.recent();
  assert.equal(record?.destination, "https://example.com");
  assert.deepEqual(record?.categories, ["screenshots", "reconstructed_actions"]);
  assert.equal(record?.bytes, 1234);
  assert.ok(!JSON.stringify(record).includes("raw-secret"));
  assert.ok(!JSON.stringify(record).includes("user:secret"));
});
