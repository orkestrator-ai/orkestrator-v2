import { describe, expect, test } from "bun:test";
import { READ_ONLY_TURN_POLICY_NOTE } from "@orkestrator/protocol/native-agent";
import { resolveCursorExecutionPolicy } from "./execution-policy.js";
import { publicSession, publicStatus } from "./public.js";
import { newSessionState } from "./session-factory.js";

const sessionPolicy = resolveCursorExecutionPolicy({
  id: "interactive-host",
  sandbox: "provider",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
});

describe("reported Cursor policy", () => {
  test("a session reports its own policy", () => {
    const state = newSessionState(undefined, sessionPolicy);
    expect(publicStatus(state).policy).toEqual(sessionPolicy);
    expect(publicSession(state).policy).toEqual(sessionPolicy);
  });

  test("a read-only session reports the read-only policy its agent runs under", () => {
    const state = newSessionState(undefined, sessionPolicy);
    state.readOnly = true;
    for (const reported of [publicStatus(state).policy, publicSession(state).policy]) {
      expect(reported).toMatchObject({
        id: "coordinator-read-only",
        sandbox: "provider",
        approvals: "deny",
        projectResources: false,
        networkAccess: "restricted",
      });
      expect(String((reported as { note?: string }).note)).toContain(READ_ONLY_TURN_POLICY_NOTE);
    }
    state.readOnly = false;
    expect(publicStatus(state).policy).toEqual(sessionPolicy);
  });
});
