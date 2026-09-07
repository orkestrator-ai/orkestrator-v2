/**
 * Reading a bridge's `/session/:id/runtime-health`.
 *
 * Two body shapes reach this: the Codex bridge's own inventory, which predates
 * the shared contract, and the `{ summary, notices }` every other bridge
 * answers. Both are accepted so gaining drift reporting everywhere did not
 * require reshaping the one bridge that already had it.
 */
import { describe, expect, test } from "bun:test";
import { httpProvider } from "./agent-provider-test-support.js";
import { bridgeRuntimeSummary, snapshotNotices } from "./http-bridge-runtime-health.js";

describe("bridgeRuntimeSummary", () => {
  test("reads the shared shape every non-Codex bridge answers", () => {
    expect(
      bridgeRuntimeSummary({
        summary: {
          state: "attached",
          commands: 4,
          drift: { unknownEvents: 2, unknownKinds: ["odd"] },
        },
        notices: [{ message: "deprecated", severity: "warning", source: "provider" }],
      }),
    ).toEqual({
      state: "attached",
      commands: 4,
      drift: { unknownEvents: 2, unknownKinds: ["odd"] },
      notices: [{ message: "deprecated", severity: "warning", source: "provider" }],
    });
  });

  test("reads Codex's own inventory, including its differently-named drift", () => {
    // Codex reports drift as `protocol.unknownNotifications` plus the method
    // names, which predates the shared field.
    const summary = bridgeRuntimeSummary({
      engine: { state: "ready", codexVersion: "0.144.1" },
      mcp: [{ name: "a" }, { name: "b" }],
      skills: { data: [] },
      hooks: {},
      protocol: { unknownNotifications: 3, unknownMethods: ["codex/new"] },
      notices: [{ method: "warning", message: "Codex reported warning", detail: "x" }],
    })!;

    expect(summary).toMatchObject({
      state: "ready",
      version: "0.144.1",
      mcpServers: 2,
      drift: { unknownEvents: 3, unknownKinds: ["codex/new"] },
    });
    // Codex's diagnostics are the provider's own, and default to `warning`.
    expect(summary.notices?.[0]).toMatchObject({ severity: "warning", source: "provider" });
  });

  test("groups repeated Codex notices, which arrive one occurrence at a time", () => {
    const summary = bridgeRuntimeSummary({
      engine: {},
      notices: [
        { method: "warning", message: "same", detail: "first" },
        { method: "warning", message: "same", detail: "second" },
      ],
    })!;
    expect(summary.notices).toHaveLength(1);
    expect(summary.notices?.[0]?.count).toBe(2);
    expect(summary.notices?.[0]?.occurrences).toHaveLength(2);
  });

  test("preserves Codex notice severity while keeping both out of the tab", () => {
    const summary = bridgeRuntimeSummary({
      engine: {},
      notices: [
        {
          method: "mcpServer/startupStatus/updated",
          message: "Codex reported mcpServer startupStatus updated",
          severity: "info",
        },
        {
          method: "warning",
          message: "Codex reported warning",
          severity: "warning",
        },
      ],
    })!;

    expect(summary.notices?.map((notice) => notice.severity)).toEqual(["info", "warning"]);
    // Both are health-panel material: the tab only takes errors.
    expect(snapshotNotices({ transcriptTruncated: false, runtime: summary })).toEqual([]);
  });

  test("keeps lifecycle and failure occurrences in separate Codex groups", () => {
    const summary = bridgeRuntimeSummary({
      engine: {},
      notices: [
        {
          method: "mcpServer/startupStatus/updated",
          message: "Codex reported mcpServer startupStatus updated",
          severity: "error",
          receivedAt: "2026-09-07T10:00:00.000Z",
        },
        {
          method: "mcpServer/startupStatus/updated",
          message: "Codex reported mcpServer startupStatus updated",
          severity: "info",
          receivedAt: "2026-09-07T10:01:00.000Z",
        },
      ],
    })!;

    expect(summary.notices).toHaveLength(2);
    expect(summary.notices?.find((notice) => notice.severity === "error")).toMatchObject({
      severity: "error",
    });
    expect(snapshotNotices({ transcriptTruncated: false, runtime: summary })).toEqual([
      {
        kind: "advisory",
        message: "Codex reported mcpServer startupStatus updated",
        severity: "error",
        occurrenceId:
          "provider\u0000mcpServer/startupStatus/updated\u00002026-09-07T10:00:00.000Z\u00001",
      },
    ]);
  });

  test("a body that is not an object at all is no summary", () => {
    expect(bridgeRuntimeSummary(null)).toBeUndefined();
    expect(bridgeRuntimeSummary("health")).toBeUndefined();
  });

  test("a response from a different session route is not mistaken for legacy Codex health", () => {
    expect(bridgeRuntimeSummary({ status: "idle", runtime: { mcpServers: 3 } })).toBeUndefined();
  });

  test("Codex drift with no count is not invented from the method names", () => {
    expect(
      bridgeRuntimeSummary({ engine: {}, protocol: { unknownMethods: ["a", "b"] } })?.drift,
    ).toBeUndefined();
  });
});

