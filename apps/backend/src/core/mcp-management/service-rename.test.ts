import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mcpManagementErrorFromUnknown } from "@orkestrator/protocol/mcp-management";

import {
  createFixture,
  entry,
  mutation,
  revision,
  targetIdFor,
  type Fixture,
} from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

describe("rename through the service", () => {
  test("a Pi normalized-name collision refuses rename but still allows removal", async () => {
    fixture.write(
      "home/.pi/agent/mcp.json",
      JSON.stringify({
        mcpServers: { "my server": { command: "a" }, my_server: { command: "b" } },
      }),
    );
    const targetId = await targetIdFor(fixture, "pi", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    const before = fixture.read("home/.pi/agent/mcp.json");
    const error = await fixture.service
      .mutate(
        mutation(targetId, {
          kind: "rename",
          entryId: entry(snapshot, "pi:user", "my server").entryId,
          expectedRevision: revision(snapshot, "pi:user")!,
          newName: "renamed",
        }),
      )
      .catch((failure: unknown) => failure);
    expect(mcpManagementErrorFromUnknown(error)?.code).toBe("read-only-source");
    expect(fixture.read("home/.pi/agent/mcp.json")).toBe(before);
    const removed = await fixture.service.mutate(
      mutation(targetId, {
        kind: "remove",
        entryId: entry(snapshot, "pi:user", "my server").entryId,
        expectedRevision: revision(snapshot, "pi:user")!,
      }),
    );
    expect(removed.operation.phase).toBe("saved");
    expect(JSON.parse(fixture.read("home/.pi/agent/mcp.json")).mcpServers).toEqual({
      my_server: { command: "b" },
    });
  });

  test("a rename preview warns about a Claude project approval naming the old server", async () => {
    fixture.write(
      "home/.claude.json",
      JSON.stringify({
        projects: {
          [fixture.worktree]: { enabledMcpjsonServers: ["shared"], disabledMcpjsonServers: [] },
        },
      }),
    );
    fixture.write(
      "worktree/.mcp.json",
      JSON.stringify({ mcpServers: { shared: { command: "x" } } }),
    );
    const targetId = await targetIdFor(fixture, "claude", "environment");
    const snapshot = await fixture.service.snapshot({ targetId });
    const result = await fixture.service.validate(
      mutation(targetId, {
        kind: "rename",
        entryId: entry(snapshot, "claude:project", "shared").entryId,
        expectedRevision: revision(snapshot, "claude:project")!,
        newName: "shared-2",
      }),
    );
    expect(result.valid).toBe(true);
    expect(
      result.preview?.warnings.some((warning) => warning.includes("enabledMcpjsonServers")),
    ).toBe(true);
  });
});
