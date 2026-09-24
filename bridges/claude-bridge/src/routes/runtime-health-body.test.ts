import { describe, expect, test } from "bun:test";
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
  test("an unknown session answers the empty shared shape", () => {
    expect(sessionRuntimeHealthBody(undefined)).toEqual({ summary: {}, notices: [] });
  });

  test("a session before its first query carries no MCP revision", () => {
    expect(sessionRuntimeHealthBody(session())).toEqual({ summary: {}, notices: [] });
  });

  test("carries the MCP revision beside the shared shape, with or without health", () => {
    expect(sessionRuntimeHealthBody(session({ mcpConfigRevision: revision }))).toEqual({
      summary: {},
      notices: [],
      mcpConfig: revision,
    });
    const health = new RuntimeHealthRecorder();
    health.recordUnknown("future-event");
    const body = sessionRuntimeHealthBody(session({ mcpConfigRevision: revision, health }));
    expect(body.mcpConfig).toEqual(revision);
    expect(body.summary).toEqual({ drift: { unknownEvents: 1, unknownKinds: ["future-event"] } });
  });

  test("serves a copy, so a caller cannot mutate the recorded revision", () => {
    const state = session({ mcpConfigRevision: structuredClone(revision) });
    const body = sessionRuntimeHealthBody(state) as { mcpConfig: typeof revision };
    body.mcpConfig.sources.user = "sha256:other";
    expect(state.mcpConfigRevision?.sources.user).toBe("sha256:user");
  });
});
