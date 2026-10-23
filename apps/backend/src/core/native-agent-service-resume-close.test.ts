/**
 * A resume replaces the tab's provider session, and the session it replaced
 * is closed. A new agent tab is given an empty session before its resume
 * picker opens, so without the close every resume left one behind; on Grok,
 * an agent process holding an `ACP_MAX_SESSIONS` slot. The close follows tab
 * teardown's last-owner rules: a session another tab shares, or a Multi
 * Review owns, is left alone.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { BUILD_PIPELINE_AGENTS } from "@orkestrator/protocol/build-pipeline";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import {
  NativeAgentProviderSessionMissingError,
  type NativeAgentRuntimeProvider,
} from "./native-agent-service-shared.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import {
  createProviderStub,
  internals,
  withService,
} from "./native-agent-service-projection-test-support.js";
import {
  replacedSessionCloseIntent,
  withProviderSessionTeardownLock,
} from "./provider-session-ownership.js";

type Agent = (typeof BUILD_PIPELINE_AGENTS)[number];

function resumableStub(
  agent: Agent,
  resumedId = "provider-resumed",
  behaviour: Parameters<typeof createProviderStub>[1] = {},
) {
  const stub = createProviderStub(agent, behaviour);
  const resumeSession = mock(async (_sessionId: string) => resumedId);
  const closeSession = mock(async (_sessionId: string) => undefined);
  Object.assign(stub.provider as NativeAgentRuntimeProvider, { resumeSession, closeSession });
  return { provider: stub.provider, resumeSession, closeSession };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const tab = (agent: Agent, tabId = "tab-new") => ({
  environmentId: "env-1",
  agent,
  logicalSessionKey: `env-env-1:${tabId}`,
});

function reviewOwning(providerSessionId: string): MultiReviewWorkflow {
  return {
    version: MULTI_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "proj-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [{ id: "reviewer-1", agent: "claude", model: "opus", status: "pending" }],
    reviewSession: {
      agent: "codex",
      model: "gpt-6",
      sessionKey: "multi-review:multi-1:review",
      providerSessionId,
      requestIds: [],
      status: "running",
      startedAt: new Date(0).toISOString(),
    },
    fixModel: { agent: "codex", model: "gpt-6" },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    backendRevision: 1,
  };
}

afterEach(() => {
  mock.restore();
});

describe("resume closes the session it replaced", () => {
  for (const agent of BUILD_PIPELINE_AGENTS) {
    test(`${agent}: the new tab's empty session is closed once the resume is adopted`, async () => {
      const { provider, resumeSession, closeSession } = resumableStub(agent);
      await withService(
        { prefix: `orkestrator-resume-close-${agent}-`, provider: async () => provider },
        async ({ service, storage }) => {
          const identity = tab(agent);
          const created = await service.ensureSession(identity);
          expect(created.providerSessionId).toBe("provider-session");

          await expect(
            service.resumeProjectionSession({ ...identity, providerSessionId: "vendor-old" }),
          ).resolves.toMatchObject({ sessionId: "provider-resumed" });

          expect(resumeSession).toHaveBeenCalledTimes(1);
          expect(closeSession.mock.calls).toEqual([["provider-session"]]);
          const key = nativeAgentSessionStorageKey("env-1", agent, identity.logicalSessionKey);
          expect((await storage.getNativeAgentSession(key))?.providerSessionId).toBe(
            "provider-resumed",
          );
          // The close was journaled for replay, and cleared once it was confirmed.
          expect((await storage.getEnvironment("env-1"))?.tabTeardownIntents).toBeUndefined();
        },
      );
    });
  }

  test("a tab with no session yet has nothing to close", async () => {
    const { provider, closeSession } = resumableStub("grok");
    await withService(
      { prefix: "orkestrator-resume-close-unmapped-", provider: async () => provider },
      async ({ service }) => {
        await service.resumeProjectionSession({ ...tab("grok"), providerSessionId: "vendor-old" });
        expect(closeSession).not.toHaveBeenCalled();
      },
    );
  });

  test("resuming the session the tab already shows closes nothing", async () => {
    const { provider, closeSession } = resumableStub("grok", "provider-session");
    await withService(
      { prefix: "orkestrator-resume-close-in-place-", provider: async () => provider },
      async ({ service }) => {
        const identity = tab("grok");
        await service.ensureSession(identity);
        await service.resumeProjectionSession({ ...identity, providerSessionId: "vendor-old" });
        expect(closeSession).not.toHaveBeenCalled();
      },
    );
  });

  test("a session another tab still maps is left running", async () => {
    const { provider, closeSession } = resumableStub("grok");
    await withService(
      { prefix: "orkestrator-resume-close-shared-", provider: async () => provider },
      async ({ service }) => {
        const identity = tab("grok");
        await service.ensureSession(identity);
        await service.adoptSession({
          ...tab("grok", "tab-other"),
          providerSessionId: "provider-session",
        });
        await service.resumeProjectionSession({ ...identity, providerSessionId: "vendor-old" });
        expect(closeSession).not.toHaveBeenCalled();
      },
    );
  });

  for (const acquisition of ["adopt", "resume"] as const) {
    test(`${acquisition} waits for replacement cleanup's no-owner snapshot`, async () => {
      const snapshotRead = gate();
      const releaseSnapshot = gate();
      const acquisitionReady = gate();
      let live = true;
      const order: string[] = [];
      const { provider, resumeSession, closeSession } = resumableStub("grok", "provider-resumed", {
        status: async (id) => (id === "provider-session" && !live ? "missing" : "idle"),
        send: async (id) => {
          if (id === "provider-session" && !live) throw new Error("Session is closed");
          order.push(`send:${id}`);
        },
      });
      resumeSession.mockImplementation(async (id) => {
        order.push(`resume:${id}`);
        if (id === "provider-session") live = true;
        return id === "provider-session" ? id : "provider-resumed";
      });
      closeSession.mockImplementation(async (id) => {
        order.push(`close:${id}`);
        if (id === "provider-session") live = false;
      });
      await withService(
        {
          prefix: `orkestrator-resume-close-acquire-${acquisition}-`,
          provider: async () => provider,
        },
        async ({ service, storage }) => {
          const identity = tab("grok");
          const other = tab("grok", "tab-other");
          await service.ensureSession(identity);
          const listWorkflows = storage.listMultiReviewWorkflows.bind(storage);
          spyOn(storage, "listMultiReviewWorkflows").mockImplementation(async (environmentId) => {
            const workflows = await listWorkflows(environmentId);
            // The ownership helper has already captured an empty tab snapshot.
            snapshotRead.open();
            await releaseSnapshot.opened;
            return workflows;
          });
          const replacing = service.resumeProjectionSession({
            ...identity,
            providerSessionId: "vendor-old",
          });
          await snapshotRead.opened;
          const resolveProvider = internals(service).provider.bind(service);
          spyOn(internals(service), "provider").mockImplementation(async (input) => {
            const resolved = await resolveProvider(input);
            if (input.logicalSessionKey === other.logicalSessionKey) acquisitionReady.open();
            return resolved;
          });
          const status = spyOn(provider, "status");
          const input = { ...other, providerSessionId: "provider-session" };
          // Handle rejection immediately; a failed acquisition must not kill the backend.
          const acquiring = (
            acquisition === "adopt"
              ? service.adoptSession(input)
              : service.resumeProjectionSession(input)
          ).then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
          try {
            await acquisitionReady.opened;
            // Drain continuations after provider resolution. No elapsed-time race:
            // the snapshot gate remains closed until these assertions finish.
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(status).not.toHaveBeenCalledWith("provider-session");
            expect(resumeSession.mock.calls.map(([id]) => id)).toEqual(["vendor-old"]);
            const key = nativeAgentSessionStorageKey("env-1", "grok", other.logicalSessionKey);
            expect(await storage.getNativeAgentSession(key)).toBeNull();
          } finally {
            releaseSnapshot.open();
            await replacing;
          }
          const result = await acquiring;
          if (acquisition === "adopt") {
            expect(result.error).toBeInstanceOf(NativeAgentProviderSessionMissingError);
            // A direct adoption cannot resurrect a closed process. Resume it
            // after the close, then publish the new live owner.
            await service.resumeProjectionSession(input);
          } else {
            expect(result.error).toBeUndefined();
            expect(result.value).toMatchObject({ sessionId: "provider-session" });
          }
          expect(order.slice(0, 3)).toEqual([
            "resume:vendor-old",
            "close:provider-session",
            "resume:provider-session",
          ]);
          const key = nativeAgentSessionStorageKey("env-1", "grok", other.logicalSessionKey);
          expect((await storage.getNativeAgentSession(key))?.providerSessionId).toBe(
            "provider-session",
          );
          expect(await provider.status("provider-session")).toBe("idle");
          await service.dispatchPrompt({ ...other, prompt: "Continue", requestId: "after-close" });
          expect(order).toContain("send:provider-session");
          expect(closeSession.mock.calls).toEqual([["provider-session"]]);
        },
      );
    });
  }

  test("an adoption already publishing its mapping fences replacement cleanup", async () => {
    const publishing = gate();
    const releasePublication = gate();
    const refreshed = gate();
    const { provider, closeSession } = resumableStub("grok", "provider-resumed", {
      interactiveSnapshot: async (id) => {
        if (id === "provider-resumed") refreshed.open();
        return { status: "idle", messages: [] };
      },
    });
    await withService(
      { prefix: "orkestrator-resume-close-acquire-first-", provider: async () => provider },
      async ({ service, storage }) => {
        const identity = tab("grok");
        const other = tab("grok", "tab-other");
        await service.ensureSession(identity);
        const adopt = storage.adoptNativeAgentSession.bind(storage);
        spyOn(storage, "adoptNativeAgentSession").mockImplementation(async (input) => {
          if (input.logicalSessionKey === other.logicalSessionKey) {
            publishing.open();
            await releasePublication.opened;
          }
          return adopt(input);
        });
        const acquiring = service.adoptSession({ ...other, providerSessionId: "provider-session" });
        await publishing.opened;
        const replacing = service.resumeProjectionSession({
          ...identity,
          providerSessionId: "vendor-old",
        });
        try {
          await refreshed.opened;
          expect(closeSession).not.toHaveBeenCalled();
        } finally {
          releasePublication.open();
          await Promise.all([acquiring, replacing]);
        }
        expect(closeSession).not.toHaveBeenCalled();
        expect((await service.getProjection(other))?.sessionId).toBe("provider-session");
      },
    );
  });

  test("a resume whose reopened session closes before adoption reopens it again", async () => {
    const adopting = gate();
    const releaseAdoption = gate();
    let live = true;
    let reopened = false;
    const order: string[] = [];
    const { provider, resumeSession, closeSession } = resumableStub("grok", "provider-resumed", {
      status: async (id) => (id === "provider-session" && !live ? "missing" : "idle"),
    });
    resumeSession.mockImplementation(async (id) => {
      order.push(`resume:${id}`);
      if (id !== "provider-session") return "provider-resumed";
      live = true;
      reopened = true;
      return id;
    });
    closeSession.mockImplementation(async (id) => {
      order.push(`close:${id}`);
      if (id === "provider-session") live = false;
    });
    await withService(
      { prefix: "orkestrator-resume-close-reopen-", provider: async () => provider },
      async ({ service, storage }) => {
        const identity = tab("grok");
        const other = tab("grok", "tab-other");
        await service.ensureSession(identity);
        const resolveProvider = internals(service).provider.bind(service);
        let paused = false;
        spyOn(internals(service), "provider").mockImplementation(async (input) => {
          const resolved = await resolveProvider(input);
          // The other tab's adoption, after its reopen released the fence.
          if (input.logicalSessionKey === other.logicalSessionKey && reopened && !paused) {
            paused = true;
            adopting.open();
            await releaseAdoption.opened;
          }
          return resolved;
        });
        const acquiring = service.resumeProjectionSession({
          ...other,
          providerSessionId: "provider-session",
        });
        try {
          await adopting.opened;
          // The first tab resumes away and, seeing no other owner, closes it.
          await service.resumeProjectionSession({ ...identity, providerSessionId: "vendor-old" });
        } finally {
          releaseAdoption.open();
        }
        await expect(acquiring).resolves.toMatchObject({ sessionId: "provider-session" });
        expect(order).toEqual([
          "resume:provider-session",
          "resume:vendor-old",
          "close:provider-session",
          "resume:provider-session",
        ]);
        const key = nativeAgentSessionStorageKey("env-1", "grok", other.logicalSessionKey);
        expect((await storage.getNativeAgentSession(key))?.providerSessionId).toBe(
          "provider-session",
        );
        expect(await provider.status("provider-session")).toBe("idle");
      },
    );
  });

  test("a session a Multi Review owns is left to the workflow", async () => {
    const { provider, closeSession } = resumableStub("codex");
    await withService(
      { prefix: "orkestrator-resume-close-workflow-", provider: async () => provider },
      async ({ service, storage }) => {
        const identity = tab("codex");
        await service.ensureSession(identity);
        await storage.saveMultiReviewWorkflow(
          "multi-1",
          "env-1",
          1,
          reviewOwning("provider-session"),
        );
        await service.resumeProjectionSession({ ...identity, providerSessionId: "vendor-old" });
        expect(closeSession).not.toHaveBeenCalled();
      },
    );
  });

  test("a failed close does not fail the resume, and logs no session content", async () => {
    const { provider, closeSession } = resumableStub("grok");
    closeSession.mockImplementation(async () => {
      throw new Error("Grok close is pending: secret-session-detail");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    await withService(
      { prefix: "orkestrator-resume-close-failed-", provider: async () => provider },
      async ({ service, storage }) => {
        const identity = tab("grok");
        await service.ensureSession(identity);
        await expect(
          service.resumeProjectionSession({ ...identity, providerSessionId: "vendor-old" }),
        ).resolves.toMatchObject({ sessionId: "provider-resumed" });
        expect(closeSession).toHaveBeenCalledTimes(1);
        // Left for `reconcile_tab_teardowns` to replay.
        const expected = replacedSessionCloseIntent("grok", "provider-session");
        const intents = (await storage.getEnvironment("env-1"))?.tabTeardownIntents ?? {};
        expect(Object.values(intents)).toEqual([
          { ...expected, createdAt: expect.any(String) as unknown as string },
        ]);
        expect(warn).toHaveBeenCalledWith(
          "[native-agent] The grok session a resume replaced was not closed:",
          "Error",
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-session-detail");
      },
    );
  });

  test("a replaced session in an environment the journal cannot hold is still closed once", async () => {
    const { provider, closeSession } = resumableStub("grok");
    await withService(
      { prefix: "orkestrator-resume-close-unjournaled-", provider: async () => provider },
      async ({ service, storage }) => {
        const identity = tab("grok");
        await service.ensureSession(identity);
        spyOn(storage, "setTabTeardownIntent").mockImplementation(async () => {
          throw new Error("Environment not found: env-1");
        });
        const clear = spyOn(storage, "clearTabTeardownIntent");
        await service.resumeProjectionSession({ ...identity, providerSessionId: "vendor-old" });
        expect(closeSession.mock.calls).toEqual([["provider-session"]]);
        expect(clear).not.toHaveBeenCalled();
      },
    );
  });

  test("waits for a tab teardown of the same session, then sees its result", async () => {
    let releaseTeardown!: () => void;
    const teardownHeld = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    // The resume's close is already queued on the lock when the projection
    // refresh beside it reads the resumed session; only then does the other
    // tab's teardown finish.
    const { provider, closeSession } = resumableStub("grok", "provider-resumed", {
      interactiveSnapshot: async (sessionId) => {
        if (sessionId === "provider-resumed") releaseTeardown();
        return { status: "idle", messages: [] };
      },
    });
    await withService(
      { prefix: "orkestrator-resume-close-locked-", provider: async () => provider },
      async ({ service, storage }) => {
        const identity = tab("grok");
        const other = tab("grok", "tab-other");
        await service.ensureSession(identity);
        await service.adoptSession({ ...other, providerSessionId: "provider-session" });
        let teardownEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
          teardownEntered = resolve;
        });
        // The other tab's teardown holds the lock and sees this tab's mapping,
        // so it skips the provider close and only retires its own mapping.
        const teardown = withProviderSessionTeardownLock(
          storage,
          "env-1",
          "grok",
          "provider-session",
          async () => {
            teardownEntered();
            await teardownHeld;
            await storage.invalidateNativeAgentSession(
              nativeAgentSessionStorageKey("env-1", "grok", other.logicalSessionKey),
              "provider-session",
            );
          },
        );
        await entered;
        await service.resumeProjectionSession({ ...identity, providerSessionId: "vendor-old" });
        await teardown;
        // The resume checked after the teardown, found no other owner, and
        // closed the session exactly once.
        expect(closeSession.mock.calls).toEqual([["provider-session"]]);
      },
    );
  });
});
