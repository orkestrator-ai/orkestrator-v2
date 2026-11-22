import { describe, expect, test } from "bun:test";
import path from "node:path";

import { agentTestCapabilityHomes, testCapabilityHomes } from "./native-ownership.js";

const DATA = path.resolve("/profiles/qa/data");
const ISOLATED = path.join(DATA, "agent-credentials");
const FALLBACK = testCapabilityHomes(path.join(DATA, "capability-test-home"));

/** The environment `createBackendProcessEnvironment` gives an isolated profile's backend. */
function profileEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ORKESTRATOR_AGENT_TEST_ISOLATED: "1",
    HOME: path.join(ISOLATED, "home"),
    CLAUDE_CONFIG_DIR: path.join(ISOLATED, "claude"),
    CODEX_HOME: path.join(ISOLATED, "codex"),
    XDG_CONFIG_HOME: path.join(ISOLATED, "xdg-config"),
    ...overrides,
  };
}

describe("agentTestCapabilityHomes", () => {
  test("an isolated profile writes into the homes its own agents read", () => {
    expect(agentTestCapabilityHomes(DATA, profileEnv())).toEqual({
      home: path.join(ISOLATED, "home"),
      claudeConfigDir: path.join(ISOLATED, "claude"),
      codexHome: path.join(ISOLATED, "codex"),
      xdgConfigHome: path.join(ISOLATED, "xdg-config"),
    });
  });

  test("unset provider homes default under the isolated HOME", () => {
    const env = profileEnv({
      CLAUDE_CONFIG_DIR: undefined,
      CODEX_HOME: undefined,
      XDG_CONFIG_HOME: undefined,
    });
    const home = path.join(ISOLATED, "home");
    expect(agentTestCapabilityHomes(DATA, env)).toEqual(testCapabilityHomes(home));
  });

  test("without the isolation marker it keeps the private test home", () => {
    expect(
      agentTestCapabilityHomes(DATA, profileEnv({ ORKESTRATOR_AGENT_TEST_ISOLATED: undefined })),
    ).toEqual(FALLBACK);
  });

  test("any home outside the data directory falls back for all of them", () => {
    for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
      expect(agentTestCapabilityHomes(DATA, profileEnv({ [key]: "/Users/someone" }))).toEqual(
        FALLBACK,
      );
    }
    // A sibling whose name only starts with the data directory's is outside it.
    expect(agentTestCapabilityHomes(DATA, profileEnv({ HOME: `${DATA}-other/home` }))).toEqual(
      FALLBACK,
    );
    expect(
      agentTestCapabilityHomes(DATA, profileEnv({ CODEX_HOME: path.join(DATA, "..", "codex") })),
    ).toEqual(FALLBACK);
    expect(agentTestCapabilityHomes(DATA, profileEnv({ HOME: DATA }))).toEqual(FALLBACK);
    expect(agentTestCapabilityHomes(DATA, profileEnv({ HOME: "relative/home" }))).toEqual(FALLBACK);
  });
});
