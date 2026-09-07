/**
 * Authoritative projection state: connection grace, composer capabilities,
 * execution profiles, the bounded read cache, and resume.
 */
import { describe, expect, mock, test } from "bun:test";

import { BUILD_PIPELINE_AGENTS } from "@orkestrator/protocol/build-pipeline";

import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";

import {
  ProviderSessionFailedError,
  ProviderUnavailableError,
  type NativeAgentRuntimeProvider,
  type ProviderInteractiveSnapshot,
  type ProviderStatus,
} from "./native-agent-provider.js";

import {
  NATIVE_MISSING_SESSION_GRACE_MS,
  NATIVE_PROJECTION_CACHE_LIMIT,
  nativeAgentSessionStorageKey,
} from "./native-agent-service.js";

import {
  createProviderStub,
  internals,
  waitForCondition,
  withService,
  type Invoke,
} from "./native-agent-service-projection-test-support.js";

describe("NativeAgentService", () => {
  test("projects sign-in metadata without blocking a new unauthenticated session", async () => {
    const stub = createProviderStub("cursor", {
      authStatus: async () => ({
        state: "signed-out",
        signIn: { kind: "browser-url" },
        signOut: false,
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-auth-bootstrap-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-auth-bootstrap",
        };
        await expect(service.ensureSession(identity)).resolves.toMatchObject({
          providerSessionId: "provider-session",
        });
        await expect(service.getProjection(identity)).resolves.toMatchObject({
          auth: { state: "signed-out", signIn: { kind: "browser-url" } },
        });
      },
    );
  });

  test("caches authentication discovery across projection refreshes", async () => {
    const stub = createProviderStub("cursor", {
      authStatus: async () => ({ state: "signed-in", signOut: true }),
    });
    await withService(
      {
        prefix: "orkestrator-native-auth-cache-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-auth-cache",
        };
        await service.ensureSession(identity);
        await service.getProjection(identity);
        await service.getProjection(identity);
        expect(stub.authStatus).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("replaces a Claude placeholder with the first user prompt title", async () => {
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({
        status: "idle",
        title: "Session a1b2c3",
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Implement durable session titles",
            parts: [{ type: "text", content: "Implement durable session titles" }],
            createdAt: "2026-09-07T10:00:00.000Z",
          },
        ],
      }),
      setSessionTitle: async () => undefined,
    });
    await withService(
      {
        prefix: "orkestrator-native-claude-title-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:tab-title",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.title).toBe("Implement durable session titles");
        await waitForCondition(() => stub.setSessionTitle?.mock.calls.length === 1);
        expect(stub.setSessionTitle).toHaveBeenCalledWith(
          "provider-session",
          "Implement durable session titles",
        );
      },
    );
  });

  test("combines provider-owned follow-ups with the durable backend queue", async () => {
    const stub = createProviderStub("pi", {
      interactiveSnapshot: async () => ({
        status: "running",
        messages: [],
        providerQueue: { items: [{ id: "pi-1", text: "Pi follow-up", mode: "follow-up" }] },
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-provider-queue-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "pi" as const,
          logicalSessionKey: "env-env-1:tab-provider-queue",
        };
        await service.ensureSession(identity);
        await storage.savePromptQueue(`pi\0${identity.logicalSessionKey}`, "env-1", [
          { id: "backend-1", text: "Backend queue", planModeEnabled: false },
        ]);

        expect((await service.getProjection(identity))?.queue?.items).toEqual([
          { id: "pi-1", text: "Pi follow-up", mode: "follow-up" },
          expect.objectContaining({ id: "backend-1", text: "Backend queue" }),
        ]);
      },
    );
  });

  test("uses the provider's raw OpenCode catalogue for durable cache refreshes", async () => {
    const filtered = [{ platform: "opencode" as const, id: "opencode/a", label: "A" }];
    const raw = [...filtered, { platform: "opencode" as const, id: "openrouter/b", label: "B" }];
    const stub = createProviderStub("opencode", {
      modelCatalog: async () => filtered,
      rawModelCatalog: async () => raw,
    });
    await withService(
      {
        prefix: "orkestrator-native-catalog-cache-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        await expect(
          service.listModelCatalogForCache({
            environmentId: "env-1",
            agent: "opencode",
            logicalSessionKey: "model-catalog:env-1",
          }),
        ).resolves.toEqual(raw);
        expect(stub.rawModelCatalog).toHaveBeenCalledTimes(1);
        expect(stub.modelCatalog).not.toHaveBeenCalled();
      },
    );
  });

  test("projects authoritative interactive state with stable revisions and inactive refresh", async () => {
    let now = 10_000;
    let providerRevision = 4;
    let status: ProviderStatus = "idle";
    const interactiveSnapshot = async (): Promise<ProviderInteractiveSnapshot> => ({
      status,
      providerRevision,
      title: "Projected session",
      shareUrl: "https://share.example/session",
      controls: { mode: "plan" },
      readiness: {
        state: "authentication-required",
        message: "Cursor is not signed in.",
      },
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "Ready",
          parts: [{ type: "text", text: "Ready" }],
          createdAt: "2026-08-14T10:00:00.000Z",
        },
      ],
      composer: {
        models: [{ platform: "cursor", id: "cursor/default", label: "Default" }],
        selectedModelId: "cursor/default",
        fastModeEnabled: false,
        fastModeAvailable: true,
        selectedModeId: "build",
        modes: [
          { id: "build", label: "Build" },
          { id: "plan", label: "Plan" },
        ],
      },
    });
    const stub = createProviderStub("cursor", { interactiveSnapshot });
    await withService(
      {
        prefix: "orkestrator-native-projection-",
        provider: async () => stub.provider,
        now: () => now,
      },
      async ({ service }) => {
        await service.ensureSession({
          environmentId: "env-1",
          agent: "cursor",
          logicalSessionKey: "env-env-1:tab-1",
          sessionMode: "build",
        });

        const first = await service.getProjection({
          environmentId: "env-1",
          agent: "cursor",
          logicalSessionKey: "env-env-1:tab-1",
        });
        expect(first).toMatchObject({
          platform: "cursor",
          connection: "connected",
          turn: { phase: "idle" },
          revision: 1,
          generation: "in-process:cursor",
          title: "Projected session",
          shareUrl: "https://share.example/session",
          cursor: "in-process:cursor:1",
          messages: [{ id: "message-1", content: "Ready" }],
          composer: { selectedModelId: "cursor/default", selectedModeId: "plan" },
          readiness: {
            state: "authentication-required",
            message: "Cursor is not signed in.",
          },
        });
        expect(first?.composerControls.map((control) => control.id)).toEqual([
          "model",
          "speed",
          "mode",
        ]);

        const unchanged = await service.getProjection({
          environmentId: "env-1",
          agent: "cursor",
          logicalSessionKey: "env-env-1:tab-1",
        });
        expect(unchanged).toBe(first);

        status = "running";
        providerRevision = 5;
        now += 2_000;
        const refreshed = await service.getProjection({
          environmentId: "env-1",
          agent: "cursor",
          logicalSessionKey: "env-env-1:tab-1",
        });
        expect(refreshed).toMatchObject({
          turn: { phase: "running" },
          revision: 2,
          cursor: "in-process:cursor:2",
        });
        expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(3);
      },
    );
  });

  test("keeps a missing provider session connecting instead of failed", async () => {
    const stub = createProviderStub("pi", {
      interactiveSnapshot: async () => ({ status: "missing", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-native-pi-recovering-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "pi" as const,
          logicalSessionKey: "env-env-1:tab-pi",
        };
        await service.ensureSession(identity);

        const projection = await service.getProjection(identity);
        expect(projection).toMatchObject({
          platform: "pi",
          connection: "connecting",
          turn: { phase: "recovering" },
        });
        expect(projection?.turn.error).toBeUndefined();
      },
    );
  });

  test("reports a session that stays missing once the connecting grace expires", async () => {
    // `connecting` renders a spinner with no retry control and nothing on the
    // read path re-creates a provider session, so an unbounded grace would
    // leave a tab on an overlay it has no way to leave.
    let clock = 1_000;
    const stub = createProviderStub("pi", {
      interactiveSnapshot: async () => ({ status: "missing", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-native-pi-grace-expiry-",
        provider: async () => stub.provider,
        now: () => clock,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "pi" as const,
          logicalSessionKey: "env-env-1:tab-pi",
        };
        await service.ensureSession(identity);

        // Reads alone never spend the grace: the read rate says nothing about
        // how long the bridge has actually been unreachable.
        for (let read = 0; read < 5; read += 1) {
          const projection = await service.getProjection(identity);
          expect(projection?.connection).toBe("connecting");
          expect(projection?.turn.error).toBeUndefined();
        }

        clock += NATIVE_MISSING_SESSION_GRACE_MS;
        const settled = await service.getProjection(identity);
        expect(settled?.connection).toBe("error");
        expect(settled?.turn.phase).toBe("recovering");
        expect(settled?.turn.error).toContain("no longer holds this session");
      },
    );
  });

  test("keeps the transcript a recovering session already had", async () => {
    // The overlay hides it, but a reconnect that succeeds must not have to
    // rebuild a transcript this backend still holds — and the cached
    // projection is what the next committed revision is built from.
    let missing = false;
    const stub = createProviderStub("pi", {
      interactiveSnapshot: async () =>
        missing
          ? { status: "missing", messages: [] }
          : {
              status: "idle",
              messages: [
                {
                  id: "assistant-1",
                  role: "assistant",
                  content: "already answered",
                  parts: [{ type: "text", content: "already answered" }],
                  createdAt: "2026-08-25T00:00:00.000Z",
                },
              ],
            },
    });
    await withService(
      {
        prefix: "orkestrator-native-pi-recovering-transcript-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "pi" as const,
          logicalSessionKey: "env-env-1:tab-pi",
        };
        await service.ensureSession(identity);
        const connected = await service.getProjection(identity);
        expect(connected?.connection).toBe("connected");
        expect(connected?.messages).toHaveLength(1);

        missing = true;
        const recovering = await service.getProjection(identity);

        expect(recovering?.connection).toBe("connecting");
        expect(recovering?.messages).toEqual(connected!.messages);
        expect(recovering?.sessionId).toBe(connected!.sessionId);
        // Revisions only ever advance. A renderer that adopted the connected
        // revision must not be handed a lower one it would ignore.
        expect(recovering!.revision).toBeGreaterThan(connected!.revision);
      },
    );
  });

  test("returns to connected when the provider finds the session again", async () => {
    let missing = true;
    const stub = createProviderStub("pi", {
      interactiveSnapshot: async () =>
        missing ? { status: "missing", messages: [] } : { status: "idle", messages: [] },
    });
    await withService(
      {
        prefix: "orkestrator-native-pi-recovered-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "pi" as const,
          logicalSessionKey: "env-env-1:tab-pi",
        };
        await service.ensureSession(identity);
        expect((await service.getProjection(identity))?.connection).toBe("connecting");

        missing = false;
        const recovered = await service.getProjection(identity);
        expect(recovered?.connection).toBe("connected");
        expect(recovered?.turn.phase).toBe("idle");
        expect(recovered?.notices ?? []).toEqual([]);
      },
    );
  });

  test("gives a later transient miss a full grace window of its own", async () => {
    // A spent deadline must not outlive the read that cleared it: an idle
    // detach hours after an earlier reconnect deserves the same benefit of the
    // doubt, not an instant failure inherited from the previous outage.
    let clock = 1_000;
    let missing = true;
    const stub = createProviderStub("pi", {
      interactiveSnapshot: async () =>
        missing ? { status: "missing", messages: [] } : { status: "idle", messages: [] },
    });
    await withService(
      {
        prefix: "orkestrator-native-pi-grace-reset-",
        provider: async () => stub.provider,
        now: () => clock,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "pi" as const,
          logicalSessionKey: "env-env-1:tab-pi",
        };
        await service.ensureSession(identity);
        expect((await service.getProjection(identity))?.connection).toBe("connecting");

        missing = false;
        clock += NATIVE_MISSING_SESSION_GRACE_MS * 4;
        expect((await service.getProjection(identity))?.connection).toBe("connected");

        missing = true;
        expect((await service.getProjection(identity))?.connection).toBe("connecting");
      },
    );
  });

  test("gates composer surfaces on the capability table, not on what the provider reported", async () => {
    // OpenCode has no fast surface and no Build/Plan permission mode: its
    // `mode` used to be sent as the SDK `agent` name, duplicating the execution
    // profile. A provider snapshot that claims both must not reintroduce them.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [
            {
              platform: "opencode",
              id: "opencode/sonnet",
              label: "Sonnet",
              supportsSpeed: true,
            },
          ],
          selectedModelId: "opencode/sonnet",
          fastModeEnabled: true,
          fastModeAvailable: true,
          selectedModeId: "plan",
          modes: [
            { id: "build", label: "Build" },
            { id: "plan", label: "Plan" },
          ],
          executionProfiles: [{ id: "build", label: "build" }],
        },
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-projection-capability-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-capability",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.composer?.modes).toEqual([]);
        expect(projection?.composer?.selectedModeId).toBeUndefined();
        expect(projection?.composer?.fastModeAvailable).toBe(false);
        expect(projection?.composer?.fastModeEnabled).toBeNull();
        // Execution profiles stay: OpenCode primary agents are the real control.
        expect(projection?.composer?.executionProfiles).toEqual([{ id: "build", label: "build" }]);
        expect(projection?.composerControls.map((control) => control.id)).toEqual([
          "model",
          "execution-profile",
        ]);

        // A mode the table forbids is refused rather than persisted, because the
        // projected `modes` list is what `updateProjectionControls` validates.
        await expect(
          service.updateProjectionControls({
            ...identity,
            update: { mode: "plan" },
          }),
        ).rejects.toThrow("Native agent conversation mode is invalid");
        await expect(
          service.updateProjectionControls({
            ...identity,
            update: { fastMode: true },
          }),
        ).rejects.toThrow("Native agent fast mode is unavailable");
      },
    );
  });

  test("projects an initial OpenCode execution profile before the first prompt", async () => {
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [
            { id: "build", label: "Build agent" },
            { id: "plan", label: "Plan agent" },
          ],
        },
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-initial-execution-profile-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-initial-profile",
        };
        await service.ensureSession({
          ...identity,
          executionProfileId: "plan",
        });

        await expect(service.getProjection(identity)).resolves.toMatchObject({
          composer: {
            modes: [],
            selectedExecutionProfileId: "plan",
            executionProfiles: [
              { id: "build", label: "Build agent" },
              { id: "plan", label: "Plan agent" },
            ],
          },
        });
      },
    );
  });

  test("carries a pre-reclassification conversation mode onto the execution profile", async () => {
    // A session created while OpenCode still had a Build/Plan pair persisted
    // `controls.mode`, and that value was dispatched as the SDK `agent` name.
    // Now that the table says OpenCode has no mode, the projection is the only
    // thing that can carry the choice across; without it the upgraded session
    // silently drops to the provider default and runs the build agent.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [
            { id: "build", label: "Build agent" },
            { id: "plan", label: "Plan agent" },
          ],
        },
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-legacy-mode-profile-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-legacy-mode",
        };
        await service.ensureSession({ ...identity, sessionMode: "plan" });

        const projection = await service.getProjection(identity);
        expect(projection?.composer?.selectedExecutionProfileId).toBe("plan");
        // The mode itself stays off the projection: the platform has no mode.
        expect(projection?.composer?.selectedModeId).toBeUndefined();
        expect(projection?.composer?.modes).toEqual([]);
        expect(projection?.composerControls.map((control) => control.id)).toEqual([
          "execution-profile",
        ]);

        // An explicit profile still wins over the legacy mode it replaces.
        await service.updateProjectionControls({
          ...identity,
          update: { executionProfileId: "build" },
        });
        await expect(service.getProjection(identity)).resolves.toMatchObject({
          composer: { selectedExecutionProfileId: "build" },
        });
      },
    );
  });

  test("drops a stored execution profile the provider does not list", async () => {
    // The unassigned launcher pins a profile before any session exists, so it
    // cannot know the real agent names. A pinned id the provider turns out not
    // to have must not reach `send` as an unknown agent.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [{ id: "architect", label: "architect" }],
        },
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-unknown-execution-profile-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-unknown-profile",
        };
        await service.ensureSession({ ...identity, executionProfileId: "plan" });

        const projection = await service.getProjection(identity);
        expect(projection?.composer?.selectedExecutionProfileId).toBeUndefined();
        expect(projection?.composer?.executionProfiles).toEqual([
          { id: "architect", label: "architect" },
        ]);
      },
    );
  });

  test("keeps a stored execution profile while the provider's agent list is unavailable", async () => {
    // An empty list means the agent listing failed or has not arrived yet, not
    // that the profile is gone. Dropping the selection there would swap the
    // user's agent for the provider default on a transient read.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [],
        },
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-pending-execution-profile-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-pending-profile",
        };
        await service.ensureSession({ ...identity, executionProfileId: "plan" });

        const projection = await service.getProjection(identity);
        expect(projection?.composer?.selectedExecutionProfileId).toBe("plan");
        // The generated control list stays empty — the native tab supplies a
        // Plan/Build fallback itself rather than reading composerControls.
        expect(projection?.composer?.executionProfiles).toBeUndefined();
        expect(projection?.composerControls.map((control) => control.id)).toEqual([]);
      },
    );
  });

  test("accepts an execution-profile update while the provider's agent list is unavailable", async () => {
    // Same empty-list rule as projection: the listing has not arrived, so a
    // Plan/Build choice from the compose bar must persist rather than 400.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [],
        },
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-pending-execution-profile-update-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-pending-profile-update",
        };
        await service.ensureSession(identity);
        await service.updateProjectionControls({
          ...identity,
          update: { executionProfileId: "plan" },
        });
        await expect(service.getProjection(identity)).resolves.toMatchObject({
          composer: { selectedExecutionProfileId: "plan" },
        });
      },
    );
  });

  test("rejects a non-fallback execution profile while the agent list is unavailable", async () => {
    // The empty-list exemption is for the two ids the compose bar can offer
    // without a listing, not a hole. Anything else is unverifiable and is
    // forwarded verbatim as the provider's `agent` name, so it must still 400.
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [],
          fastModeEnabled: false,
          fastModeAvailable: false,
          modes: [],
          executionProfiles: [],
        },
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-unknown-execution-profile-update-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-unknown-profile-update",
        };
        await service.ensureSession(identity);
        await expect(
          service.updateProjectionControls({
            ...identity,
            update: { executionProfileId: "totally-unknown-agent" },
          }),
        ).rejects.toThrow("Native agent execution profile is invalid");
        await expect(
          service.updateProjectionControls({
            ...identity,
            update: { executionProfileId: "x".repeat(5_000) },
          }),
        ).rejects.toThrow("Native agent execution profile is invalid");
        // Nothing was persisted, so the projection still carries no selection.
        const projection = await service.getProjection(identity);
        expect(projection?.composer?.selectedExecutionProfileId).toBeUndefined();
      },
    );
  });

  test("drops execution profiles and Claude-only toggles a provider reports off-table", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [{ platform: "codex", id: "gpt-5", label: "GPT-5" }],
          selectedModelId: "gpt-5",
          fastModeEnabled: false,
          fastModeAvailable: false,
          selectedModeId: "build",
          modes: [{ id: "build", label: "Build" }],
          executionProfiles: [{ id: "reviewer", label: "Reviewer" }],
          selectedExecutionProfileId: "reviewer",
          includeLocalSettings: true,
          promptSuggestionsEnabled: true,
        },
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-projection-offtable-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-offtable",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.composer?.executionProfiles).toBeUndefined();
        expect(projection?.composer?.selectedExecutionProfileId).toBeUndefined();
        expect(projection?.composer?.includeLocalSettings).toBeUndefined();
        expect(projection?.composer?.promptSuggestionsEnabled).toBeUndefined();
        expect(projection?.composerControls.map((control) => control.id)).toEqual([
          "model",
          "mode",
        ]);
      },
    );
  });

  test("renders provider terminal states as uniform durable transcript rows", async () => {
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        notices: [{ kind: "stopped", message: "Query stopped by user." }],
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-terminal-row-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-terminal",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.messages).toEqual([
          expect.objectContaining({
            role: "system",
            content: "Query stopped by user.",
          }),
        ]);
        expect(projection?.notices).toBeUndefined();
      },
    );
  });

  test("does not poll tab-facing projection routes without a foreground reader", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-native-no-background-projection-poll-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-inactive",
        };
        await service.init();
        await service.ensureSession(identity);
        await service.getProjection(identity);
        expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setTimeout(resolve, 425));
        expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("serializes projection reads and preserves the newest expanded window", async () => {
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activeReads = 0;
    let maxActiveReads = 0;
    let call = 0;
    const messages = Array.from({ length: 700 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      content: `message ${index}`,
      parts: [],
      createdAt: new Date(index).toISOString(),
    }));
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => {
        call += 1;
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        try {
          if (call === 1) {
            signalFirst();
            await firstGate;
            return { status: "idle" as const, messages: messages.slice(-512) };
          }
          return { status: "running" as const, messages };
        } finally {
          activeReads -= 1;
        }
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-serialized-projections-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:tab-race",
        };
        await service.ensureSession(identity);
        const first = service.getProjection(identity);
        await firstEntered;
        const second = service.getProjection({ ...identity, messageLimit: 1_024 });
        await Promise.resolve();
        expect(stub.interactiveSnapshot).toHaveBeenCalledTimes(1);
        releaseFirst();
        await expect(first).resolves.toMatchObject({ turn: { phase: "idle" } });
        const newest = await second;
        expect(maxActiveReads).toBe(1);
        expect(newest).toMatchObject({
          turn: { phase: "running" },
          messageWindow: { limit: 1_024, truncated: false },
        });
        expect(newest?.messages).toHaveLength(700);
      },
    );
  });

  test("evicting the oldest cache entry does not fence a read in flight for it", async () => {
    let releaseSlow!: () => void;
    let signalSlow!: () => void;
    const slowEntered = new Promise<void>((resolve) => {
      signalSlow = resolve;
    });
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let call = 0;
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => {
        call += 1;
        // Only the second read of the evicted tab is held open; the first
        // populates the cache and the third belongs to the new tab.
        if (call === 2) {
          signalSlow();
          await slowGate;
        }
        return { status: "idle", messages: [] };
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-eviction-fence-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const evicted = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:tab-evicted",
        };
        const fresh = { ...evicted, logicalSessionKey: "env-env-1:tab-fresh" };
        await service.ensureSession(evicted);
        await service.ensureSession(fresh);
        // Cached first, so it is the oldest key the capacity sweep will drop.
        expect(await service.getProjection(evicted)).not.toBeNull();

        const cache = internals(service).projectionCache;
        const evictedKey = nativeAgentSessionStorageKey(
          evicted.environmentId,
          evicted.agent,
          evicted.logicalSessionKey,
        );
        expect([...cache.keys()][0]).toBe(evictedKey);
        while (cache.size < NATIVE_PROJECTION_CACHE_LIMIT) {
          cache.set(`filler:${cache.size}`, cache.get(evictedKey)!);
        }

        const held = service.getProjection(evicted);
        await slowEntered;
        // Committing a new key now trips the capacity sweep and drops the tab
        // whose read is still outstanding.
        expect(await service.getProjection(fresh)).not.toBeNull();
        expect(cache.has(evictedKey)).toBe(false);

        releaseSlow();
        // Capacity eviction is not an identity change, so the outstanding read
        // still commits rather than reporting the session as missing.
        const resolved = await held;
        expect(resolved).not.toBeNull();
        expect(resolved).toMatchObject({ turn: { phase: "idle" } });
        expect(cache.has(evictedKey)).toBe(true);
      },
    );
  });

  test("keeps an at-capacity session usable so a new model can continue it", async () => {
    // Codex answers a turn it could not run with a terminal session error. The
    // thread, rollout and config all survive it, and the fix is to pick another
    // model and send again — so neither the liveness probe nor the dispatch may
    // treat the previous turn's failure as a dead session.
    const stub = createProviderStub("codex", {
      status: async () => {
        throw new ProviderSessionFailedError(
          "codex",
          "Selected model is at capacity. Please try a different model.",
        );
      },
      interactiveSnapshot: async () => ({
        status: "error",
        messages: [],
        error: "Selected model is at capacity. Please try a different model.",
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-at-capacity-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-capacity",
        };
        const created = await service.ensureSession({ ...identity, model: "gpt-5.6-sol" });

        const reused = await service.ensureSession({ ...identity, model: "gpt-5.6-luna" });
        expect(reused.providerSessionId).toBe(created.providerSessionId);
        expect(stub.createSession).toHaveBeenCalledTimes(1);

        await service.dispatchPrompt({
          ...identity,
          prompt: "Please continue",
          requestId: "request-after-capacity",
          model: "gpt-5.6-luna",
        });
        expect(stub.send).toHaveBeenCalledTimes(1);
        expect(stub.send.mock.calls[0]?.[1]).toBe("Please continue");
        // The point of reusing the session is that the *replacement* model runs.
        // Reuse alone would still be broken if the new model were dropped here.
        expect(stub.send.mock.calls[0]?.[2]).toMatchObject({ model: "gpt-5.6-luna" });

        // The failure is still reported — it just no longer blocks the composer.
        const projection = await service.getProjection(identity);
        expect(projection?.turn).toMatchObject({
          phase: "error",
          error: "Selected model is at capacity. Please try a different model.",
        });
      },
    );
  });

  test("projects a terminal turn failure through the status fallback", async () => {
    const detail = "Selected model is at capacity. Please try a different model.";
    const stub = createProviderStub("codex", {
      status: async () => {
        throw new ProviderSessionFailedError("codex", detail);
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-terminal-projection-fallback-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-terminal-projection",
        };
        await service.ensureSession(identity);

        const projection = await service.getProjection(identity);

        expect(stub.status).toHaveBeenCalledWith("provider-session");
        expect(projection).toMatchObject({
          connection: "connected",
          turn: { phase: "error", error: detail },
          messages: [{ role: "system", content: detail }],
        });
      },
    );
  });

  test("reclaims projection epochs once a key is neither cached nor being read", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-native-epoch-bound-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-epoch",
        };
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        const session = await service.ensureSession(identity);
        await service.getProjection(identity);

        // A session action changes the tab's identity and so records an epoch.
        await service
          .performProjectionAction({ ...identity, action: { kind: "compact" } })
          .catch(() => undefined);
        await service.getProjection(identity);
        const epochs = internals(service).projectionEpochs;
        expect(epochs.size).toBeLessThanOrEqual(
          internals(service).projectionCache.size + internals(service).projectionRefreshes.size,
        );

        // Once the session is gone the projection resolves to nothing, the cache
        // entry goes with it, and the epoch must not outlive either.
        await storage.invalidateNativeAgentSession(key, session.providerSessionId);
        await expect(service.getProjection(identity)).resolves.toBeNull();
        expect(internals(service).projectionCache.has(key)).toBe(false);
        expect(epochs.has(key)).toBe(false);
      },
    );
  });

  test("resumes with complete controls and discards an in-flight old-session projection", async () => {
    let releaseOld!: () => void;
    let signalOld!: () => void;
    const oldEntered = new Promise<void>((resolve) => {
      signalOld = resolve;
    });
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let snapshotCall = 0;
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async (sessionId) => {
        snapshotCall += 1;
        if (snapshotCall === 1) {
          signalOld();
          await oldGate;
        }
        return {
          status: "idle",
          messages: [
            {
              id: `message-${sessionId}`,
              role: "assistant",
              content: sessionId,
              parts: [],
              createdAt: new Date(0).toISOString(),
            },
          ],
        };
      },
    });
    const resumeSession = mock(async () => "provider-resumed");
    (stub.provider as NativeAgentRuntimeProvider).resumeSession = resumeSession;
    await withService(
      {
        prefix: "orkestrator-native-resume-controls-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:tab-resume-controls",
        };
        await service.ensureSession({
          ...identity,
          model: "old-model",
          sessionMode: "build",
        });
        const stale = service.getProjection(identity);
        await oldEntered;
        const controls = {
          modelId: "new-model",
          reasoningId: "high",
          mode: "plan" as const,
          fastMode: true,
          executionProfileId: "reviewer",
          includeLocalSettings: true,
          promptSuggestions: true,
        };
        const resumed = service.resumeProjectionSession({
          ...identity,
          providerSessionId: "provider-resumed",
          controls,
        });
        await waitForCondition(() => resumeSession.mock.calls.length === 1);
        releaseOld();
        /*
         * The fenced read must not become the cached authoritative state, but it
         * must not report `null` either: that is reserved for "this tab resolves
         * to no provider session", and a caller without its own fence would read
         * an ordinary resume as a deleted session. It is handed back uncommitted
         * at revision 0 instead.
         */
        const fenced = await stale;
        expect(fenced).not.toBeNull();
        expect(fenced).toMatchObject({ revision: 0 });
        await expect(resumed).resolves.toMatchObject({ sessionId: "provider-resumed" });
        expect(resumeSession).toHaveBeenCalledWith("provider-resumed", controls);
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.controls).toEqual(controls);
      },
    );
  });

  test("projects bounded slash commands and caches discovery independently of transcript refresh", async () => {
    let now = 1_000;
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        composer: {
          models: [{ platform: "claude", id: "sonnet", label: "Sonnet" }],
          selectedModelId: "sonnet",
          fastModeEnabled: false,
          fastModeAvailable: false,
          selectedModeId: "build",
          modes: [{ id: "build", label: "Build" }],
        },
      }),
      slashCommands: async () => [
        {
          name: "/review",
          description: "Review the current changes",
          argumentHint: "[focus]",
          source: "builtin",
        },
      ],
    });
    await withService(
      {
        prefix: "orkestrator-native-projection-slash-",
        provider: async () => stub.provider,
        now: () => now,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:tab-slash",
        };
        await service.ensureSession(identity);
        const first = await service.getProjection(identity);
        expect(first?.slashCommands).toEqual([
          {
            name: "/review",
            description: "Review the current changes",
            argumentHint: "[focus]",
            source: "builtin",
          },
          {
            name: "/steer",
            description: "Send instructions to the turn that is already running",
            argumentHint: "<instructions>",
            source: "orkestrator",
          },
        ]);
        await service.getProjection(identity);
        expect(stub.slashCommands).toHaveBeenCalledTimes(1);

        now += 30_001;
        await service.getProjection(identity);
        expect(stub.slashCommands).toHaveBeenCalledTimes(2);
      },
    );
  });

  test("does not hold an updated transcript behind expired discovery metadata", async () => {
    let now = 1_000;
    let message = "old transcript";
    let releaseCatalog!: () => void;
    let releaseCommands!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const commandGate = new Promise<void>((resolve) => {
      releaseCommands = resolve;
    });
    let catalogReads = 0;
    let catalogRefreshFinished = false;
    const invoke: Invoke = async <T>(command: string): Promise<T> => {
      if (command !== "get_native_agent_model_catalog") {
        throw new Error(`Unexpected backend command: ${command}`);
      }
      catalogReads += 1;
      if (catalogReads > 1) {
        await catalogGate;
        catalogRefreshFinished = true;
      }
      return [
        {
          platform: "codex",
          id: catalogReads > 1 ? "gpt-new" : "gpt-old",
          label: catalogReads > 1 ? "GPT new" : "GPT old",
        },
      ] as T;
    };
    let commandReads = 0;
    let commandRefreshFinished = false;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [
          {
            id: "message-1",
            role: "assistant",
            content: message,
            parts: [],
            createdAt: "2026-08-14T10:00:00.000Z",
          },
        ],
      }),
      slashCommands: async () => {
        commandReads += 1;
        if (commandReads > 1) {
          await commandGate;
          commandRefreshFinished = true;
        }
        return [{ name: commandReads > 1 ? "/new" : "/old", source: "builtin" }];
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-stale-discovery-",
        provider: async () => stub.provider,
        invoke,
        now: () => now,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-stale-discovery",
        };
        await service.ensureSession(identity);
        await service.getProjection(identity);

        now += 30_001;
        message = "latest transcript";
        const projection = await Promise.race([
          service.getProjection(identity),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("Transcript waited for discovery metadata")), 100);
          }),
        ]);

        expect(projection?.messages).toEqual([
          expect.objectContaining({ content: "latest transcript" }),
        ]);
        expect(projection?.composer?.models).toEqual([expect.objectContaining({ id: "gpt-old" })]);
        expect(projection?.slashCommands?.map((command) => command.name)).toEqual([
          "/old",
          "/steer",
        ]);

        releaseCatalog();
        releaseCommands();
        await waitForCondition(() => catalogRefreshFinished && commandRefreshFinished);
        const updated = await service.getProjection(identity);
        expect(updated?.composer?.models).toEqual([expect.objectContaining({ id: "gpt-new" })]);
        expect(updated?.slashCommands?.map((command) => command.name)).toEqual(["/new", "/steer"]);
      },
    );
  });

  test("runs fresh discovery after an explicit refresh overlaps stale background work", async () => {
    let now = 1_000;
    let releaseCatalog!: () => void;
    let releaseCommands!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const commandGate = new Promise<void>((resolve) => {
      releaseCommands = resolve;
    });
    let catalogReads = 0;
    let staleCatalogSettled = false;
    const invoke: Invoke = async <T>(command: string): Promise<T> => {
      if (command !== "get_native_agent_model_catalog") {
        throw new Error(`Unexpected backend command: ${command}`);
      }
      catalogReads += 1;
      if (catalogReads === 2) {
        await catalogGate;
        staleCatalogSettled = true;
      }
      return [
        {
          platform: "codex",
          id: catalogReads > 2 ? "gpt-new" : "gpt-old",
          label: catalogReads > 2 ? "GPT new" : "GPT old",
        },
      ] as T;
    };
    let commandReads = 0;
    let staleCommandsSettled = false;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      slashCommands: async () => {
        commandReads += 1;
        if (commandReads === 2) {
          await commandGate;
          staleCommandsSettled = true;
        }
        return [{ name: commandReads > 2 ? "/new" : "/old", source: "builtin" }];
      },
      refreshCatalog: () => undefined,
    });
    await withService(
      {
        prefix: "orkestrator-native-forced-discovery-",
        provider: async () => stub.provider,
        invoke,
        now: () => now,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-forced-discovery",
        };
        try {
          await service.ensureSession(identity);
          const initial = await service.getProjection(identity);
          expect(initial?.composer?.models.map((model) => model.id)).toEqual(["gpt-old"]);
          expect(initial?.slashCommands?.map((command) => command.name)).toEqual([
            "/old",
            "/steer",
          ]);

          now += 30_001;
          await service.getProjection(identity);
          await waitForCondition(() => catalogReads === 2 && commandReads === 2);

          const refreshedProjection = service.refreshProjectionModels(identity);
          await Promise.resolve();
          expect(catalogReads).toBe(2);
          expect(commandReads).toBe(2);

          // Both gates are still closed: an explicit refresh discards the stale
          // reads instead of inheriting their latency, which for a wedged bridge
          // is a full request timeout.
          const refreshed = await refreshedProjection;
          expect(staleCatalogSettled).toBe(false);
          expect(staleCommandsSettled).toBe(false);
          expect(stub.refreshCatalog).toHaveBeenCalledTimes(1);
          expect(catalogReads).toBe(3);
          expect(commandReads).toBe(3);
          expect(refreshed?.composer?.models.map((model) => model.id)).toEqual(["gpt-new"]);
          expect(refreshed?.slashCommands?.map((command) => command.name)).toEqual([
            "/new",
            "/steer",
          ]);

          // The discarded reads finishing later must not overwrite the catalogue
          // the explicit refresh just installed.
          releaseCatalog();
          releaseCommands();
          await waitForCondition(() => staleCatalogSettled && staleCommandsSettled);
          const settled = await service.getProjection(identity);
          expect(catalogReads).toBe(3);
          expect(commandReads).toBe(3);
          expect(settled?.composer?.models.map((model) => model.id)).toEqual(["gpt-new"]);
          expect(settled?.slashCommands?.map((command) => command.name)).toEqual([
            "/new",
            "/steer",
          ]);
        } finally {
          releaseCatalog();
          releaseCommands();
        }
      },
    );
  });

  test("still re-lists when the provider's own catalogue refresh fails", async () => {
    // Some providers answer `refreshCatalog` by reaching their bridge process,
    // so it can fail for reasons that have nothing to do with the caches this
    // method exists to drop. By the time it runs, the in-flight discovery has
    // already been discarded — so propagating would leave the user with an
    // error *and* the stale picker they asked to replace.
    let now = 1_000;
    let catalogReads = 0;
    const invoke: Invoke = async <T>(command: string): Promise<T> => {
      if (command !== "get_native_agent_model_catalog") {
        throw new Error(`Unexpected backend command: ${command}`);
      }
      catalogReads += 1;
      return [
        {
          platform: "codex",
          id: catalogReads > 1 ? "gpt-new" : "gpt-old",
          label: catalogReads > 1 ? "GPT new" : "GPT old",
        },
      ] as T;
    };
    let commandReads = 0;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      slashCommands: async () => {
        commandReads += 1;
        return [{ name: commandReads > 1 ? "/new" : "/old", source: "builtin" }];
      },
      refreshCatalog: async () => {
        throw new ProviderUnavailableError("pi bridge is unavailable");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-refresh-failure-",
        provider: async () => stub.provider,
        invoke,
        now: () => now,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-refresh-failure",
        };
        await service.ensureSession(identity);
        const initial = await service.getProjection(identity);
        expect(initial?.composer?.models.map((model) => model.id)).toEqual(["gpt-old"]);
        expect(initial?.slashCommands?.map((command) => command.name)).toEqual(["/old", "/steer"]);

        const refreshed = await service.refreshProjectionModels(identity);

        expect(stub.refreshCatalog).toHaveBeenCalledTimes(1);
        // The caches were dropped despite the throw, so the re-list ran and the
        // user sees the newer catalogue rather than the one they refreshed away.
        expect(refreshed?.composer?.models.map((model) => model.id)).toEqual(["gpt-new"]);
        expect(refreshed?.slashCommands?.map((command) => command.name)).toEqual([
          "/new",
          "/steer",
        ]);
      },
    );
  });

  test("backs a failed background discovery off instead of retrying every poll", async () => {
    let now = 1_000;
    let catalogReads = 0;
    const invoke: Invoke = async <T>(command: string): Promise<T> => {
      if (command !== "get_native_agent_model_catalog") {
        throw new Error(`Unexpected backend command: ${command}`);
      }
      catalogReads += 1;
      if (catalogReads > 1) throw new Error("Model discovery is unavailable");
      return [{ platform: "codex", id: "gpt-old", label: "GPT old" }] as T;
    };
    let commandReads = 0;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      slashCommands: async () => {
        commandReads += 1;
        if (commandReads > 1) throw new Error("Command discovery is unavailable");
        return [{ name: "/old", source: "builtin" }];
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-discovery-backoff-",
        provider: async () => stub.provider,
        invoke,
        now: () => now,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-discovery-backoff",
        };
        await service.ensureSession(identity);
        await service.getProjection(identity);
        expect(catalogReads).toBe(1);
        expect(commandReads).toBe(1);

        now += 30_001;
        const stale = await service.getProjection(identity);
        expect(stale?.composer?.models.map((model) => model.id)).toEqual(["gpt-old"]);
        expect(stale?.slashCommands?.map((command) => command.name)).toEqual(["/old", "/steer"]);

        // A failed optional endpoint must not be re-probed on every 500ms
        // projection poll, so the retained entry carries an explicit back-off.
        const caches = service as unknown as {
          modelCatalogCache: Map<string, { expiresAt: number }>;
          slashCommandCache: Map<string, { expiresAt: number }>;
        };
        await waitForCondition(
          () =>
            caches.modelCatalogCache.get("env-1")?.expiresAt === now + 5_000 &&
            caches.slashCommandCache.get("env-1\0codex\0provider-session")?.expiresAt ===
              now + 5_000,
        );
        expect(catalogReads).toBe(2);
        expect(commandReads).toBe(2);

        now += 4_999;
        const withinBackoff = await service.getProjection(identity);
        expect(catalogReads).toBe(2);
        expect(commandReads).toBe(2);
        expect(withinBackoff?.composer?.models.map((model) => model.id)).toEqual(["gpt-old"]);
        expect(withinBackoff?.slashCommands?.map((command) => command.name)).toEqual([
          "/old",
          "/steer",
        ]);

        now += 2;
        await service.getProjection(identity);
        await waitForCondition(() => catalogReads === 3 && commandReads === 3);
      },
    );
  });

  test("advertises runtime session-action commands beside provider discovery", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      slashCommands: async () => [
        { name: "/review", description: "Review changes", source: "builtin" },
      ],
    });
    await withService(
      {
        prefix: "orkestrator-native-projection-actions-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-actions",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        // `/steer` is performed by the runtime rather than the model, so it has
        // to be advertised by whoever knows the capability — not by a tab.
        expect(projection?.slashCommands?.map((command) => command.name)).toEqual([
          "/review",
          "/steer",
        ]);
        expect(projection?.capabilities.attachments).toEqual({
          files: false,
          images: true,
        });
      },
    );
  });

  /*
   * The renderer gates the composer's enqueue on its own adapter capabilities
   * and the backend gates the projection's queue on the protocol table. Those
   * used to be separate copies, so a one-sided edit produced a prompt that
   * dispatched but never showed up in the queue list. Assert the projection
   * really publishes the shared table rather than anything of its own.
   */
  test.each([...BUILD_PIPELINE_AGENTS])(
    "publishes the shared %s capability table through the projection",
    async (agent) => {
      const stub = createProviderStub(agent, {
        interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      });
      await withService(
        {
          prefix: `orkestrator-native-${agent}-capability-table-`,
          provider: async () => stub.provider,
        },
        async ({ service }) => {
          const identity = {
            environmentId: "env-1",
            agent,
            logicalSessionKey: `env-env-1:tab-${agent}-capabilities`,
          };
          await service.ensureSession(identity);
          const projection = await service.getProjection(identity);
          expect(projection?.capabilities).toEqual(nativeAgentCapabilities(agent));
        },
      );
    },
  );

  test.each(["codex", "pi"] as const)(
    "removes steering from an unqualified %s bridge projection",
    async (agent) => {
      const stub = createProviderStub(agent, {
        interactiveSnapshot: async () => ({ status: "running", messages: [] }),
        steerSupported: async () => false,
      });
      await withService(
        {
          prefix: `orkestrator-native-${agent}-steer-qualification-`,
          provider: async () => stub.provider,
        },
        async ({ service }) => {
          const identity = {
            environmentId: "env-1",
            agent,
            logicalSessionKey: `env-env-1:tab-${agent}-steer-qualification`,
          };
          await service.ensureSession(identity);
          const projection = await service.getProjection(identity);
          expect(stub.steerSupported).toHaveBeenCalledWith("provider-session");
          expect(projection?.capabilities.actions?.steer).toBe(false);
          expect(
            projection?.slashCommands?.some((command) => command.name === "/steer") ?? false,
          ).toBe(false);
        },
      );
    },
  );
});
