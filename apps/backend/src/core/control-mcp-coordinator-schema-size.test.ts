import { expect, test } from "bun:test";
import { coordinatorRoleCapabilities, RETIRED_COORDINATOR_TOOLS } from "./control-mcp-tools.js";
import { rpc, useControlMcpServerHarness } from "./control-mcp-server-test-support.js";

/**
 * What a main coordinator's tool list costs on every turn.
 *
 * Every tool's name, description and input schema is sent to the provider with
 * each turn, so the surface is a per-turn cost that grows silently as tools are
 * added. This measures it for the largest surface (a main coordinator with
 * messaging and scheduling on) and bounds it. Raise a bound only for a real new
 * tool, and record the new figure where the tool is reviewed.
 */
// Measured 2026-11-05: 89 tools and 125,040 bytes before the legacy node tools
// and start_multi_review were removed, 82 tools and 115,114 bytes after.
// 2026-11-07: 85 tools and 118,361 bytes with the three ticket label tools.
// Two conversation mark tools added for the Actions panel.
// 2026-11-11: 93 tools and 124,994 bytes with the six Linear board tools
// (docs/architecture/tickets.md, "Linear"); their descriptions were trimmed to
// stay under the byte bound.
const MAX_TOOLS = 93;
const MAX_SCHEMA_BYTES = 125_000;

const harness = useControlMcpServerHarness();

test("a main coordinator's tool surface stays within its bound", async () => {
  const credential = harness.coordinatorCredential(coordinatorRoleCapabilities("main"));
  const listed = await rpc(credential.url, credential.token, "tools/list", {});
  const tools = (listed.body.result?.tools ?? []) as Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>;
  const sizes = tools
    .map((tool) => ({
      name: tool.name,
      bytes: Buffer.byteLength(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        "utf8",
      ),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  const total = sizes.reduce((sum, tool) => sum + tool.bytes, 0);
  // Printed so a change's effect on the surface can be read off the test log.
  process.stdout.write(
    `coordinator tool surface: ${tools.length} tools, ${total} bytes (~${Math.round(total / 4)} tokens); largest: ${sizes
      .slice(0, 8)
      .map((tool) => `${tool.name} ${tool.bytes}`)
      .join(", ")}\n`,
  );
  expect(tools.length).toBeGreaterThan(0);
  expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS);
  expect(total).toBeLessThanOrEqual(MAX_SCHEMA_BYTES);
});

test("retired tools are not offered, and a call to one names its replacement", async () => {
  const credential = harness.coordinatorCredential(coordinatorRoleCapabilities("main"));
  const listed = await rpc(credential.url, credential.token, "tools/list", {});
  const names = ((listed.body.result?.tools ?? []) as Array<{ name: string }>).map(
    (tool) => tool.name,
  );
  for (const [retired, replacement] of RETIRED_COORDINATOR_TOOLS) {
    expect(names).not.toContain(retired);
    // A saved schedule that names one is paused with this, not left failing.
    const called = await harness.server.callCoordinatorTool(
      {
        role: "coordinator",
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
        mailboxIncarnationId: "incarnation-1",
        capabilities: coordinatorRoleCapabilities("main"),
      },
      retired,
      {},
    );
    expect(called.isError).toBe(true);
    expect(called.text).toStartWith("capability-denied:");
    expect(called.text).toContain(`use ${replacement} instead`);
  }
});
