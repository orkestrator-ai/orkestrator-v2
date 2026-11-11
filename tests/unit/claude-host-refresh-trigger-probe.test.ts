import { describe, expect, test } from "bun:test";
import {
  hostOf,
  judge,
  MESSAGES_REQUEST,
  parseArgs,
  PROBE_CASES,
  scrubLine,
  selectCases,
} from "../../scripts/claude-host-refresh-trigger-probe";

// That the probe runs the refresher's exact arguments is pinned in the
// backend's own claude-host-login-refresh.test.ts, which owns the command.

const byName = (name: string) => PROBE_CASES.find((probe) => probe.name === name)!;

/** What a fake-API case (F–I) sends when the CLI behaves. */
const answered = { apiRequests: [MESSAGES_REQUEST], usedOAuthLogin: true };
/** An unreachable-API case (A–E) reaches no fake API. */
const unreachable = { apiRequests: [], usedOAuthLogin: false };

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

  test("passes a case that behaves as the refresher relies on", () => {
    expect(
      judge(byName("F"), {
        tokenHostContacted: true,
        tokenHostBeforeApi: true,
        exit: "1",
        credentialFileUnchanged: true,
        ...answered,
      }),
    ).toEqual([]);
    expect(
      judge(byName("B"), {
        tokenHostContacted: false,
        tokenHostBeforeApi: null,
        exit: "timeout",
        credentialFileUnchanged: true,
        ...unreachable,
      }),
    ).toEqual([]);
    // After a 401 the refresh is reactive, so it may follow the API request.
    expect(
      judge(byName("H"), {
        tokenHostContacted: true,
        tokenHostBeforeApi: false,
        exit: "1",
        credentialFileUnchanged: true,
        ...answered,
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
        ...unreachable,
      }),
    ).toEqual(["expected a token-host contact, saw none"]);
    expect(
      judge(byName("F"), {
        tokenHostContacted: true,
        tokenHostBeforeApi: false,
        exit: "0",
        credentialFileUnchanged: false,
        ...answered,
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
        ...unreachable,
      }),
    ).toEqual(["unexpected token-host contact", "exited 0 with no reachable API"]);
  });

  test("fails a fake-API case that never sent the Messages request with the fake bearer", () => {
    // A CLI that refuses the command or the login locally exits 1 too.
    for (const name of ["F", "G", "H", "I"]) {
      const probe = byName(name);
      const base = {
        tokenHostContacted: probe.expectTokenHost,
        tokenHostBeforeApi: probe.expectTokenHost ? true : null,
        exit: "1",
        credentialFileUnchanged: true,
      };
      expect(judge(probe, { ...base, apiRequests: [], usedOAuthLogin: false })).toEqual([
        `expected ${MESSAGES_REQUEST} to the fake API, saw none`,
      ]);
      // Another request is not the Messages request the refresher's command sends.
      expect(
        judge(probe, { ...base, apiRequests: ["GET /api/oauth/profile"], usedOAuthLogin: true }),
      ).toEqual([`expected ${MESSAGES_REQUEST} to the fake API, saw none`]);
      // Missing or wrong bearer (an API key, another token) is not the OAuth login.
      expect(
        judge(probe, { ...base, apiRequests: [MESSAGES_REQUEST], usedOAuthLogin: false }),
      ).toEqual(["the Messages request did not carry the fake OAuth access token"]);
    }
  });

  test("fails a run that could not start or was killed by a signal", () => {
    for (const exit of ["spawn-error", "signal SIGTERM"]) {
      expect(
        judge(byName("B"), {
          tokenHostContacted: false,
          tokenHostBeforeApi: null,
          exit,
          credentialFileUnchanged: true,
          ...unreachable,
        }),
      ).toEqual([`the CLI did not run to an outcome (${exit})`]);
    }
    expect(
      judge(byName("I"), {
        tokenHostContacted: false,
        tokenHostBeforeApi: null,
        exit: "spawn-error",
        credentialFileUnchanged: true,
        ...unreachable,
      }),
    ).toEqual([
      "the CLI did not run to an outcome (spawn-error)",
      "expected exit 1, saw spawn-error",
      `expected ${MESSAGES_REQUEST} to the fake API, saw none`,
    ]);
  });

  test("refuses an unknown or empty case selection instead of passing with nothing run", () => {
    expect(selectCases(undefined).map((probe) => probe.name)).toHaveLength(9);
    expect(selectCases(["F", "A"]).map((probe) => probe.name)).toEqual(["A", "F"]);
    expect(() => selectCases(["J"])).toThrow('unknown case "J"');
    expect(() => selectCases(["A", "J"])).toThrow('unknown case "J"');
    expect(() => selectCases([])).toThrow("--cases selects no case");

    expect(
      parseArgs(["--claude", "/bin/claude", "--cases", "a, f"]).cases.map((p) => p.name),
    ).toEqual(["A", "F"]);
    expect(() => parseArgs(["--claude", "/bin/claude", "--cases", "J"])).toThrow("unknown case");
    expect(() => parseArgs(["--claude", "/bin/claude", "--cases", ""])).toThrow(
      "--cases selects no case",
    );
    expect(() => parseArgs(["--claude", "/bin/claude", "--cases", " , "])).toThrow(
      "--cases selects no case",
    );
    expect(() => parseArgs(["--claude", "/bin/claude", "--cases"])).toThrow(
      "--cases needs a value",
    );
    expect(() => parseArgs(["--claude", "/bin/claude", "--case", "A"])).toThrow(
      'unknown argument "--case"',
    );
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
