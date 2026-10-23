import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  isMultiReviewWorkflow,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import {
  RETAINING_CLOSE_SESSION_ID_PREFIX,
  fenceRetainingCloseSessionId,
  tabTeardownFailureKind,
  unfenceTabTeardownSessionId,
} from "@orkestrator/protocol/tab-teardown";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { StorageService } from "./storage.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import type { NativeAgentProvider } from "./models.js";
import { replacedSessionCloseIntent } from "./provider-session-ownership.js";

/**
 * Tab close retains conversation history on every platform. These cover the
 * backend half of that contract: which provider request tab teardown sends,
 * when the durable intent survives, and that an older bridge never gets a
 * destructive DELETE in place of the close route it does not have.
 */

type Call = { method: string; url: string; signal?: AbortSignal };
type Responder = (call: Call) => Response | Promise<Response>;
type ProviderClose = [environmentId: string, agent: string, providerSessionId: string];
type ProviderCloseResponder = (
  close: ProviderClose,
) => Promise<"closed" | "not-running" | "unsupported">;

async function withTeardown<T>(
  respond: Responder,
  run: (context: {
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
    storage: StorageService;
    calls: Call[];
    released: Array<[string, string, string]>;
    providerCloses: ProviderClose[];
    clock: { now: number };
  }) => Promise<T>,
  options: {
    deleteTimeoutMs?: number;
    closeTimeoutMs?: number;
    closeProvider?: ProviderCloseResponder;
  } = {},
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-tab-close-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "e1",
    name: "Env",
    projectId: "proj-1",
    status: "running",
    environmentType: "local",
    worktreePath: "/tmp/worktree",
    branch: "main",
    order: 0,
    containerId: null,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    networkAccessMode: "restricted",
    createdAt: new Date(0).toISOString(),
  } as Parameters<StorageService["addEnvironment"]>[0]);
  const calls: Call[] = [];
  const released: Array<[string, string, string]> = [];
  const providerCloses: ProviderClose[] = [];
  const clock = { now: 1_000_000 };
  const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      method: String(init?.method ?? "GET"),
      url: String(input),
      ...(init?.signal ? { signal: init.signal } : {}),
    };
    calls.push(call);
    return respond(call);
  });
  const commands = createCommandRegistry({
    tabTeardown: {
      peekBridge: async () => ({ port: 4000, authToken: "test-token" }),
      fetch: fetchImpl as unknown as typeof fetch,
      ...(options.deleteTimeoutMs ? { deleteTimeoutMs: options.deleteTimeoutMs } : {}),
      ...(options.closeTimeoutMs ? { closeTimeoutMs: options.closeTimeoutMs } : {}),
      now: () => clock.now,
    },
  });
  const context = {
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    emit: () => undefined,
    storage,
    nativeAgents: {
      releaseProviderSession: (environmentId: string, agent: string, sessionId: string) =>
        released.push([environmentId, agent, sessionId]),
      // OpenCode tab close goes through the provider (see the provider's own
      // close tests for abort, settlement and pending-request rejection).
      closeProviderSessionIfRunning: async (
        environmentId: string,
        agent: string,
        providerSessionId: string,
      ) => {
        const close: ProviderClose = [environmentId, agent, providerSessionId];
        providerCloses.push(close);
        return (options.closeProvider ?? (async () => "closed" as const))(close);
      },
    },
  } as unknown as CommandContext;
  const invoke = async (command: string, args: Record<string, unknown>) => {
    const handler = commands.get(command);
    if (!handler) throw new Error(`Command not registered: ${command}`);
    return await handler(args, context);
  };
  try {
    return await run({ invoke, storage, calls, released, providerCloses, clock });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function mapTab(
  storage: StorageService,
  agent: NativeAgentProvider,
  tabId: string,
  providerSessionId: string,
): Promise<string> {
  const logicalSessionKey = `env-e1:${tabId}`;
  const key = nativeAgentSessionStorageKey("e1", agent, logicalSessionKey);
  await storage.adoptNativeAgentSession({
    key,
    environmentId: "e1",
    agent,
    logicalSessionKey,
    providerSessionId,
    origin: "interactive-native",
    interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
  });
  return key;
}

const retained = () => Response.json({ closed: true, retained: true });

function ownedWorkflow(
  owner: "preparationSession" | "reviewSession" | "fixSession" | "reviewer",
): MultiReviewWorkflow {
  const session = {
    agent: "codex" as const,
    model: "gpt-6",
    sessionKey: `multi-review:multi-1:${owner}`,
    providerSessionId: "owned-session",
    requestIds: [],
    status: "running" as const,
    startedAt: new Date(0).toISOString(),
  };
  return {
    version: MULTI_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id: "multi-1",
    environmentId: "e1",
    projectId: "proj-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers:
      owner === "reviewer"
        ? [
            {
              id: "reviewer-1",
              agent: session.agent,
              model: session.model,
              providerSessionId: session.providerSessionId,
              status: "running",
              startedAt: session.startedAt,
            },
          ]
        : [{ id: "reviewer-1", agent: "claude", model: "opus", status: "pending" }],
    ...(owner === "reviewer" ? {} : { [owner]: session }),
    fixModel: { agent: "codex", model: "gpt-6" },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    backendRevision: 1,
  };
}

describe("tab close retains conversation history", () => {
  for (const owner of ["preparationSession", "reviewSession", "fixSession", "reviewer"] as const) {
    test(`closing an adopted ${owner} tab preserves its workflow owner`, async () => {
      await withTeardown(retained, async ({ invoke, storage, calls, released }) => {
        const workflow = ownedWorkflow(owner);
        expect(isMultiReviewWorkflow(workflow)).toBe(true);
        await storage.saveMultiReviewWorkflow(workflow.id, "e1", 1, workflow);
        // Adopted fix tabs use arbitrary interactive tab IDs, not just a workflow prefix.
        const tabId = "adopted-native-tab";
        const key = await mapTab(storage, "codex", tabId, "owned-session");
        await invoke("teardown_tab", { environmentId: "e1", tabId, kind: "codex-native" });
        expect(calls).toEqual([]);
        expect(released).toEqual([]);
        expect(await storage.getNativeAgentSession(key)).toBeNull();
        expect((await storage.getMultiReviewWorkflow(workflow.id))?.snapshot).toEqual(workflow);
        expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
      });
    });

    for (const reason of ["agent mismatch", "superseded session"] as const) {
      test(`closing a ${owner} tab with ${reason} closes the unowned session`, async () => {
        await withTeardown(retained, async ({ invoke, storage, calls, released }) => {
          const workflow = ownedWorkflow(owner);
          await storage.saveMultiReviewWorkflow(workflow.id, "e1", 1, workflow);
          const agent = reason === "agent mismatch" ? "claude" : "codex";
          const providerId = reason === "superseded session" ? "old-session" : "owned-session";
          const key = await mapTab(storage, agent, "old-tab", providerId);
          await invoke("teardown_tab", {
            environmentId: "e1",
            tabId: "old-tab",
            kind: `${agent}-native`,
          });
          expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
            ["POST", `/session/${providerId}/close`],
          ]);
          expect(released).toEqual([["e1", agent, providerId]]);
          expect(await storage.getNativeAgentSession(key)).toBeNull();
          expect((await storage.getMultiReviewWorkflow(workflow.id))?.snapshot).toEqual(workflow);
        });
      });
    }
  }

  test("a bridge close can finish after the legacy request budget", async () => {
    await withTeardown(
      async () => {
        await Bun.sleep(70);
        return retained();
      },
      async ({ invoke, storage }) => {
        const key = await mapTab(storage, "claude", "tab-slow", "claude-slow");
        await expect(
          invoke("teardown_tab", {
            environmentId: "e1",
            tabId: "tab-slow",
            kind: "claude-native",
          }),
        ).resolves.toEqual({ completed: true });
        expect(await storage.getNativeAgentSession(key)).toBeNull();
      },
      { deleteTimeoutMs: 20, closeTimeoutMs: 200 },
    );
  });

  test("closes every bridge platform through POST close and never DELETE", async () => {
    await withTeardown(retained, async ({ invoke, storage, calls, released }) => {
      for (const [agent, kind] of [
        ["claude", "claude-native"],
        ["codex", "codex-native"],
        ["cursor", "cursor-native"],
        ["grok", "grok-native"],
        ["pi", "pi-native"],
      ] as const) {
        const key = await mapTab(storage, agent, `tab-${agent}`, `${agent}-provider`);
        await expect(
          invoke("teardown_tab", { environmentId: "e1", tabId: `tab-${agent}`, kind }),
        ).resolves.toEqual({ completed: true });
        expect(await storage.getNativeAgentSession(key)).toBeNull();
      }
      expect(calls.map((call) => call.method)).toEqual(Array(5).fill("POST"));
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/session/claude-provider/close",
        "/session/codex-provider/close",
        "/session/cursor-provider/close",
        "/session/grok-provider/close",
        "/session/pi-provider/close",
      ]);
      expect(released.map(([, agent]) => agent)).toEqual([
        "claude",
        "codex",
        "cursor",
        "grok",
        "pi",
      ]);
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
    });
  });

  test("closes an OpenCode tab through the provider, never a raw request", async () => {
    await withTeardown(
      () => Response.json(true),
      async ({ invoke, storage, calls, providerCloses }) => {
        const key = await mapTab(storage, "opencode", "tab-oc", "oc-session");
        await invoke("teardown_tab", {
          environmentId: "e1",
          tabId: "tab-oc",
          kind: "opencode-native",
        });
        // The provider's close settles workflow ownership, restores reviewer
        // permissions and rejects pending requests; a raw abort skipped that.
        expect(providerCloses).toEqual([["e1", "opencode", "oc-session"]]);
        expect(calls).toEqual([]);
        expect(await storage.getNativeAgentSession(key)).toBeNull();
      },
    );
  });

  test("keeps the OpenCode intent when the provider close fails or no bridge runs", async () => {
    let outcome: "fail" | "not-running" | "closed" = "fail";
    await withTeardown(
      retained,
      async ({ invoke, storage, providerCloses }) => {
        const key = await mapTab(storage, "opencode", "tab-oc", "oc-session");
        await expect(
          invoke("teardown_tab", { environmentId: "e1", tabId: "tab-oc", kind: "opencode-native" }),
        ).rejects.toThrow("pending requests could not be rejected");
        expect(await storage.getNativeAgentSession(key)).not.toBeNull();
        expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toHaveProperty("tab-oc");

        outcome = "not-running";
        await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 0 });
        expect(await storage.getNativeAgentSession(key)).not.toBeNull();

        outcome = "closed";
        await expect(
          invoke("teardown_tab", { environmentId: "e1", tabId: "tab-oc", kind: "opencode-native" }),
        ).resolves.toEqual({ completed: true });
        expect(await storage.getNativeAgentSession(key)).toBeNull();
        expect(providerCloses).toHaveLength(3);
      },
      {
        closeProvider: async () => {
          if (outcome === "fail") {
            throw new Error("OpenCode pending requests could not be rejected");
          }
          return outcome;
        },
      },
    );
  });

  test("answers an unknown session in band and retires the mapping", async () => {
    await withTeardown(
      () => Response.json({ closed: true, missing: true }),
      async ({ invoke, storage }) => {
        const key = await mapTab(storage, "claude", "tab-gone", "gone-provider");
        await expect(
          invoke("teardown_tab", { environmentId: "e1", tabId: "tab-gone", kind: "claude-native" }),
        ).resolves.toEqual({ completed: true });
        expect(await storage.getNativeAgentSession(key)).toBeNull();
      },
    );
  });

  for (const status of [404, 405]) {
    test(`never falls back to DELETE when a Claude bridge answers ${status}`, async () => {
      await withTeardown(
        () => new Response("Not Found", { status }),
        async ({ invoke, storage, calls, released }) => {
          const key = await mapTab(storage, "claude", "tab-old", "claude-old");
          await expect(
            invoke("teardown_tab", {
              environmentId: "e1",
              tabId: "tab-old",
              kind: "claude-native",
            }),
          ).rejects.toThrow("predates non-destructive tab close");
          expect(calls.map((call) => call.method)).toEqual(["POST"]);
          expect(await storage.getNativeAgentSession(key)).not.toBeNull();
          expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toHaveProperty(
            "tab-old",
          );
          expect(released).toEqual([]);

          // Reconciliation keeps refusing rather than eventually deleting.
          await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 0 });
          expect(calls.some((call) => call.method === "DELETE")).toBe(false);
        },
      );
    });
  }

  test("uses the proven non-destructive legacy DELETE for an older Codex bridge", async () => {
    await withTeardown(
      (call) =>
        call.method === "POST"
          ? new Response("404 Not Found", { status: 404 })
          : Response.json({ status: "deleted" }),
      async ({ invoke, storage, calls }) => {
        const key = await mapTab(storage, "codex", "tab-codex", "codex-old");
        await invoke("teardown_tab", {
          environmentId: "e1",
          tabId: "tab-codex",
          kind: "codex-native",
        });
        expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
          ["POST", "/session/codex-old/close"],
          ["DELETE", "/session/codex-old"],
        ]);
        expect(await storage.getNativeAgentSession(key)).toBeNull();
      },
    );
  });

  test("keeps the intent and mapping on a pending close, then completes on retry", async () => {
    let pending = true;
    await withTeardown(
      () =>
        pending
          ? Response.json(
              { closed: false, pending: true, error: "Session close did not complete" },
              { status: 503 },
            )
          : retained(),
      async ({ invoke, storage }) => {
        const key = await mapTab(storage, "pi", "tab-pi", "pi-running");
        await expect(
          invoke("teardown_tab", { environmentId: "e1", tabId: "tab-pi", kind: "pi-native" }),
        ).rejects.toThrow("Session close did not complete");
        expect(await storage.getNativeAgentSession(key)).not.toBeNull();
        expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toHaveProperty("tab-pi");

        pending = false;
        await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
        expect(await storage.getNativeAgentSession(key)).toBeNull();
        expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
      },
    );
  });

  test("retries a close whose response was lost and accepts the in-band confirmation", async () => {
    let attempts = 0;
    await withTeardown(
      (call) => {
        attempts += 1;
        // The bridge closed the session but the answer never arrived. Settle
        // when teardown aborts the request so nothing outlives the test.
        if (attempts === 1) {
          return new Promise<Response>((_resolve, reject) => {
            call.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted.", "AbortError")),
              { once: true },
            );
          });
        }
        return Response.json({ closed: true, missing: true });
      },
      async ({ invoke, storage }) => {
        const key = await mapTab(storage, "claude", "tab-lost", "claude-lost");
        await expect(
          invoke("teardown_tab", { environmentId: "e1", tabId: "tab-lost", kind: "claude-native" }),
        ).rejects.toThrow("timed out");
        expect(await storage.getNativeAgentSession(key)).not.toBeNull();
        await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
        expect(await storage.getNativeAgentSession(key)).toBeNull();
      },
      { deleteTimeoutMs: 20, closeTimeoutMs: 20 },
    );
  });

  test("closing one of two tabs sharing a provider session leaves the other untouched", async () => {
    await withTeardown(retained, async ({ invoke, storage, calls, released, providerCloses }) => {
      const first = await mapTab(storage, "opencode", "tab-a", "shared-session");
      const second = await mapTab(storage, "opencode", "tab-b", "shared-session");

      await invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "tab-a",
        kind: "opencode-native",
      });
      // No close and no in-memory release: tab-b may still be running a turn.
      expect(providerCloses).toEqual([]);
      expect(calls).toEqual([]);
      expect(released).toEqual([]);
      expect(await storage.getNativeAgentSession(first)).toBeNull();
      expect(await storage.getNativeAgentSession(second)).not.toBeNull();

      await invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "tab-b",
        kind: "opencode-native",
      });
      expect(providerCloses).toEqual([["e1", "opencode", "shared-session"]]);
      expect(calls).toEqual([]);
      expect(await storage.getNativeAgentSession(second)).toBeNull();
    });
  });

  test("closing a tab opened on a Multi Review session leaves it to the workflow", async () => {
    await withTeardown(retained, async ({ invoke, storage, calls, released }) => {
      const workflow = {
        version: MULTI_REVIEW_WORKFLOW_VERSION,
        controller: "backend",
        id: "multi-1",
        environmentId: "e1",
        projectId: "proj-1",
        targetBranch: "main",
        phase: "preparing",
        reviewers: [{ id: "reviewer-1", agent: "claude", model: "opus", status: "pending" }],
        fixModel: { agent: "codex", model: "gpt-5.6" },
        reviewSession: {
          agent: "claude",
          model: "opus",
          sessionKey: "multi-review:multi-1:review",
          providerSessionId: "review-session",
          requestIds: [],
          status: "running",
          startedAt: new Date(0).toISOString(),
        },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        backendRevision: 1,
      };
      expect(isMultiReviewWorkflow(workflow)).toBe(true);
      await storage.saveMultiReviewWorkflow("multi-1", "e1", 1, workflow);
      const tab = await mapTab(storage, "claude", "multi-review-review:multi-1", "review-session");

      await invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "multi-review-review:multi-1",
        kind: "claude-native",
      });
      // The supervisor's turn keeps running; only the tab's mapping goes.
      expect(calls).toEqual([]);
      expect(released).toEqual([]);
      expect(await storage.getNativeAgentSession(tab)).toBeNull();

      // Once the Multi Review is closed, nothing owns the session any more.
      await storage.deleteMultiReviewWorkflow("multi-1");
      await mapTab(storage, "claude", "multi-review-review:multi-1", "review-session");
      await invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "multi-review-review:multi-1",
        kind: "claude-native",
      });
      expect(calls.map((call) => call.method)).toEqual(["POST"]);
      expect(released).toEqual([["e1", "claude", "review-session"]]);
    });
  });

  test("fences new native intents and replays pre-upgrade intents non-destructively", async () => {
    await withTeardown(
      (call) =>
        call.method === "DELETE"
          ? Response.json({ status: "deleted" })
          : Response.json(
              { closed: false, pending: true, error: "Session close did not complete" },
              { status: 503 },
            ),
      async ({ invoke, storage, calls }) => {
        await mapTab(storage, "claude", "tab-new", "claude-new");
        await expect(
          invoke("teardown_tab", {
            environmentId: "e1",
            tabId: "tab-new",
            kind: "claude-native",
            sessionId: "claude-new",
          }),
        ).rejects.toThrow();
        const stored = (await storage.getEnvironment("e1"))?.tabTeardownIntents?.["tab-new"];
        // An older backend compares this id with the mapping and refuses the
        // intent, so a downgrade cannot replay it as a destructive DELETE.
        expect(stored?.sessionId).toBe(`${RETAINING_CLOSE_SESSION_ID_PREFIX}claude-new`);
        expect(stored?.sessionId).not.toBe("claude-new");

        // An intent written before the upgrade carries the bare id. It is
        // replayed with the close route, never the DELETE its writer used.
        await mapTab(storage, "claude", "tab-old", "claude-old");
        await storage.setTabTeardownIntent("e1", {
          tabId: "tab-old",
          kind: "claude-native",
          sessionId: "claude-old",
          createdAt: "2026-09-01T00:00:00.000Z",
        });
        await invoke("reconcile_tab_teardowns", {});
        expect(calls.some((call) => call.method === "DELETE")).toBe(false);
        expect(
          calls.filter((call) => new URL(call.url).pathname === "/session/claude-old/close"),
        ).toHaveLength(1);
      },
    );
  });
});

