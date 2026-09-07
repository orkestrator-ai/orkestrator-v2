import { describe, expect, test } from "bun:test";
import {
  indexAgentPaths,
  parentAgentPath,
  parseSpawnResult,
  requestedSpawnPath,
  validAgentPath,
} from "./subagent-spawn.js";

describe("subagent spawn identity", () => {
  test("parses only established success and capacity-failure results", () => {
    expect(parseSpawnResult('{"task_name":"/root/review"}')).toEqual({
      agentPath: "/root/review",
    });
    expect(parseSpawnResult('{"agent_id":"child","task_name":"/root/review"}')).toEqual({
      agentId: "child",
      agentPath: "/root/review",
    });
    expect(parseSpawnResult("collab spawn failed: agent thread limit reached")).toEqual({
      failed: true,
    });
    for (const unknown of ["", "{", "agent thread limit reached", "collab spawn failed", null]) {
      expect(parseSpawnResult(unknown)).toEqual({});
    }
  });

  test("resolves requested paths relative to root and nested parent agents", () => {
    const spawn = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: '{"task_name":"review"}',
      },
    };
    expect(parentAgentPath([{ type: "session_meta", payload: { source: "vscode" } }])).toBe(
      "/root",
    );
    expect(
      parentAgentPath([{ type: "session_meta", payload: { source: { custom: "fixture" } } }]),
    ).toBe("/root");
    expect(
      parentAgentPath([{ type: "session_meta", payload: { source: { internal: "fixture" } } }]),
    ).toBe("/root");
    expect(
      parentAgentPath([
        {
          type: "session_meta",
          payload: {
            source: {
              subagent: { thread_spawn: { agent_path: "/root/implementation" } },
            },
          },
        },
      ]),
    ).toBe("/root/implementation");
    expect(requestedSpawnPath(spawn, "/root/implementation")).toBe("/root/implementation/review");
    expect(
      requestedSpawnPath(
        { ...spawn, payload: { ...spawn.payload, arguments: '{"task_name":"review.v2"}' } },
        "/root/implementation",
      ),
    ).toBe("/root/implementation/review.v2");
  });

  test("keeps conflicting live path identities ambiguous", () => {
    const item = (id: string, path = "/root/review") => ({
      type: "subagent_activity",
      agent_thread_id: id,
      agent_path: path,
    });
    expect(indexAgentPaths([item("same"), item("same")]).get("/root/review")).toBe("same");
    expect(indexAgentPaths([item("first"), item("second")]).get("/root/review")).toBeNull();
    expect(indexAgentPaths([item("nested", "/root/parent/review")])).toEqual(
      new Map([["/root/parent/review", "nested"]]),
    );
    expect(validAgentPath("/root/review")).toBe(true);
    expect(validAgentPath("/root/review.v2")).toBe(true);
    expect(validAgentPath("/root/révision")).toBe(true);
    expect(validAgentPath("/other/review")).toBe(false);
  });
});
