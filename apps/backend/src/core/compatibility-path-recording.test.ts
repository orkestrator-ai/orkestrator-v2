import { expect, test } from "bun:test";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/node/progressive-transcript";
import { codexConnection, httpProvider } from "./agent-provider-test-support.js";
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import { closeBridgeSessionRetaining } from "./bridge-session-close.js";
import { compatibilityPathUsage, type CompatibilityPathId } from "./compatibility-path-usage.js";
import { bridgeReportsMcpConfig } from "./http-bridge-runtime-health.js";
import { olderBridgeOutcome } from "./mcp-management/evidence.js";

const count = (id: CompatibilityPathId) => compatibilityPathUsage.snapshot().paths[id]?.count ?? 0;

test("catalogue fallback counts the legacy read and leaves current reads uncounted", async () => {
  const id = "slash-catalogue.legacy-route";
  const before = count(id);
  const current = httpProvider(() =>
    Response.json({ catalogueVersion: 1, status: "ready", commands: [] }),
  );
  await current.provider.commandCatalogue!("session-1");
  expect(count(id)).toBe(before);
  const legacy = httpProvider(
    (url) =>
      url.includes("/session/")
        ? new Response(null, { status: 404 })
        : Response.json({ commands: [] }),
    codexConnection,
  );
  await legacy.provider.commandCatalogue!("session-1");
  expect(count(id)).toBe(before + 1);
});

test("retaining close only counts the legacy branch it takes", async () => {
  const legacy = count("bridge-close.legacy-delete");
  const upgrade = count("bridge-close.upgrade-required");
  await closeBridgeSessionRetaining("claude", "s1", async () =>
    Response.json({ closed: true, retained: true }),
  );
  expect(count("bridge-close.legacy-delete")).toBe(legacy);
  expect(count("bridge-close.upgrade-required")).toBe(upgrade);
  await expect(
    closeBridgeSessionRetaining("claude", "s1", async () => new Response(null, { status: 404 })),
  ).rejects.toThrow("predates non-destructive tab close");
  expect(count("bridge-close.upgrade-required")).toBe(upgrade + 1);
  expect(count("bridge-close.legacy-delete")).toBe(legacy);
});

test("MCP counters distinguish marked reports and older bridge decisions", () => {
  const unmarked = count("mcp-report.unmarked-config");
  const older = count("mcp-report.older-bridge-outcome");
  expect(bridgeReportsMcpConfig({ mcpConfigReporting: 1, mcpConfig: {} })).toBe(true);
  expect(bridgeReportsMcpConfig({})).toBe(false);
  expect(count("mcp-report.unmarked-config")).toBe(unmarked);
  expect(count("mcp-report.older-bridge-outcome")).toBe(older);
  expect(bridgeReportsMcpConfig({ mcpConfig: {} })).toBe(true);
  expect(count("mcp-report.unmarked-config")).toBe(unmarked + 1);
  expect(olderBridgeOutcome("claude").state).toBe("pending-next-turn");
  expect(count("mcp-report.older-bridge-outcome")).toBe(older + 1);
});

test("transcript fallback counts legacy messages reads but not current transcript reads", async () => {
  const id = "bridge-transcript.messages-fallback";
  const before = count(id);
  const options = { limit: 10, targetBytes: 1024 };
  const current = httpProvider(() =>
    Response.json(
      bridgeTranscriptUpdate([], {
        ...options,
        sessionIdentity: "session-1",
        generation: 1,
        contentEpoch: 1,
        revision: 1,
        complete: true,
      }),
    ),
  );
  await (current.provider as NativeAgentRuntimeProvider).transcriptSnapshot!("session-1", options);
  expect(count(id)).toBe(before);
  const legacy = httpProvider((url) =>
    new URL(url).pathname.endsWith("/transcript")
      ? new Response(null, { status: 404 })
      : Response.json({ messages: [] }),
  );
  await (legacy.provider as NativeAgentRuntimeProvider).transcriptSnapshot!("session-1", options);
  expect(count(id)).toBe(before + 1);
});
