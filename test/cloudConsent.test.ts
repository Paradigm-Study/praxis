import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultObserver, MockObserver, AnthropicObserver } from "../src/observer/observer.ts";
import { PrivacyControlStore } from "../src/privacy/control.ts";
import { EgressAuditor } from "../src/privacy/egress.ts";
import { freshStore } from "./helpers.ts";

test("remote observer is blocked until cloud consent and screenshots require separate consent", () => {
  const store = freshStore();
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousPreference = process.env.PRAXIS_OBSERVER;
  process.env.ANTHROPIC_API_KEY = "test-key-not-used";
  process.env.PRAXIS_OBSERVER = "anthropic";
  try {
    const blocked = defaultObserver(store);
    assert.ok(blocked instanceof MockObserver);
    assert.equal(EgressAuditor.forStore(store).recent(1)[0]?.outcome, "blocked");

    const privacy = PrivacyControlStore.forStore(store);
    privacy.update({ cloudObserverConsent: true, screenshotConsent: false });
    const textOnly = defaultObserver(store);
    assert.ok(textOnly instanceof AnthropicObserver);
    assert.equal(textOnly.wantsImages, false);

    privacy.update({ cloudObserverConsent: true, screenshotConsent: true });
    assert.equal(defaultObserver(store).wantsImages, true);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousPreference === undefined) delete process.env.PRAXIS_OBSERVER;
    else process.env.PRAXIS_OBSERVER = previousPreference;
    store.close();
  }
});
