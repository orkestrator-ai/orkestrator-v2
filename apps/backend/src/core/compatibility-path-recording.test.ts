import { expect, mock, test } from "bun:test";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/node/progressive-transcript";
import { httpProvider } from "./agent-provider-test-support.js";
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { compatibilityPathUsage, type CompatibilityPathId } from "./compatibility-path-usage.js";

const count = (id: CompatibilityPathId) => compatibilityPathUsage.snapshot().paths[id]?.count ?? 0;

test("transcript fallback counts legacy messages reads, not current reads or missing sessions", async () => {
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
  // Both routes 404: the session is missing, which is no compatibility use.
  const missing = httpProvider(() => new Response(null, { status: 404 }));
  const snapshot = await (missing.provider as NativeAgentRuntimeProvider).transcriptSnapshot!(
    "session-1",
    options,
  );
  expect(snapshot).toMatchObject({ messages: [], complete: true });
  expect(count(id)).toBe(before + 1);
});

test("the local branch read and the upstream auto-merge setting count every call (to-do 8111)", async () => {
  const record = mock((_id: string) => undefined);
  const original = compatibilityPathUsage.record.bind(compatibilityPathUsage);
  compatibilityPathUsage.record = record as typeof compatibilityPathUsage.record;
  try {
    const registry = createCommandRegistry();
    // Any use of the fetch scheduler would mean the read went past path
    // validation, so touching it fails the test with its own message.
    const gitFetchScheduler = new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`git fetch scheduler used: ${String(property)}`);
        },
      },
    );
    const context = {
      runtime: { diffStats: { gitFetchScheduler } },
      storage: {
        getProject: async (id: string) => ({ id }),
        clientState: {
          getCoordinatorUpstreamAutoMerge: () => false,
          setCoordinatorUpstreamAutoMerge: (_id: string, enabled: boolean) => enabled,
        },
      },
    } as unknown as CommandContext;
    // Path validation refuses the read before any I/O; the count comes
    // first. The container read's count is asserted in
    // `tests/commands-io-coverage.test.ts`.
    await expect(
      (async () =>
        registry.get("read_local_file_at_branch")!(
          { worktreePath: "/nonexistent-worktree", filePath: "../outside.txt", branch: "main" },
          context,
        ))(),
    ).rejects.toThrow("Invalid filePath: parent directory traversal is not allowed");
    await expect(
      registry.get("get_coordinator_upstream_auto_merge")!({ projectId: "p1" }, context),
    ).resolves.toEqual({ enabled: false });
    await expect(
      registry.get("set_coordinator_upstream_auto_merge")!(
        { projectId: "p1", enabled: true },
        context,
      ),
    ).resolves.toEqual({ enabled: true });
    expect(record.mock.calls).toEqual([
      ["retired-command.read-file-at-branch"],
      ["retired-command.coordinator-upstream-auto-merge"],
      ["retired-command.coordinator-upstream-auto-merge"],
    ]);
  } finally {
    compatibilityPathUsage.record = original;
  }
});
