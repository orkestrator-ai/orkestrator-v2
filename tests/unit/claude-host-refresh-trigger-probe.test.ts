import { describe, expect, test } from "bun:test";
import {
  hostOf,
  judge,
  PROBE_CASES,
  scrubLine,
} from "../../scripts/claude-host-refresh-trigger-probe";
import {
  CLAUDE_HOST_REFRESH_ARGS,
  CLAUDE_HOST_REFRESH_MODEL,
} from "../../apps/backend/src/core/claude-host-login-refresh-command";

const byName = (name: string) => PROBE_CASES.find((probe) => probe.name === name)!;

describe("claude host refresh trigger probe", () => {
  test("keeps the nine trigger cases with their expected token-host contacts", () => {
    expect(PROBE_CASES.map((probe) => probe.name)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
    ]);
    expect(PROBE_CASES.filter((probe) => probe.expectTokenHost).map((probe) => probe.name)).toEqual(
      ["A", "E", "F", "H"],
    );
    // An access-only login has nothing to refresh with, so it can never expect a contact.
    for (const probe of PROBE_CASES) {
      if (!probe.refreshable) expect(probe.expectTokenHost).toBe(false);
    }
  });

  test("runs the refresher's own unknown-model command", () => {
    expect(CLAUDE_HOST_REFRESH_ARGS).toContain(CLAUDE_HOST_REFRESH_MODEL);
    expect(CLAUDE_HOST_REFRESH_ARGS).toContain("--no-session-persistence");
  });

  test("passes a case that behaves as the refresher relies on", () => {
    expect(
      judge(byName("F"), {
        tokenHostContacted: true,
        tokenHostBeforeApi: true,
        exit: "1",
        credentialFileUnchanged: true,
      }),
    ).toEqual([]);
    expect(
      judge(byName("B"), {
        tokenHostContacted: false,
        tokenHostBeforeApi: null,
        exit: "timeout",
        credentialFileUnchanged: true,
      }),
    ).toEqual([]);
    // After a 401 the refresh is reactive, so it may follow the API request.
    expect(
      judge(byName("H"), {
        tokenHostContacted: true,
        tokenHostBeforeApi: false,
        exit: "1",
        credentialFileUnchanged: true,
      }),
    ).toEqual([]);
  });

  test("reports each way a new CLI could break the trigger", () => {
    expect(
      judge(byName("A"), {
        tokenHostContacted: false,
        tokenHostBeforeApi: null,
        exit: "timeout",
        credentialFileUnchanged: true,
      }),
    ).toEqual(["expected a token-host contact, saw none"]);
    expect(
      judge(byName("F"), {
        tokenHostContacted: true,
        tokenHostBeforeApi: false,
        exit: "0",
        credentialFileUnchanged: false,
      }),
    ).toEqual([
      "the refresh came after an API request, so it was not proactive",
      "expected exit 1, saw 0",
      "the fake credential file was rewritten",
    ]);
    expect(
      judge(byName("C"), {
        tokenHostContacted: true,
        tokenHostBeforeApi: true,
        exit: "0",
        credentialFileUnchanged: true,
      }),
    ).toEqual(["unexpected token-host contact", "exited 0 with no reachable API"]);
  });

  test("strips token-shaped strings from reported debug lines", () => {
    const line = scrubLine(
      "[ERROR] OAuth refresh failed: sk-ant-ort01-abc_DEF-123 eyJhbGciOi.eyJzdWIiOi.c2ln",
    );
    expect(line).toBe("[ERROR] OAuth refresh failed: <token> <jwt>");
    expect(scrubLine("x".repeat(500))).toHaveLength(200);
  });

  test("reads the host from a proxy target", () => {
    expect(hostOf("Platform.Claude.com:443")).toBe("platform.claude.com");
    expect(hostOf("api.anthropic.com")).toBe("api.anthropic.com");
  });
});