describe("tab close concurrency and retry", () => {
  test("two tabs sharing a session closed together: the last owner performs the close", async () => {
    let releaseResponses!: () => void;
    const responsesReleased = new Promise<void>((resolve) => {
      releaseResponses = resolve;
    });
    await withTeardown(
      async () => {
        await responsesReleased;
        return retained();
      },
      async ({ invoke, storage, calls, released }) => {
        const first = await mapTab(storage, "claude", "tab-a", "shared-session");
        const second = await mapTab(storage, "claude", "tab-b", "shared-session");
        const closing = Promise.all(
          ["tab-a", "tab-b"].map((tabId) =>
            invoke("teardown_tab", { environmentId: "e1", tabId, kind: "claude-native" }),
          ),
        );
        releaseResponses();
        await expect(closing).resolves.toEqual([{ completed: true }, { completed: true }]);
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
          "/session/shared-session/close",
        ]);
        expect(released).toEqual([["e1", "claude", "shared-session"]]);
        expect(await storage.getNativeAgentSession(first)).toBeNull();
        expect(await storage.getNativeAgentSession(second)).toBeNull();
        expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
      },
    );
  });

  test("reconcile at concurrency 4 closes each shared provider session exactly once", async () => {
    await withTeardown(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return retained();
      },
      async ({ invoke, storage, calls, providerCloses }) => {
        const tabs = [
          ["tab-1", "codex", "shared-a"],
          ["tab-2", "codex", "shared-a"],
          ["tab-3", "codex", "shared-b"],
          ["tab-4", "codex", "shared-b"],
          ["tab-5", "codex", "shared-b"],
          ["tab-6", "codex", "solo"],
          ["tab-7", "opencode", "oc-shared"],
          ["tab-8", "opencode", "oc-shared"],
        ] as const;
        for (const [tabId, agent, providerSessionId] of tabs) {
          await mapTab(storage, agent, tabId, providerSessionId);
          await storage.setTabTeardownIntent("e1", {
            tabId,
            kind: `${agent}-native`,
            sessionId: fenceRetainingCloseSessionId(providerSessionId),
            createdAt: "2026-09-26T00:00:00.000Z",
          });
        }
        await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({
          completed: tabs.length,
        });
        expect(calls.map((call) => new URL(call.url).pathname).sort()).toEqual([
          "/session/shared-a/close",
          "/session/shared-b/close",
          "/session/solo/close",
        ]);
        expect(providerCloses).toEqual([["e1", "opencode", "oc-shared"]]);
        expect(await storage.listNativeAgentSessions()).toEqual([]);
        expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
      },
    );
  });

  test("marks an old Claude bridge failure so the renderer can show the restart notice", async () => {
    await withTeardown(
      () => new Response("Not Found", { status: 404 }),
      async ({ invoke, storage }) => {
        await mapTab(storage, "claude", "tab-old", "claude-old");
        const failure = await invoke("teardown_tab", {
          environmentId: "e1",
          tabId: "tab-old",
          kind: "claude-native",
        }).catch((error: unknown) => error);
        expect(tabTeardownFailureKind(failure)).toBe("bridge-upgrade-required");
        // A generic pending close is not that notice.
        expect(tabTeardownFailureKind(new Error("Session close is not confirmed"))).toBeNull();
      },
    );
  });

  test("the periodic sweep backs off a failing intent and completes it once the bridge closes", async () => {
    let pending = true;
    await withTeardown(
      () =>
        pending
          ? Response.json(
              { closed: false, pending: true, error: "Session close did not complete" },
              { status: 503 },
            )
          : retained(),
      async ({ invoke, storage, calls, clock }) => {
        const key = await mapTab(storage, "pi", "tab-pi", "pi-running");
        await expect(
          invoke("teardown_tab", { environmentId: "e1", tabId: "tab-pi", kind: "pi-native" }),
        ).rejects.toThrow();
        const attempts = () => calls.length;
        expect(attempts()).toBe(1);

        // Each sweep failure doubles the wait: 30 s, then 60 s.
        await invoke("reconcile_tab_teardowns", {});
        expect(attempts()).toBe(2);
        await invoke("reconcile_tab_teardowns", {});
        expect(attempts()).toBe(2);
        clock.now += 30_000;
        await invoke("reconcile_tab_teardowns", {});
        expect(attempts()).toBe(3);
        clock.now += 30_000;
        await invoke("reconcile_tab_teardowns", {});
        expect(attempts()).toBe(3);
        clock.now += 30_000;
        pending = false;
        await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
        expect(attempts()).toBe(4);
        expect(await storage.getNativeAgentSession(key)).toBeNull();
        expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
      },
    );
  });
});

