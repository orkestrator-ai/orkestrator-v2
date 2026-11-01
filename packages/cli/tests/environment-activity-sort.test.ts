import { afterEach, describe, expect, test } from "bun:test";
import { publicSuccessEnvelope } from "@orkestrator/protocol/public-api";
import type { PublicEnvironmentSummary } from "@orkestrator/protocol/public-api-resources";
import { sortEnvironmentsByActivity } from "../src/client/format.js";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function summary(
  id: string,
  state: string | null,
  lastActivityAt: string | null,
  hasUnreadWork = false,
): PublicEnvironmentSummary {
  return {
    id,
    projectId: "p",
    name: id,
    branch: id,
    environmentType: "local",
    status: "running",
    ready: true,
    setup: { phase: "ready", complete: true, overridden: false },
    lifecycle: { operation: null, error: null, deletionRequested: false },
    activity: { state, hasUnreadWork },
    pendingAgentLaunch: false,
    startupSession: null,
    workspacePath: null,
    base: { branch: null, commit: null },
    pr: { url: null, state: null },
    createdAt: "2026-10-21T00:00:00Z",
    lastActivityAt,
    settingsRevision: "r1",
  };
}

const ITEMS = [
  summary("idle-new", "idle", "2026-10-21T12:00:00Z"),
  summary("working", "working", "2026-10-21T10:00:00Z"),
  summary("unknown", "something-else", "2026-10-21T13:00:00Z"),
  summary("waiting", "waiting", "2026-10-21T09:00:00Z"),
  summary("unread", null, "2026-10-21T08:00:00Z", true),
];

describe("sortEnvironmentsByActivity", () => {
  test("applies the app's activity orders and keeps backend order for ties", () => {
    const ids = (order: "priority" | "newest" | "oldest") =>
      sortEnvironmentsByActivity(ITEMS, order).map(({ id }) => id);
    // An unrecognised state counts as idle.
    expect(ids("priority")).toEqual(["unread", "waiting", "working", "unknown", "idle-new"]);
    expect(ids("newest")).toEqual(["unknown", "idle-new", "working", "waiting", "unread"]);
    expect(ids("oldest")).toEqual(["unread", "waiting", "working", "idle-new", "unknown"]);
    const tied = [summary("b", "idle", null), summary("a", "idle", null)];
    expect(sortEnvironmentsByActivity(tied, "newest").map(({ id }) => id)).toEqual(["b", "a"]);
  });
});

describe("environment list --sort", () => {
  async function fixture(): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
    const box = await createSandbox();
    const gateway = await startFakeGateway((request) =>
      request.body.args.action === "environment.list"
        ? envelope(
            publicSuccessEnvelope("environment.list", {
              items: ITEMS,
              nextCursor: null,
            }),
          )
        : defaultResponder()(request),
    );
    cleanups.push(
      () => box.cleanup(),
      () => gateway.stop(),
    );
    const dataDir = await box.publishDescriptor(gateway);
    await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
    return { box, gateway };
  }

  test("orders the page client-side without changing the request", async () => {
    const { box, gateway } = await fixture();
    const run = await box.run(["environment", "list", "--sort", "priority", "--json"]);
    expect(run.code).toBe(0);
    const ids = JSON.parse(run.out).result.items.map(({ id }: { id: string }) => id);
    expect(ids).toEqual(["unread", "waiting", "working", "unknown", "idle-new"]);
    const request = gateway.requests.find(
      (candidate) => candidate.body.args.action === "environment.list",
    );
    expect(request?.body.args.input).not.toHaveProperty("sort");

    const unsorted = await box.run(["environment", "list", "--json"]);
    expect(JSON.parse(unsorted.out).result.items.map(({ id }: { id: string }) => id)).toEqual(
      ITEMS.map(({ id }) => id),
    );
  });

  test("rejects an unknown order before contacting the backend", async () => {
    const { box, gateway } = await fixture();
    const before = gateway.requests.length;
    const run = await box.run(["environment", "list", "--sort", "alphabetical", "--json"]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.out).error.code).toBe("invalid-input");
    expect(
      gateway.requests
        .slice(before)
        .some((request) => request.body.args.action === "environment.list"),
    ).toBe(false);
  });
});
