import { describe, expect, test } from "bun:test";
import {
  observeSessionRequest,
  publicLiveness,
  sessionRouteLabel,
  touchesLiveness,
  type SessionRouteRequest,
} from "./liveness.js";
import { newSessionState } from "./session-factory.js";

const route = (
  method: string | undefined,
  action?: string,
  subject?: string,
  detail?: string,
): SessionRouteRequest => ({ method, action, subject, detail });

describe("Pi session liveness (todo 7540)", () => {
  test("labels name the route, never an id", () => {
    expect(sessionRouteLabel(route("GET"))).toBe("GET session");
    expect(sessionRouteLabel(route("GET", "mcp"))).toBe("GET mcp");
    expect(sessionRouteLabel(route("POST", "commands", "refresh"))).toBe("POST commands/refresh");
    expect(sessionRouteLabel(route("GET", "transcript", "detail"))).toBe("GET transcript/detail");
    expect(sessionRouteLabel(route("POST", "approvals", "approval-7f3a", "hold"))).toBe(
      "POST approvals/:id/hold",
    );
    expect(sessionRouteLabel(route("BREW", "branches", "secret-branch-id"))).toBe(
      "OTHER branches/:id",
    );
  });

  test("only a person's action refreshes the idle clock", () => {
    // Reads, whoever issues them: tab live updates, discovery renewals, sweeps.
    for (const action of [undefined, "status", "transcript", "mcp", "commands", "runtime-health"]) {
      expect(touchesLiveness(route("GET", action))).toBe(false);
    }
    for (const action of ["prompt", "attach", "config", "cancel", "compact", "steer", "fork"]) {
      expect(touchesLiveness(route("POST", action))).toBe(true);
    }
    expect(touchesLiveness(route("POST", "approvals", "a1"))).toBe(true);
    // Background writes: the backend's chosen title and an approval hold.
    expect(touchesLiveness(route("POST", "title"))).toBe(false);
    expect(touchesLiveness(route("POST", "approvals", "a1", "hold"))).toBe(false);
  });

  test("counts every request by route and whether it touched", () => {
    const state = newSessionState();
    state.lastAccessed = 5;
    expect(observeSessionRequest(state, route("GET", "mcp"), 100)).toBe(false);
    expect(observeSessionRequest(state, route("GET", "mcp"), 200)).toBe(false);
    expect(state.lastAccessed).toBe(5);
    expect(observeSessionRequest(state, route("POST", "prompt"), 300)).toBe(true);
    expect(state.lastAccessed).toBe(300);
    expect(publicLiveness(state)).toEqual({
      routes: {
        "GET mcp": { requests: 2, touches: 0 },
        "POST prompt": { requests: 1, touches: 1 },
      },
    });
  });
});
