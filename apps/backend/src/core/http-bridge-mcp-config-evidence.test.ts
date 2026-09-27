/**
 * The `mcpConfig` a bridge reports beside its runtime health.
 *
 * The digests in it are unkeyed hashes of files that can hold secrets, so they
 * are read for the backend's MCP apply scheduler only and must never reach the
 * renderer-facing runtime summary.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { httpProvider } from "./agent-provider-test-support.js";
import { bridgeMcpConfigEvidence, bridgeRuntimeSummary } from "./http-bridge-runtime-health.js";

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("base64url")}`;
const USER = digest("user file");
const PROJECT = digest("project file");
const AT = "2026-09-24T10:00:00.000Z";

const claudeBody = {
  summary: {},
  notices: [],
  mcpConfig: {
    fingerprint: "opaque",
    scope: "all",
    sources: { user: USER, project: PROJECT },
    queryStartedAt: AT,
  },
};

describe("bridgeMcpConfigEvidence", () => {
  test("reads Claude's most recent query", () => {
    // Scope `all` also loaded the private-local map from the user file.
    expect(bridgeMcpConfigEvidence(claudeBody)).toEqual({
      sources: { user: USER, project: PROJECT, local: USER },
      observedAt: AT,
      scope: "session",
    });
    // A narrower scope read only the user map, so it proves nothing about local.
    expect(
      bridgeMcpConfigEvidence({
        mcpConfig: {
          ...claudeBody.mcpConfig,
          scope: "user",
          sources: { user: USER, project: "excluded" },
        },
      }),
    ).toEqual({ sources: { user: USER, project: "excluded" }, observedAt: AT, scope: "session" });
  });

  test("reads the generation Cursor and Pi built", () => {
    expect(
      bridgeMcpConfigEvidence({
        summary: { state: "attached" },
        mcpConfig: { fingerprint: "f", sources: { user: USER, project: "excluded" }, builtAt: AT },
      }),
    ).toEqual({ sources: { user: USER, project: "excluded" }, observedAt: AT, scope: "session" });
  });

  test("reads Grok's process-level load, and nothing before a child has reported", () => {
    expect(
      bridgeMcpConfigEvidence({
        mcpConfig: {
          inventoryScope: "process",
          loaded: { fingerprint: "f", sources: { user: USER, project: "absent" }, observedAt: AT },
          current: { fingerprint: "g", sources: { user: PROJECT, project: "absent" } },
          changedSinceLoad: true,
        },
      }),
    ).toEqual({ sources: { user: USER, project: "absent" }, observedAt: AT, scope: "process" });
    expect(
      bridgeMcpConfigEvidence({
        mcpConfig: {
          inventoryScope: "process",
          current: { fingerprint: "g", sources: { user: USER } },
        },
      }),
    ).toBeUndefined();
  });

  test("an older bridge, or anything malformed, is no evidence", () => {
    expect(bridgeMcpConfigEvidence({ summary: {}, notices: [] })).toBeUndefined();
    expect(bridgeMcpConfigEvidence(null)).toBeUndefined();
    expect(
      bridgeMcpConfigEvidence({
        mcpConfig: { sources: { user: USER }, queryStartedAt: "not a date" },
      }),
    ).toBeUndefined();
    expect(
      bridgeMcpConfigEvidence({
        mcpConfig: { sources: { user: "sha256:short", project: "md5:x" }, builtAt: AT },
      }),
    ).toBeUndefined();
    // A malformed slot is dropped, a well-formed one kept.
    expect(
      bridgeMcpConfigEvidence({
        mcpConfig: { sources: { user: USER, project: { nested: true } }, builtAt: AT },
      }),
    ).toEqual({ sources: { user: USER }, observedAt: AT, scope: "session" });
  });
});

describe("renderer-facing health never carries the digests", () => {
  test("the normalized summary drops mcpConfig", () => {
    const summary = bridgeRuntimeSummary(claudeBody);
    const text = JSON.stringify(summary);
    expect(text).not.toContain(USER.slice("sha256:".length));
    expect(text).not.toContain(PROJECT.slice("sha256:".length));
    expect(text).not.toContain("mcpConfig");
  });

  test("the provider reads evidence and health from the same no-touch route, keeping them apart", async () => {
    const { provider, requests } = httpProvider((url) =>
      url.endsWith("/runtime-health")
        ? Response.json({ ...claudeBody, summary: { state: "attached" } })
        : new Response("unexpected", { status: 500 }),
    );
    const health = await provider.runtimeHealth!("s-1");
    expect(health.summary).toEqual({ state: "attached" });
    expect(JSON.stringify(health)).not.toContain(USER.slice("sha256:".length));

    expect(await provider.mcpConfigEvidence!("s-1")).toEqual({
      sources: { user: USER, project: PROJECT, local: USER },
      observedAt: AT,
      scope: "session",
    });
    // Only the runtime-health route: never `/session/:id` or `/status`, which
    // refresh liveness, hydrate a transcript or re-attach.
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/session/s-1/runtime-health",
      "/session/s-1/runtime-health",
    ]);
  });

  test("a bridge that predates the route reports no evidence", async () => {
    const { provider } = httpProvider(() => new Response("not found", { status: 404 }));
    expect(await provider.mcpConfigEvidence!("s-1")).toBeUndefined();
  });
});