describe("replaying the close of a session a resume replaced", () => {
  test("a pending replaced-session close is retried until the bridge confirms it", async () => {
    let pending = true;
    await withTeardown(
      () =>
        pending
          ? Response.json(
              { closed: false, pending: true, error: "Session close did not complete" },
              { status: 503 },
            )
          : retained(),
      async ({ invoke, storage, calls, released, clock }) => {
        const intent = replacedSessionCloseIntent("grok", "acp-session:replaced");
        await storage.setTabTeardownIntent("e1", intent);

        await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 0 });
        expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toHaveProperty(
          intent.tabId,
        );
        expect(released).toEqual([]);

        pending = false;
        clock.now += 30_000;
        await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
        const closePath = `/session/${encodeURIComponent("acp-session:replaced")}/close`;
        expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
          `POST ${closePath}`,
          `POST ${closePath}`,
        ]);
        expect(released).toEqual([["e1", "grok", "acp-session:replaced"]]);
        expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
      },
    );
  });

  test("closes the replaced session once, never with DELETE, and clears the intent", async () => {
    await withTeardown(retained, async ({ invoke, storage, calls, released }) => {
      const intent = replacedSessionCloseIntent("pi", "/sessions/2026_abc.jsonl");
      await storage.setTabTeardownIntent("e1", intent);

      await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
      expect(calls.map((call) => call.method)).toEqual(["POST"]);
      expect(released).toEqual([["e1", "pi", "/sessions/2026_abc.jsonl"]]);
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
    });
  });

  test("leaves a replaced session another tab resumed again to that tab", async () => {
    await withTeardown(retained, async ({ invoke, storage, calls }) => {
      await mapTab(storage, "codex", "tab-again", "codex-replaced");
      await storage.setTabTeardownIntent(
        "e1",
        replacedSessionCloseIntent("codex", "codex-replaced"),
      );

      await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
      expect(calls).toEqual([]);
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
    });
  });

  test("closes a replaced OpenCode session through the provider", async () => {
    await withTeardown(retained, async ({ invoke, storage, calls, providerCloses }) => {
      await storage.setTabTeardownIntent("e1", replacedSessionCloseIntent("opencode", "ses_old"));

      await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
      expect(providerCloses).toEqual([["e1", "opencode", "ses_old"]]);
      expect(calls).toEqual([]);
    });
  });

  test("no caller can name a replaced-session key through teardown_tab", async () => {
    await withTeardown(retained, async ({ invoke, storage, calls }) => {
      const { tabId } = replacedSessionCloseIntent("grok", "someone-elses-session");
      await expect(
        invoke("teardown_tab", {
          environmentId: "e1",
          tabId,
          kind: "grok-native",
          sessionId: "someone-elses-session",
        }),
      ).rejects.toThrow("tabId is reserved");
      expect(calls).toEqual([]);
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
    });
  });

  test("one key per replaced session, carrying no session content", () => {
    const first = replacedSessionCloseIntent("pi", "/home/me/.pi/sessions/2026_secret.jsonl", "a");
    const again = replacedSessionCloseIntent("pi", "/home/me/.pi/sessions/2026_secret.jsonl", "b");
    expect(again.tabId).toBe(first.tabId);
    expect(first.tabId).not.toContain("secret");
    expect(
      replacedSessionCloseIntent("grok", "/home/me/.pi/sessions/2026_secret.jsonl", "a").tabId,
    ).not.toBe(first.tabId);
    expect(unfenceTabTeardownSessionId(first.sessionId).sessionId).toBe(
      "/home/me/.pi/sessions/2026_secret.jsonl",
    );
  });
});

describe("teardown intent session-id fence", () => {
  test("round-trips fenced, empty and legacy ids", () => {
    expect(unfenceTabTeardownSessionId(fenceRetainingCloseSessionId("abc"))).toEqual({
      sessionId: "abc",
      retainingClose: true,
    });
    expect(unfenceTabTeardownSessionId(fenceRetainingCloseSessionId(undefined))).toEqual({
      retainingClose: true,
    });
    expect(unfenceTabTeardownSessionId("legacy-id")).toEqual({
      sessionId: "legacy-id",
      retainingClose: false,
    });
    expect(unfenceTabTeardownSessionId(undefined)).toEqual({ retainingClose: false });
  });
});
