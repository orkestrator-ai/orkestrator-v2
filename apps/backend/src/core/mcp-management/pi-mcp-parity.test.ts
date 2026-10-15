import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import type { McpManagementSnapshot } from "@orkestrator/protocol/mcp-management";

import { resolvePiMcpServers } from "../../../../../bridges/pi-bridge/src/mcp-config.js";
import {
  PI_MCP_CONFIG_FIXTURES,
  type PiMcpConfigFixture,
} from "../../../../../bridges/pi-bridge/src/testing/mcp-config-fixtures.js";
import { piSanitizedName } from "./codecs.js";
import { createFixture, targetIdFor, type Fixture } from "./test-support.js";

/**
 * The catalogue mirrors the Pi bridge's loader (`markPiLoadRules`,
 * `piEntryShape`, `piLaunchBlock`). This runs both over the fixtures the
 * bridge's own upstream test checks against Pi, so neither side can drift.
 */

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ env: {} });
});

afterEach(() => {
  fixture.cleanup();
});

/** Every session gets Orkestrator's own server, which takes one of the bridge's slots. */
const agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "parity-token" };

async function bridgeStarts(
  config: PiMcpConfigFixture,
  projectResources: boolean,
): Promise<string[]> {
  const agentDir = path.dirname(fixture.write("bridge/agent/mcp.json", "{}"));
  const cwd = path.dirname(path.dirname(fixture.write("bridge/project/.pi/mcp.json", "{}")));
  if (config.user !== undefined)
    fixture.write("bridge/agent/mcp.json", JSON.stringify(config.user));
  if (config.project !== undefined)
    fixture.write("bridge/project/.pi/mcp.json", JSON.stringify(config.project));
  const servers = await resolvePiMcpServers({
    agentDir,
    cwd,
    projectResources,
    agentMcp,
    env: config.env ?? {},
  });
  return servers
    .filter((server) => server.scope !== "orkestrator")
    .map((server) => `${server.scope}:${server.id}`)
    .sort();
}

/** The rows the catalogue reports as the server Pi uses for a name, and in use. */
function catalogueStarts(snapshot: McpManagementSnapshot): string[] {
  return snapshot.definitions
    .filter(
      (row) =>
        row.status === "effective" &&
        row.sourceId !== "pi:injected" &&
        snapshot.effective[row.name] === row.entryId,
    )
    .map((row) => `${row.sourceId.slice("pi:".length)}:${piSanitizedName(row.name)}`)
    .sort();
}

describe("the Pi catalogue starts exactly what the Pi bridge starts", () => {
  for (const config of PI_MCP_CONFIG_FIXTURES) {
    test(`container, project resources on: ${config.name}`, async () => {
      fixture.environment.environmentType = "containerized";
      fixture.environment.containerId = "container-1";
      if (config.user !== undefined)
        fixture.containerFiles.set("/home/node/.pi/agent/mcp.json", JSON.stringify(config.user));
      if (config.project !== undefined)
        fixture.containerFiles.set("/workspace/.pi/mcp.json", JSON.stringify(config.project));
      const snapshot = await fixture.service.snapshot({
        targetId: await targetIdFor(fixture, "pi", "environment"),
      });
      expect(catalogueStarts(snapshot)).toEqual(await bridgeStarts(config, true));
    });

    test(`host, project resources off: ${config.name}`, async () => {
      if (config.user !== undefined)
        fixture.write("home/.pi/agent/mcp.json", JSON.stringify(config.user));
      if (config.project !== undefined)
        fixture.write("worktree/.pi/mcp.json", JSON.stringify(config.project));
      const snapshot = await fixture.service.snapshot({
        targetId: await targetIdFor(fixture, "pi", "environment"),
      });
      expect(catalogueStarts(snapshot)).toEqual(await bridgeStarts(config, false));
    });
  }
});
