import { describe, expect, test } from "bun:test";
import { parseAgentTestArguments } from "../../apps/desktop/scripts/dev/arguments";
import { devTestRestartArgs } from "./profile-restart-args";

/** What the launcher would run with, as `dev-test.ts` parses it. */
function relaunched(stored: Parameters<typeof devTestRestartArgs>[1]) {
  const args = devTestRestartArgs("qa-restart", stored);
  expect(args.slice(0, 3)).toEqual(["apps/desktop/scripts/dev-test.ts", "--profile", "qa-restart"]);
  return parseAgentTestArguments(args.slice(1));
}

describe("devTestRestartArgs", () => {
  test("a credential-free profile comes back credential-free", () => {
    const parsed = relaunched({ credentialSources: [], agentPlatforms: ["pi"] });
    expect(parsed.credentialSources).toEqual([]);
    expect(parsed.agentPlatforms).toEqual(["pi"]);
  });

  test("named credential sources are passed one by one", () => {
    const parsed = relaunched({
      credentialSources: ["claude", "codex"],
      agentPlatforms: ["claude", "codex"],
    });
    expect(parsed.credentialSources).toEqual(["claude", "codex"]);
    expect(parsed.agentPlatforms).toEqual(["claude", "codex"]);
  });

  test("a record without a list keeps the launcher's default", () => {
    expect(devTestRestartArgs("qa-restart", {})).toEqual([
      "apps/desktop/scripts/dev-test.ts",
      "--profile",
      "qa-restart",
    ]);
  });
});
