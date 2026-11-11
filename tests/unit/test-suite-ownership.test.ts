import { describe, expect, test } from "bun:test";
import {
  defaultOwners,
  explicitOwners,
  testSelectors,
} from "../source-guards/test-suite-ownership";

// The ownership of the real repository's tests is checked once, in the guard
// stage (`mise run guards`, scripts/guards.ts). These are the model's fixtures.
describe("test suite ownership model", () => {
  test("reads the selectors a bun test command hands to the runner, not flag values", () => {
    expect(
      testSelectors(
        "bun test ./src --preload ../../tests/setup-node.ts --timeout=5000 ${CI:+--bail} ./extra.test.ts",
      ),
    ).toEqual(["src", "extra.test.ts"]);
    expect(
      testSelectors("bun ../../scripts/bun-test-tier.ts backend ./src ./tests -- --parallel"),
    ).toEqual(["src", "tests"]);
    expect(() => testSelectors("bun ../../scripts/bun-test-tier.ts backend ./src")).toThrow(
      'Tier wrapper without "--"',
    );
    expect(() => testSelectors("vitest run")).toThrow("Not a bun test invocation");
  });

  test("a file has the default owners whose selectors reach it, and explicit owners by path", () => {
    const owned = { root: ["tests"], workspace: ["apps/web/src"], bridges: ["bridges/a/src"] };
    expect(defaultOwners(owned, "tests/unit/a.test.ts")).toEqual(["root"]);
    expect(defaultOwners(owned, "apps/web/src/a.test.tsx")).toEqual(["workspace"]);
    expect(defaultOwners(owned, "apps/web/srcx/a.test.tsx")).toEqual([]);
    expect(defaultOwners({ ...owned, root: ["apps/web"] }, "apps/web/src/a.test.tsx")).toEqual([
      "root",
      "workspace",
    ]);
    expect(explicitOwners("e2e/Thing.spec.ts")).toEqual(["browser"]);
    expect(explicitOwners("e2e/agent-testing/thing.spec.ts")).toEqual(["agent-browser/electron"]);
    expect(explicitOwners("e2e/agent-testing/probe.integration.test.ts")).toEqual([
      "agent opt-in qualification",
    ]);
    expect(explicitOwners("e2e/agent-testing/support.test.ts")).toEqual([]);
  });
});