describe("snapshotNotices", () => {
  test("promotes provider errors into the tab alongside the transport warning", () => {
    expect(
      snapshotNotices({
        transcriptTruncated: true,
        runtime: {
          notices: [
            { message: "inventory", severity: "info" },
            { message: "deprecated", severity: "warning" },
            { message: "broken", severity: "error" },
          ],
        },
      }),
    ).toEqual([
      {
        kind: "warning",
        message:
          "Earlier transcript content was omitted to stay within the 16 MiB transport limit.",
      },
      { kind: "advisory", message: "broken", severity: "error" },
    ]);
  });

  test("provider warnings stay in the health panel", () => {
    expect(
      snapshotNotices({
        transcriptTruncated: false,
        runtime: { notices: [{ message: "deprecated", severity: "warning" }] },
      }),
    ).toEqual([]);
  });

  test("a clean snapshot carries no notices at all", () => {
    expect(snapshotNotices({ transcriptTruncated: false })).toEqual([]);
  });
});

describe("HttpBridgeProvider.runtimeHealth", () => {
  test("feeds shared bridge health into the authoritative interactive snapshot", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      if (url.endsWith("/init")) {
        return Response.json({ initData: { mcpServers: [{}], plugins: [], slashCommands: [] } });
      }
      if (url.endsWith("/runtime-health")) {
        return Response.json({
          summary: { drift: { unknownEvents: 1, unknownKinds: ["future-event"] } },
          notices: [{ message: "deprecated", severity: "warning", source: "provider" }],
        });
      }
      return Response.json({ status: "idle" });
    });

    const snapshot = await provider.interactiveSnapshot!("s-1");
    expect(snapshot.runtime).toMatchObject({
      mcpServers: 1,
      drift: { unknownEvents: 1, unknownKinds: ["future-event"] },
      notices: [{ message: "deprecated", severity: "warning", source: "provider" }],
    });
    expect(requests.some(({ url }) => url.endsWith("/runtime-health"))).toBe(true);
  });

  test("reads the route and normalizes it", async () => {
    const { provider } = httpProvider((url) =>
      url.endsWith("/runtime-health")
        ? Response.json({ summary: { state: "attached" }, notices: [] })
        : Response.json({}),
    );

    expect(await provider.runtimeHealth!("s-1")).toEqual({
      summary: { state: "attached" },
      notices: [],
    });
  });

  test("answers empty for a bridge that predates the route", async () => {
    // A 404 here must never fail the environment: this hop cannot tell "older
    // bridge" from "gone session", and health is optional metadata either way.
    const { provider } = httpProvider(() => new Response("not found", { status: 404 }));
    expect(await provider.runtimeHealth!("s-1")).toEqual({ summary: {}, notices: [] });
  });

  test("answers empty when the read throws outright", async () => {
    const { provider } = httpProvider(() => {
      throw new Error("bridge down");
    });
    expect(await provider.runtimeHealth!("s-1")).toEqual({ summary: {}, notices: [] });
  });

  test("carries notices out beside the summary", async () => {
    const { provider } = httpProvider((url) =>
      url.endsWith("/runtime-health")
        ? Response.json({
            summary: {},
            notices: [{ message: "deprecated", severity: "warning", source: "provider" }],
          })
        : Response.json({}),
    );

    const health = await provider.runtimeHealth!("s-1");
    expect(health.notices).toEqual([
      { message: "deprecated", severity: "warning", source: "provider" },
    ]);
  });
});
