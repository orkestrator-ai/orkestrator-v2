import { afterEach, describe, expect, test } from "bun:test";
import type { PublicPermissionRuleList } from "@orkestrator/protocol/public-api-resources";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * `permission.rule.*` over the real registry and storage (todo 0723): rules
 * are listed and removed, with the usual request-key admission on removal.
 * Nothing here can create one.
 */

const harnesses: PublicApiHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

async function harnessWithRules(): Promise<PublicApiHarness> {
  const harness = await createPublicApiHarness();
  harnesses.push(harness);
  const store = harness.storage.permissionRuleStore();
  for (const [id, projectId, pattern] of [
    ["rule-a", "project-1", "npm test"],
    ["rule-b", "project-2", "cargo build"],
  ] as const) {
    store.create({
      id,
      provider: "codex",
      scope: "project",
      projectId,
      kind: "command-prefix",
      pattern,
      createdAt: 1,
      createdFrom: { environmentId: "env-1", agent: "codex", interactionId: "i" },
      useCount: 0,
    });
  }
  return harness;
}

describe("permission.rule public actions", () => {
  test("lists all rules or one project's", async () => {
    const harness = await harnessWithRules();
    const all = await harness.call<PublicPermissionRuleList>("permission.rule.list", {});
    expect(all.ok).toBe(true);
    expect(all.ok && all.result.rules.map((rule) => rule.id)).toEqual(["rule-a", "rule-b"]);
    const one = await harness.call<PublicPermissionRuleList>("permission.rule.list", {
      projectId: "project-2",
    });
    expect(one.ok && one.result).toMatchObject({ total: 1, rules: [{ pattern: "cargo build" }] });
  });

  test("removes a rule once per request key, and refuses an unknown one", async () => {
    const harness = await harnessWithRules();
    const removed = await harness.call(
      "permission.rule.remove",
      { ruleId: "rule-a" },
      { requestId: "remove-rule-a" },
    );
    expect(removed).toMatchObject({ ok: true, result: { ruleId: "rule-a", removed: true } });
    expect(harness.storage.permissionRuleStore().get("rule-a")).toBeNull();
    // The same key replays the recorded outcome.
    const replay = await harness.call(
      "permission.rule.remove",
      { ruleId: "rule-a" },
      { requestId: "remove-rule-a" },
    );
    expect(replay).toMatchObject({ ok: true });
    const missing = await harness.call(
      "permission.rule.remove",
      { ruleId: "rule-zzz" },
      { requestId: "remove-missing" },
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});
