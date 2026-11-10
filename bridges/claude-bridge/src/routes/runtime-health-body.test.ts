import { describe, expect, test } from "bun:test";
import { MCP_CONFIG_REPORTING_VERSION } from "@orkestrator/protocol/mcp-management";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import type { SessionState } from "../types/index.js";
import { sessionRuntimeHealthBody } from "./runtime-health-body.js";

const revision = {
  fingerprint: "fp",
  sources: { user: "sha256:user", project: "excluded" as const },
  scope: "user" as const,
  queryStartedAt: "2026-09-24T00:00:00.000Z",
};

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "s",
    messages: [],
    status: "idle",
    createdAt: new Date(0),
    lastActivity: new Date(0),
    ...overrides,
  } as SessionState;
}

describe("sessionRuntimeHealthBody", () => {
  test("an unknown session answers the empty shared shape, marked as reporting", () => {
    expect(sessionRuntimeHealthBody(undefined)).toEqual({
      summary: {},
      notices: [],
      mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
    });
  });

  test("a session before its first query carries no MCP revision, only the marker", () => {
    expect(sessionRuntimeHealthBody(session())).toEqual({
      summary: { state: "detached" },
      notices: [],
      mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
    });
  });

  test("carries the MCP revision beside the shared shape, with or without health", () => {
    expect(sessionRuntimeHealthBody(session({ mcpConfigRevision: revision }))).toEqual({
      summary: { state: "detached" },
      notices: [],
      mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
      mcpConfig: revision,
    });
    const health = new RuntimeHealthRecorder();
    health.recordUnknown("future-event");
    const body = sessionRuntimeHealthBody(session({ mcpConfigRevision: revision, health }));
    expect(body.mcpConfig).toEqual(revision);
    expect(body.summary).toEqual({
      state: "detached",
      drift: { unknownEvents: 1, unknownKinds: ["future-event"] },
    });
  });

  test("serves a copy, so a caller cannot mutate the recorded revision", () => {
    const state = session({ mcpConfigRevision: structuredClone(revision) });
    const body = sessionRuntimeHealthBody(state) as { mcpConfig: typeof revision };
    body.mcpConfig.sources.user = "sha256:other";
    expect(state.mcpConfigRevision?.sources.user).toBe("sha256:user");
  });

  /*
   * 0049 task 10: the full idle-detach wait observes `detached` before the
   * follow-up turn and `attached` after it through this no-touch read.
   */
  test("reports whether the session's Claude CLI is open, as attached or detached", () => {
    const runtime = (state: string, aborted = false) =>
      ({
        state,
        abortController: { signal: { aborted } },
      }) as unknown as NonNullable<SessionState["claudeRuntime"]>;
    const stateOf = (claudeRuntime?: SessionState["claudeRuntime"]) =>
      (sessionRuntimeHealthBody(session({ claudeRuntime })).summary as { state?: string }).state;
    expect(stateOf(runtime("open"))).toBe("attached");
    // Released by the idle window, ended, or being killed: no open CLI.
    expect(stateOf(undefined)).toBe("detached");
    expect(stateOf(runtime("draining"))).toBe("detached");
    expect(stateOf(runtime("ended"))).toBe("detached");
    expect(stateOf(runtime("open", true))).toBe("detached");
    const health = new RuntimeHealthRecorder();
    expect(
      (
        sessionRuntimeHealthBody(session({ claudeRuntime: runtime("open"), health })).summary as {
          state?: string;
        }
      ).state,
    ).toBe("attached");
  });

  /*
   * 0005 task 8: which CLI the session runs, as a bare counter beside the
   * state, with or without recorded health, and kept once the CLI is released.
   */
  test("reports the runtime generation beside the state, and only once a CLI launched", () => {
    const open = {
      state: "open",
      abortController: { signal: { aborted: false } },
    } as unknown as NonNullable<SessionState["claudeRuntime"]>;
    expect(
      sessionRuntimeHealthBody(session({ claudeRuntime: open, claudeRuntimeGeneration: 4 }))
        .summary,
    ).toEqual({ state: "attached", runtimeGeneration: 4 });
    expect(sessionRuntimeHealthBody(session({ claudeRuntimeGeneration: 4 })).summary).toEqual({
      state: "detached",
      runtimeGeneration: 4,
    });
    const health = new RuntimeHealthRecorder();
    health.recordUnknown("future-event");
    expect(
      sessionRuntimeHealthBody(session({ claudeRuntimeGeneration: 2, health })).summary,
    ).toEqual({
      state: "detached",
      runtimeGeneration: 2,
      drift: { unknownEvents: 1, unknownKinds: ["future-event"] },
    });
    expect(sessionRuntimeHealthBody(session()).summary).toEqual({ state: "detached" });
  });
});
