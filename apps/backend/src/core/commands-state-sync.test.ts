import { describe, expect, mock, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isPrMonitorSnapshot } from "@orkestrator/protocol/pr-monitor";
import {
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
} from "@orkestrator/protocol/agent-interactions";
import {
  __testing as commandTesting,
  createCommandRegistry,
  findKanbanTaskForEnvironment,
  getPrMonitorDetectionRequest,
  parsePrMonitorDetectionResponse,
  shutdownPrMonitorTracking,
  toClientEnvironment,
  type CommandContext,
} from "./commands.js";
import { StorageService } from "./storage.js";
import { ClaudeStatePollManager } from "./tmux.js";

/**
 * Registry-level coverage for the commands that back the backend-owned state
 * introduced with the change feed. These run against a real StorageService
 * because the argument coercion in the registry is exactly what decides whether
 * storage's own validation is reachable.
 */

async function withCommands<T>(
  run: (
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>,
    storage: StorageService,
  ) => Promise<T>,
  options: {
    claudeStatePolls?: ClaudeStatePollManager;
    environment?: Record<string, unknown>;
    buildPipelines?: CommandContext["buildPipelines"];
    nativeAgents?: CommandContext["nativeAgents"];
  } = {},
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-state-sync-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "e1", name: "Env", projectId: "proj-1", status: "running",
    environmentType: "local", branch: "main", order: 0,
    containerId: null, prUrl: null, prState: null, hasMergeConflicts: null,
    networkAccessMode: "restricted", createdAt: new Date(0).toISOString(),
    ...options.environment,
  } as Parameters<StorageService["addEnvironment"]>[0]);
  const commands = createCommandRegistry({
    claudeStatePolls: options.claudeStatePolls,
  });
  const context = {
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    emit: () => undefined,
    storage,
    buildPipelines: options.buildPipelines,
    nativeAgents: options.nativeAgents,
  } as unknown as CommandContext;

  const invoke = async (command: string, args: Record<string, unknown>) => {
    const handler = commands.get(command);
    if (!handler) throw new Error(`Command not registered: ${command}`);
    return await handler(args, context);
  };

  try {
    return await run(invoke, storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const KEY = "claude env-e1:tab-1";

describe("prompt queue commands", () => {
  test("mutates and reads back a backend-owned queue", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("enqueue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: { id: "m1" },
      })).resolves.toMatchObject({ queueKey: KEY, revision: 1 });
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: { id: "m2" },
      });
      await invoke("move_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        messageId: "m2",
        direction: "up",
      });

      await expect(invoke("get_prompt_queue", { queueKey: KEY }))
        .resolves.toMatchObject({ messages: [{ id: "m2" }, { id: "m1" }] });
      await expect(invoke("list_prompt_queues", { environmentId: "e1" }))
        .resolves.toHaveLength(1);
      await expect(invoke("remove_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: "m2",
      })).resolves.toMatchObject({
        removed: { id: "m2" },
        queue: { messages: [{ id: "m1" }] },
      });
    });
  });

  test("explicitly retries a terminal queue dispatch", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "invalid" }]);
      await storage.reservePromptQueueHeadForDispatch(KEY);
      await storage.failPromptQueueDispatch(KEY, "m1");

      await expect(invoke("retry_prompt_queue_dispatch", { queueKey: KEY }))
        .resolves.toMatchObject({
          messages: [{ id: "m1", text: "invalid" }],
        });
      expect((await storage.getPromptQueue(KEY))?.dispatchError).toBeUndefined();
    });
  });

  test("atomically claims the expected queue head", async () => {
    await withCommands(async (invoke) => {
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: { id: "m1" },
      });
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: { id: "m2" },
      });
      const first = await invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m1",
      }) as { claimToken: string };
      expect(first).toMatchObject({
        claimed: { id: "m1" },
        queue: { messages: [{ id: "m2" }], revision: 3 },
      });

      await expect(invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m2",
      })).resolves.toMatchObject({
        claimed: null,
        claimToken: null,
        queue: {
          messages: [{ id: "m2" }],
          revision: 3,
          outstandingClaim: { message: { id: "m1" } },
        },
      });
      await expect(invoke("acknowledge_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: first.claimToken,
      })).resolves.toMatchObject({
        messages: [{ id: "m2" }],
        revision: 4,
      });
    });
  });

  test("requeues, nacks, and acknowledges through registry commands", async () => {
    await withCommands(async (invoke) => {
      await invoke("requeue_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        message: { id: "m1", text: "first", attachments: [] },
      });
      const claim = await invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m1",
      }) as { claimToken: string };
      await expect(invoke("reject_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: claim.claimToken,
      })).resolves.toMatchObject({ messages: [{ id: "m1" }] });

      const retry = await invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m1",
      }) as { claimToken: string };
      await expect(invoke("acknowledge_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: retry.claimToken,
      })).resolves.toMatchObject({ messages: [] });
    });
  });

  test("atomically transfers the authoritative queued payload to a draft", async () => {
    await withCommands(async (invoke) => {
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        message: {
          id: "m1",
          text: "authoritative",
          attachments: [{ id: "attachment-1" }],
          mode: "plan",
        },
      });
      await expect(invoke("transfer_prompt_queue_message_to_compose_draft", {
        queueKey: KEY,
        environmentId: "e1",
        messageId: "m1",
        draftKey: "compose:e1:tab-1",
        ownerType: "environment",
        ownerId: "e1",
        expectedDraftRevision: 0,
      })).resolves.toMatchObject({
        removed: { id: "m1", mode: "plan" },
        queue: { messages: [] },
        draft: {
          value: {
            text: "authoritative",
            mentions: [],
            attachments: [{ id: "attachment-1" }],
          },
        },
      });
    });
  });

  test("rejects malformed atomic-claim arguments", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "",
      })).rejects.toThrow();
      await expect(invoke("enqueue_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        message: "bad",
      })).rejects.toThrow("non-blank ID");
      await expect(invoke("acknowledge_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: "",
      })).rejects.toThrow();
      await expect(invoke("reject_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: "",
      })).rejects.toThrow();
      await expect(invoke("transfer_prompt_queue_message_to_compose_draft", {
        queueKey: KEY,
        environmentId: "e1",
        messageId: "",
        draftKey: "compose:e1:tab-1",
        ownerType: "environment",
        ownerId: "e1",
      })).rejects.toThrow();
    });
  });

  test("rejects malformed reorder, removal, and requeue arguments", async () => {
    // Each of these coerces at the registry boundary, so a bad payload must
    // fail there rather than reaching storage as a plausible-looking value.
    await withCommands(async (invoke) => {
      await expect(invoke("move_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: "m1", direction: 1,
      })).rejects.toThrow("direction");
      await expect(invoke("move_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: "m1",
      })).rejects.toThrow("direction");
      await expect(invoke("move_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: "m1", direction: "sideways",
      })).rejects.toThrow("must be up or down");
      await expect(invoke("remove_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: 7,
      })).rejects.toThrow("messageId");
      await expect(invoke("requeue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: "bad",
      })).rejects.toThrow("non-blank ID");
    });
  });

  test("rejects a non-numeric expected draft revision before the transfer runs", async () => {
    await withCommands(async (invoke, storage) => {
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        message: { id: "m1", text: "queued", attachments: [] },
      });

      await expect(invoke("transfer_prompt_queue_message_to_compose_draft", {
        queueKey: KEY,
        environmentId: "e1",
        messageId: "m1",
        draftKey: "compose:e1:tab-1",
        ownerType: "environment",
        ownerId: "e1",
        expectedDraftRevision: "1",
      })).rejects.toThrow("expectedDraftRevision");

      expect(await storage.getPromptQueue(KEY)).toMatchObject({ messages: [{ id: "m1" }] });
      expect(await storage.getComposeDraft("compose:e1:tab-1")).toBeNull();
    });
  });

  test("rejects blank identifiers", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("enqueue_prompt_queue_message", {
        queueKey: "", environmentId: "e1", message: { id: "m1" },
      })).rejects.toThrow();
      await expect(invoke("get_prompt_queue", { queueKey: "" })).rejects.toThrow();
      await expect(invoke("list_prompt_queues", { environmentId: "" })).rejects.toThrow();
    });
  });
});

describe("draft commands", () => {
  test("forwards compare-and-swap revisions for compose and file mutations", async () => {
    await withCommands(async (invoke) => {
      const compose = await invoke("save_compose_draft", {
        draftKey: "compose:e1:tab",
        ownerType: "environment",
        ownerId: "e1",
        value: "first",
        expectedRevision: 0,
      }) as { revision: number };
      const file = await invoke("save_file_draft", {
        draftKey: "file:e1:a",
        environmentId: "e1",
        filePath: "a.ts",
        content: "first",
        originalContent: "disk",
        expectedRevision: 0,
      }) as { revision: number };

      await invoke("save_compose_draft", {
        draftKey: "compose:e1:tab",
        ownerType: "environment",
        ownerId: "e1",
        value: "second",
        expectedRevision: compose.revision,
      });
      await invoke("save_file_draft", {
        draftKey: "file:e1:a",
        environmentId: "e1",
        filePath: "a.ts",
        content: "second",
        originalContent: "disk",
        expectedRevision: file.revision,
      });

      await expect(invoke("delete_compose_draft", {
        draftKey: "compose:e1:tab",
        expectedRevision: compose.revision,
      })).rejects.toThrow("revision conflict");
      await expect(invoke("delete_file_draft", {
        draftKey: "file:e1:a",
        expectedRevision: file.revision,
      })).rejects.toThrow("revision conflict");
      await expect(invoke("delete_compose_draft", {
        draftKey: "compose:e1:tab",
        expectedRevision: 2,
      })).resolves.toBeUndefined();
      await expect(invoke("delete_file_draft", {
        draftKey: "file:e1:a",
        expectedRevision: 2,
      })).resolves.toBeUndefined();
    });
  });

  test("rejects malformed revision arguments before draft mutation", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("save_file_draft", {
        draftKey: "file:e1:a",
        environmentId: "e1",
        filePath: "a.ts",
        content: "first",
        originalContent: "disk",
        expectedRevision: "zero",
      })).rejects.toThrow("Expected expectedRevision to be a number");
      await expect(invoke("delete_compose_draft", {
        draftKey: "compose:e1:tab",
        expectedRevision: "zero",
      })).rejects.toThrow("Expected expectedRevision to be a number");
      await expect(invoke("delete_file_draft", {
        draftKey: "file:e1:a",
        expectedRevision: "zero",
      })).rejects.toThrow("Expected expectedRevision to be a number");
    });
  });
});

describe("agent handoff commands", () => {
  test("saves, reads, and deletes an environment-owned handoff", async () => {
    await withCommands(async (invoke, storage) => {
      const snapshot = {
        sourceProvider: "claude",
        destinationProvider: "codex",
        messages: [{ id: "m1" }],
      };
      await expect(invoke("save_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
        version: 1,
        snapshot,
      })).resolves.toMatchObject({
        id: "h1",
        environmentId: "e1",
        version: 1,
        snapshot,
      });
      await expect(invoke("get_agent_handoff", { handoffId: "h1" }))
        .resolves.toMatchObject({ id: "h1", snapshot });
      await expect(invoke("delete_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
      })).resolves.toBe(true);
      await expect(storage.getAgentHandoff("h1")).resolves.toBeNull();
      await expect(invoke("delete_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
      })).resolves.toBe(false);
    });
  });

  test("rejects malformed command arguments before mutation", async () => {
    await withCommands(async (invoke, storage) => {
      await expect(invoke("save_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
        version: "1",
        snapshot: {},
      })).rejects.toThrow("version");
      await expect(invoke("save_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
        version: 1,
        snapshot: [],
      })).rejects.toThrow("must be an object");
      await expect(invoke("get_agent_handoff", { handoffId: 1 }))
        .rejects.toThrow("handoffId");
      await expect(invoke("delete_agent_handoff", {
        handoffId: "h1",
        environmentId: null,
      })).rejects.toThrow("environmentId");
      await expect(storage.getAgentHandoff("h1")).resolves.toBeNull();
    });
  });

  test("prunes handoffs the restored layout no longer references", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.saveAgentHandoff("kept", "e1", 1, { messages: [] });
      await storage.saveAgentHandoff("orphan", "e1", 1, { messages: [] });

      await expect(invoke("prune_agent_handoffs", {
        environmentId: "e1",
        referencedHandoffIds: ["kept"],
      })).resolves.toEqual(["orphan"]);
      await expect(storage.getAgentHandoff("kept")).resolves.not.toBeNull();
      await expect(storage.getAgentHandoff("orphan")).resolves.toBeNull();
    });
  });

  test("refuses a prune whose reference list is not an array of strings", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.saveAgentHandoff("kept", "e1", 1, { messages: [] });

      /*
       * `asStringArray` would coerce each of these to `[]`, which here reads as
       * "nothing is referenced" and would delete every transcript in the
       * environment. Prune has to reject the request instead.
       */
      for (const referencedHandoffIds of [undefined, null, "kept", { 0: "kept" }]) {
        await expect(invoke("prune_agent_handoffs", {
          environmentId: "e1",
          referencedHandoffIds,
        })).rejects.toThrow("referencedHandoffIds");
      }
      await expect(invoke("prune_agent_handoffs", {
        environmentId: "e1",
        referencedHandoffIds: ["kept", 7],
      })).rejects.toThrow("only strings");
      await expect(invoke("prune_agent_handoffs", {
        environmentId: 1,
        referencedHandoffIds: [],
      })).rejects.toThrow("environmentId");

      await expect(storage.getAgentHandoff("kept")).resolves.not.toBeNull();
    });
  });
});

describe("native agent and looped-review controller commands", () => {
  test("maps native session and dispatch arguments to the backend authority", async () => {
    const ensureSession = mock(async (input: unknown) => ({
      operation: "ensure",
      input,
    }));
    const dispatchPrompt = mock(async (input: unknown) => ({
      operation: "dispatch",
      input,
    }));
    const adoptSession = mock(async (input: unknown) => ({
      operation: "adopt",
      input,
    }));
    const nativeAgents = {
      ensureSession,
      adoptSession,
      dispatchPrompt,
    } as unknown as NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (invoke) => {
      await expect(invoke("ensure_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        title: "Review",
        model: "gpt-test",
        reasoningEffort: "high",
        phase: "review",
      })).resolves.toMatchObject({ operation: "ensure" });
      expect(ensureSession).toHaveBeenCalledWith({
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        title: "Review",
        model: "gpt-test",
        reasoningEffort: "high",
        phase: "review",
      });

      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:tab-adopted",
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
        model: "provider/model",
        reasoningEffort: "high",
      })).resolves.toMatchObject({ operation: "adopt" });
      expect(adoptSession).toHaveBeenCalledWith({
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:tab-adopted",
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
        title: undefined,
        model: "provider/model",
        reasoningEffort: "high",
        phase: undefined,
      });

      const schema = { type: "object" };
      const images = [{ filename: "reference.png", data: "cG5n" }];
      await expect(invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        prompt: "Review this",
        requestId: "request-1",
        images,
        schema,
      })).resolves.toMatchObject({ operation: "dispatch" });
      expect(dispatchPrompt).toHaveBeenCalledWith({
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        title: undefined,
        model: undefined,
        reasoningEffort: undefined,
        phase: undefined,
        prompt: "Review this",
        requestId: "request-1",
        images,
        attachments: undefined,
        schema,
        // An absent mode must resolve to the restrictive direction: undefined
        // reaches the Claude bridge as bypassPermissions.
        mode: "plan",
        fastMode: undefined,
        subAgent: undefined,
        includeLocalSettings: undefined,
        promptSuggestions: undefined,
      });

      await expect(invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        prompt: " ",
        requestId: "request-2",
      })).rejects.toThrow("non-blank string");
      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:tab-adopted",
        providerSessionId: " ",
      })).rejects.toThrow("non-blank string");
      expect(dispatchPrompt).toHaveBeenCalledTimes(1);
      expect(adoptSession).toHaveBeenCalledTimes(1);

      await expect(invoke("ensure_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:invalid-origin",
        origin: "scheduled-task",
      })).rejects.toThrow("supported agent interaction origin");
      await expect(invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:invalid-policy",
        prompt: "Review",
        requestId: "request-invalid-policy",
        interactionPolicy: {
          ...UNATTENDED_AGENT_INTERACTION_POLICY,
          authorization: "await-user",
        },
      })).rejects.toThrow("valid agent interaction policy");
      // The third registration site coerces the same two arguments and must
      // reject them just as the other two do.
      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:invalid-origin",
        providerSessionId: "provider-new",
        origin: "scheduled-task",
      })).rejects.toThrow("supported agent interaction origin");
      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:invalid-policy",
        providerSessionId: "provider-new",
        interactionPolicy: {
          ...INTERACTIVE_AGENT_INTERACTION_POLICY,
          unknown: "await-user",
        },
      })).rejects.toThrow("valid agent interaction policy");
      await expect(invoke("ensure_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:non-string-origin",
        origin: 7,
      })).rejects.toThrow("supported agent interaction origin");
      expect(ensureSession).toHaveBeenCalledTimes(1);
      expect(dispatchPrompt).toHaveBeenCalledTimes(1);
      expect(adoptSession).toHaveBeenCalledTimes(1);
    }, { nativeAgents });
  });

  test("rejects malformed dispatch images, attachments and schema", async () => {
    const dispatchPrompt = mock(async () => ({ operation: "dispatch" }));
    const nativeAgents = { dispatchPrompt } as unknown as
      NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (invoke) => {
      const base = {
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        prompt: "Review this",
        requestId: "request-1",
      };
      // Cast straight through, a malformed element surfaced as a TypeError deep
      // inside the provider — which the drain path then retried forever.
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        images: [{}],
      })).rejects.toThrow("filename must be a non-empty string");
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        images: [{ filename: "a.png", data: "not base64!" }],
      })).rejects.toThrow("valid base64");
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        images: Array.from({ length: 21 }, () => ({ filename: "a.png", data: "AA==" })),
      })).rejects.toThrow("At most 20 prompt images");
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        attachments: [{ type: "image" }],
      })).rejects.toThrow("path must be a non-empty string");
      expect(dispatchPrompt).not.toHaveBeenCalled();

      // typeof x === "object" admits arrays, so a JSON array must not pass as a
      // JSON Schema object.
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        schema: [{ type: "object" }],
      })).resolves.toMatchObject({ operation: "dispatch" });
      expect(dispatchPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ schema: undefined }),
      );
    }, { nativeAgents });
  });

  test("forwards an explicit dispatch mode and its per-prompt options", async () => {
    const dispatchPrompt = mock(async () => ({ operation: "dispatch" }));
    const nativeAgents = { dispatchPrompt } as unknown as
      NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (invoke) => {
      await invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        prompt: "Ship it",
        requestId: "request-1",
        mode: "build",
        fastMode: true,
        subAgent: "reviewer",
        includeLocalSettings: false,
        promptSuggestions: true,
      });
      expect(dispatchPrompt).toHaveBeenCalledWith(expect.objectContaining({
        mode: "build",
        fastMode: true,
        subAgent: "reviewer",
        includeLocalSettings: false,
        promptSuggestions: true,
      }));
    }, { nativeAgents });
  });

  test("reports unavailable native supervision before accepting work", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("ensure_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
      })).rejects.toThrow("Native agent service is unavailable");
      await expect(invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
        prompt: "Build",
        requestId: "request-1",
      })).rejects.toThrow("Native agent service is unavailable");
      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
        providerSessionId: "provider-1",
      })).rejects.toThrow("Native agent service is unavailable");
    });
  });

  test("acknowledges only the startup session identified by optional fencing fields", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.updateEnvironment("e1", {
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          providerSessionId: "provider-1",
          status: "running",
          startedAt: "2026-07-29T12:00:00.000Z",
        },
      });

      await expect(invoke("acknowledge_startup_agent_session", {
        environmentId: "e1",
        providerSessionId: "provider-old",
      })).resolves.toMatchObject({
        startupAgentSession: { providerSessionId: "provider-1" },
      });
      await expect(invoke("acknowledge_startup_agent_session", {
        environmentId: "e1",
        providerSessionId: "provider-1",
        startedAt: "2026-07-29T12:00:00.000Z",
      })).resolves.toMatchObject({ id: "e1" });
      expect((await storage.getEnvironment("e1"))?.startupAgentSession)
        .toBeUndefined();

      await expect(invoke("acknowledge_startup_agent_session", {
        environmentId: "e1",
        providerSessionId: " ",
      })).rejects.toThrow("non-blank string");
    });
  });

  test("claims, validates, and releases a fenced looped-review controller lease", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.saveLoopedReviewWorkflow(
        "workflow-1",
        "e1",
        1,
        { id: "workflow-1", phase: "reviewing" },
      );

      const claimed = await invoke("claim_looped_review_controller", {
        workflowId: "workflow-1",
        ownerId: "desktop",
        leaseMs: 15_000,
      }) as { granted: boolean; token: string; expiresAt: string };
      expect(claimed.granted).toBe(true);
      expect(typeof claimed.token).toBe("string");
      expect(claimed.token.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(claimed.expiresAt))).toBe(true);
      const valid = await invoke("validate_looped_review_controller", {
        workflowId: "workflow-1",
        ownerId: "desktop",
        token: claimed.token,
      });
      expect(valid).toBe(true);
      await expect(invoke("save_looped_review_workflow", {
        workflowId: "workflow-1",
        environmentId: "e1",
        version: 1,
        snapshot: { id: "workflow-1", phase: "fixing" },
        expectedRevision: 1,
        controllerOwnerId: "desktop",
        controllerToken: claimed.token,
      })).resolves.toMatchObject({
        revision: 2,
        snapshot: { id: "workflow-1", phase: "fixing" },
      });
      await expect(invoke("save_looped_review_workflow", {
        workflowId: "workflow-1",
        environmentId: "e1",
        version: 1,
        snapshot: { id: "workflow-1", phase: "stale" },
        expectedRevision: 2,
        controllerOwnerId: "desktop",
      })).rejects.toThrow("controllerToken");
      await expect(invoke("release_looped_review_controller", {
        workflowId: "workflow-1",
        ownerId: "desktop",
        token: claimed.token,
      })).resolves.toBeUndefined();
      await expect(invoke("validate_looped_review_controller", {
        workflowId: "workflow-1",
        ownerId: "desktop",
        token: claimed.token,
      })).resolves.toBe(false);
    });
  });

  test("reconciles a pending launch after setup and re-reads authoritative state", async () => {
    const reconcileInitialLaunch = mock(async (_environmentId: string) => undefined);
    const nativeAgents = {
      reconcileInitialLaunch,
    } as unknown as NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (_invoke, storage) => {
      reconcileInitialLaunch.mockImplementationOnce(async (environmentId) => {
        await storage.updateEnvironment(environmentId, {
          pendingAgentLaunch: false,
          startupAgentSession: {
            tabId: "startup-agent",
            agent: "codex",
            style: "native",
            providerSessionId: "provider-1",
            status: "running",
          },
        });
      });
      const environment = await storage.getEnvironment("e1");
      if (!environment) throw new Error("Test environment is missing");
      const completed = await commandTesting.completeEnvironmentSetup(
        environment,
        {
          storage,
          emit: () => undefined,
          appRoot: "",
          resourceRoot: "",
          environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
          nativeAgents,
        },
      );

      expect(reconcileInitialLaunch).toHaveBeenCalledWith("e1");
      expect(completed).toMatchObject({
        setupScriptsComplete: true,
        pendingAgentLaunch: false,
        startupAgentSession: {
          providerSessionId: "provider-1",
          status: "running",
        },
      });
    }, {
      nativeAgents,
      environment: {
        createdFromCommit: "commit-1",
        pendingAgentLaunch: true,
      },
    });
  });

  test("keeps setup complete and launch pending when reconciliation fails", async () => {
    const nativeAgents = {
      reconcileInitialLaunch: mock(async () => {
        throw new Error("bridge unavailable");
      }),
    } as unknown as NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (_invoke, storage) => {
      const environment = await storage.getEnvironment("e1");
      if (!environment) throw new Error("Test environment is missing");
      await expect(commandTesting.completeEnvironmentSetup(
        environment,
        {
          storage,
          emit: () => undefined,
          appRoot: "",
          resourceRoot: "",
          environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
          nativeAgents,
        },
      )).resolves.toMatchObject({
        setupScriptsComplete: true,
        pendingAgentLaunch: true,
      });
    }, {
      nativeAgents,
      environment: {
        createdFromCommit: "commit-1",
        pendingAgentLaunch: true,
      },
    });
  });
});

describe("build pipeline commands", () => {
  const startInput = {
    taskId: "task-1",
    projectId: "proj-1",
    environmentType: "local",
    agentType: "codex",
    taskTitle: "Implement the feature",
    taskSnapshot: {
      title: "Implement the feature",
      description: "Do the work",
      acceptanceCriteria: "It works",
      comments: [],
      images: [],
    },
  } as const;

  test("delegates lifecycle operations to the backend supervisor", async () => {
    const start = mock(async (input: unknown) => ({ operation: "start", input }));
    const pause = mock(async (id: string) => ({ operation: "pause", id }));
    const resume = mock(async (id: string) => ({ operation: "resume", id }));
    const cancel = mock(async (id: string) => ({ operation: "cancel", id }));
    const retryCompletionComment = mock(async (id: string) => ({
      operation: "retry",
      id,
    }));
    const remove = mock(async (id: string) => ({ operation: "remove", id }));
    const sendMessage = mock(async (id: string, text: string) => ({
      operation: "send",
      id,
      text,
    }));
    const retryReview = mock(async (id: string) => ({
      operation: "retry-review",
      id,
    }));
    const supervisor = {
      start,
      pause,
      resume,
      cancel,
      retryCompletionComment,
      remove,
      sendMessage,
      retryReview,
    } as unknown as NonNullable<CommandContext["buildPipelines"]>;

    await withCommands(async (invoke, storage) => {
      await expect(invoke("start_build_pipeline", startInput))
        .resolves.toMatchObject({ operation: "start" });
      await expect(invoke("pause_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toEqual({ operation: "pause", id: "pipeline-1" });
      await expect(invoke("resume_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toEqual({ operation: "resume", id: "pipeline-1" });
      await expect(invoke("cancel_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toEqual({ operation: "cancel", id: "pipeline-1" });
      await expect(invoke("retry_build_pipeline_completion_comment", {
        pipelineId: "pipeline-1",
      })).resolves.toEqual({ operation: "retry", id: "pipeline-1" });
      await expect(invoke("send_build_pipeline_message", {
        pipelineId: "pipeline-1",
        text: "also update the README",
      })).resolves.toEqual({
        operation: "send",
        id: "pipeline-1",
        text: "also update the README",
      });
      await expect(invoke("retry_build_pipeline_review", {
        pipelineId: "pipeline-1",
      })).resolves.toEqual({ operation: "retry-review", id: "pipeline-1" });

      await storage.saveBuildPipeline("pipeline-1", "proj-1", "e1", 1, {
        id: "pipeline-1",
      });
      await expect(invoke("delete_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toEqual({ operation: "remove", id: "pipeline-1" });
      expect(await storage.getBuildPipeline("pipeline-1")).not.toBeNull();

      expect(start).toHaveBeenCalledWith(startInput);
      expect(pause).toHaveBeenCalledWith("pipeline-1");
      expect(resume).toHaveBeenCalledWith("pipeline-1");
      expect(cancel).toHaveBeenCalledWith("pipeline-1");
      expect(retryCompletionComment).toHaveBeenCalledWith("pipeline-1");
      expect(remove).toHaveBeenCalledWith("pipeline-1");
      expect(sendMessage)
        .toHaveBeenCalledWith("pipeline-1", "also update the README");
      expect(retryReview).toHaveBeenCalledWith("pipeline-1");
    }, { buildPipelines: supervisor });
  });

  test("validates lifecycle arguments before invoking the supervisor", async () => {
    const start = mock(async () => undefined);
    const pause = mock(async () => undefined);
    const supervisor = {
      start,
      pause,
      resume: pause,
      cancel: pause,
      retryCompletionComment: pause,
      remove: pause,
    } as unknown as NonNullable<CommandContext["buildPipelines"]>;

    await withCommands(async (invoke) => {
      await expect(invoke("start_build_pipeline", {
        ...startInput,
        taskSnapshot: { ...startInput.taskSnapshot, images: "not-an-array" },
      })).rejects.toThrow("Invalid build pipeline start request");
      await expect(invoke("pause_build_pipeline", { pipelineId: "   " }))
        .rejects.toThrow("non-blank string");
      await expect(invoke("resume_build_pipeline", { pipelineId: 7 }))
        .rejects.toThrow("string");
      await expect(invoke("cancel_build_pipeline", {}))
        .rejects.toThrow("string");
      await expect(invoke("retry_build_pipeline_completion_comment", {
        pipelineId: "",
      })).rejects.toThrow("non-blank string");
      await expect(invoke("delete_build_pipeline", { pipelineId: " " }))
        .rejects.toThrow("non-blank string");
      await expect(invoke("get_build_pipeline", { pipelineId: "" }))
        .rejects.toThrow("non-blank string");
      await expect(invoke("list_build_pipelines", { projectId: " " }))
        .rejects.toThrow("non-blank string");

      expect(start).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
    }, { buildPipelines: supervisor });
  });

  test("imports legacy snapshots only through the backend supervisor", async () => {
    const importLegacy = mock(async (projectId: string, snapshots: unknown[]) => ({
      importedIds: snapshots.map((_, index) => `${projectId}-${index}`),
      skipped: 0,
    }));
    const snapshots = [{ id: "legacy-1" }, { id: "legacy-2" }];
    const supervisor = {
      importLegacy,
    } as unknown as NonNullable<CommandContext["buildPipelines"]>;

    await withCommands(async (invoke) => {
      await expect(invoke("import_legacy_build_pipelines", {
        projectId: "proj-1",
        snapshots,
      })).resolves.toEqual({
        importedIds: ["proj-1-0", "proj-1-1"],
        skipped: 0,
      });
      expect(importLegacy).toHaveBeenCalledWith("proj-1", snapshots);

      await expect(invoke("import_legacy_build_pipelines", {
        projectId: " ",
        snapshots,
      })).rejects.toThrow("non-blank string");
      await expect(invoke("import_legacy_build_pipelines", {
        projectId: "proj-1",
        snapshots: {},
      })).rejects.toThrow("snapshots to be an array");
      await expect(invoke("import_legacy_build_pipelines", {
        projectId: "proj-1",
        snapshots: Array.from({ length: 101 }, () => ({})),
      })).rejects.toThrow("limited to 100 snapshots");
      expect(importLegacy).toHaveBeenCalledTimes(1);
    }, { buildPipelines: supervisor });
  });

  test("reports unavailable supervision and keeps deletion recoverable", async () => {
    await withCommands(async (invoke, storage) => {
      for (const [command, args] of [
        ["start_build_pipeline", startInput],
        ["pause_build_pipeline", { pipelineId: "pipeline-1" }],
        ["resume_build_pipeline", { pipelineId: "pipeline-1" }],
        ["cancel_build_pipeline", { pipelineId: "pipeline-1" }],
        ["retry_build_pipeline_completion_comment", { pipelineId: "pipeline-1" }],
        ["send_build_pipeline_message", {
          pipelineId: "pipeline-1",
          text: "hello",
        }],
        ["retry_build_pipeline_review", { pipelineId: "pipeline-1" }],
        ["import_legacy_build_pipelines", {
          projectId: "proj-1",
          snapshots: [],
        }],
      ] as const) {
        await expect(invoke(command, args))
          .rejects.toThrow("Build pipeline supervisor is unavailable");
      }

      await storage.saveBuildPipeline("pipeline-1", "proj-1", "e1", 1, {
        id: "pipeline-1",
      });
      await expect(invoke("delete_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toBeUndefined();
      expect(await storage.getBuildPipeline("pipeline-1")).toBeNull();
    });
  });

  test("rejects client-authored snapshots while preserving reads and deletion", async () => {
    await withCommands(async (invoke, storage) => {
      await expect(invoke("save_build_pipeline", {
        pipelineId: "p1",
        projectId: "proj-1",
        environmentId: "e1",
        version: 1,
        snapshot: { id: "p1", phase: "building" },
      })).rejects.toThrow("backend-owned");

      await storage.saveBuildPipeline("p1", "proj-1", "e1", 2, {
        id: "p1",
        phase: "building",
        controller: "backend",
      });

      await expect(invoke("list_build_pipelines", { projectId: "proj-1" }))
        .resolves.toHaveLength(1);

      await invoke("delete_build_pipeline", { pipelineId: "p1" });
      await expect(invoke("get_build_pipeline", { pipelineId: "p1" })).resolves.toBeNull();
    });
  });
});

describe("set_environment_agent_activity", () => {
  test("persists agent activity and rejects malformed command arguments", async () => {
    await withCommands(async (invoke) => {
      const occurredAt = "2026-07-27T12:00:00.000Z";
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt,
        observerId: "renderer-observer-1",
      })).resolves.toMatchObject({
        agentActivityState: "working",
        agentActivityUpdatedAt: occurredAt,
      });

      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "busy",
        occurredAt,
      })).rejects.toThrow("state must be idle, working, or waiting");

      await expect(invoke("set_environment_agent_activity", {
        environmentId: 42,
        state: "working",
        occurredAt,
      })).rejects.toThrow("Expected environmentId to be a string");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: 42,
        occurredAt,
      })).rejects.toThrow("Expected state to be a string");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt: 42,
      })).rejects.toThrow("Expected occurredAt to be a string");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt,
        observerId: 42,
      })).rejects.toThrow("Expected observerId to be a string");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt,
        observerId: "",
      })).rejects.toThrow("observerId must be a non-blank string");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt: "invalid",
      })).rejects.toThrow("occurredAt must be a valid ISO timestamp");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt: "+275760-09-13T00:00:00.000Z",
      })).rejects.toThrow("occurredAt must not be more than 5 minutes in the future");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "missing",
        state: "working",
        occurredAt,
      })).rejects.toThrow("Environment not found: missing");
    });
  });

  test("ignores a caller-supplied source so a renderer cannot forge backend observations", async () => {
    // The `claude-terminal` source is what the backend poller writes, and the
    // aggregate lets any `working` source pin the environment. A renderer that
    // could name its own source could impersonate the poller.
    await withCommands(async (invoke, storage) => {
      await invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt: "2026-07-27T12:00:00.000Z",
        observerId: "renderer-observer-1",
        source: "claude-terminal",
      });

      const environment = await storage.getEnvironment("e1");
      expect(environment?.agentActivitySources).toEqual({});
      expect(environment?.frontendAgentActivityObservers).toMatchObject({
        [createHash("sha256").update("renderer-observer-1").digest("hex")]: {
          state: "working",
          updatedAt: "2026-07-27T12:00:00.000Z",
          leaseExpiresAt: expect.any(String),
        },
      });
      expect(environment?.agentActivitySources)
        .not.toHaveProperty("claude-terminal");
    });
  });
});

describe("claude state polling commands", () => {
  function createTestPollManager() {
    const scheduled: Array<() => void> = [];
    const cancelled: unknown[] = [];
    const manager = new ClaudeStatePollManager({
      readState: async () => "idle",
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancel: (timer) => cancelled.push(timer),
      now: () => "2026-07-27T12:00:00.000Z",
    });
    return { manager, scheduled, cancelled };
  }

  const runningContainerEnvironment = {
    status: "running",
    environmentType: "containerized",
    containerId: "container-1",
  };

  test("requires a subscription token on both sides of the lease", async () => {
    // Both arguments became required with the lease. A caller on an older
    // bundle would hard-error here rather than silently polling forever, so the
    // contract is worth pinning explicitly.
    const { manager, scheduled, cancelled } = createTestPollManager();
    await withCommands(async (invoke) => {
      await expect(invoke("start_claude_state_polling", {
        containerId: "container-1",
      })).rejects.toThrow("Expected subscriptionId to be a string");
      await expect(invoke("stop_claude_state_polling", {
        containerId: "container-1",
      })).rejects.toThrow("Expected subscriptionId to be a string");
      await expect(invoke("start_claude_state_polling", {
        subscriptionId: "sub-1",
      })).rejects.toThrow("Expected containerId to be a string");

      // A rejected registration must not have started anything.
      expect(scheduled).toHaveLength(0);
      expect(cancelled).toHaveLength(0);
    }, { claudeStatePolls: manager, environment: runningContainerEnvironment });
  });

  test("starts one poll per container and keeps it while the environment runs", async () => {
    const { manager, scheduled, cancelled } = createTestPollManager();
    await withCommands(async (invoke, storage) => {
      await invoke("start_claude_state_polling", {
        containerId: "container-1", subscriptionId: "sub-1",
      });
      await invoke("start_claude_state_polling", {
        containerId: "container-1", subscriptionId: "sub-2",
      });
      // Registration is idempotent per container, not per subscriber.
      expect(scheduled).toHaveLength(1);

      await invoke("stop_claude_state_polling", {
        containerId: "container-1", subscriptionId: "sub-1",
      });
      await invoke("stop_claude_state_polling", {
        containerId: "container-1", subscriptionId: "sub-2",
      });
      // Polling is backend-owned: losing every renderer does not stop it,
      // because detecting activity while nothing is mounted is the point.
      expect(cancelled).toHaveLength(0);

      await storage.updateEnvironment("e1", { status: "stopped" });
      await invoke("stop_claude_state_polling", {
        containerId: "container-1", subscriptionId: "sub-2",
      });
      expect(cancelled).toHaveLength(1);
    }, { claudeStatePolls: manager, environment: runningContainerEnvironment });
  });

  test("records the polled state on the environment it belongs to", async () => {
    const { manager } = createTestPollManager();
    await withCommands(async (invoke, storage) => {
      await invoke("start_claude_state_polling", {
        containerId: "container-1", subscriptionId: "sub-1",
      });

      const deadline = Date.now() + 2_000;
      let recorded = await storage.getEnvironment("e1");
      while (!recorded?.agentActivitySources?.["claude-terminal"]) {
        if (Date.now() > deadline) throw new Error("timed out waiting for poll");
        await new Promise((resolve) => setTimeout(resolve, 10));
        recorded = await storage.getEnvironment("e1");
      }

      expect(recorded.agentActivitySources!["claude-terminal"]).toMatchObject({
        state: "idle",
      });
      await storage.updateEnvironment("e1", { status: "stopped" });
      await invoke("stop_claude_state_polling", {
        containerId: "container-1", subscriptionId: "sub-1",
      });
    }, { claudeStatePolls: manager, environment: runningContainerEnvironment });
  });
});

describe("set_environment_unread", () => {
  async function seedEnvironment(storage: StorageService): Promise<void> {
    if (!await storage.getProject("proj-1")) {
      await storage.addProject({
        id: "proj-1", name: "Project", gitUrl: "https://example.com/repo.git",
        localPath: null, order: 0, addedAt: new Date().toISOString(),
      });
    }
    if (!await storage.getEnvironment("e1")) {
      await storage.addEnvironment({
        id: "e1", name: "Env", projectId: "proj-1", status: "running",
        environmentType: "local", branch: "main", order: 0,
        containerId: null, prUrl: null, prState: null, hasMergeConflicts: null,
        networkAccessMode: "restricted", createdAt: new Date().toISOString(),
      });
    }
  }

  test("sets and clears the badge on the environment record", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);

      await expect(invoke("set_environment_unread", { environmentId: "e1", unread: true }))
        .resolves.toMatchObject({ id: "e1", hasUnreadWork: true });
      await expect(invoke("set_environment_unread", {
        environmentId: "e1", unread: false, expectedLastActivityAt: null,
      }))
        .resolves.toMatchObject({ id: "e1", hasUnreadWork: false });
    });
  });

  test("treats a non-boolean flag as read rather than marking unread", async () => {
    // asBoolean falls back to false, so a malformed request can only ever clear
    // the badge — never raise one the user has not been given a reason for.
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      await invoke("set_environment_unread", { environmentId: "e1", unread: true });

      await expect(invoke("set_environment_unread", { environmentId: "e1", unread: "yes" }))
        .resolves.toMatchObject({ hasUnreadWork: false });
    });
  });

  test("rejects an unknown environment", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("set_environment_unread", { environmentId: "missing", unread: true }))
        .rejects.toThrow("not found");
    });
  });

  test("does not let a delayed clear erase a newer completion", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      const first = "2026-01-01T00:00:00.000Z";
      const second = "2026-01-01T00:00:01.000Z";

      await expect(invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: first,
      })).resolves.toMatchObject({ lastActivityAt: first, hasUnreadWork: true });

      await expect(invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: second,
      })).resolves.toMatchObject({ lastActivityAt: second, hasUnreadWork: true });

      await expect(invoke("set_environment_unread", {
        environmentId: "e1",
        unread: false,
        expectedLastActivityAt: first,
      })).resolves.toMatchObject({ lastActivityAt: second, hasUnreadWork: true });
    });
  });

  test("guards an absent activity token with explicit null", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      const completion = "2026-01-01T00:00:00.000Z";

      await invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: completion,
      });
      await expect(invoke("set_environment_unread", {
        environmentId: "e1",
        unread: false,
        expectedLastActivityAt: null,
      })).resolves.toMatchObject({ lastActivityAt: completion, hasUnreadWork: true });
    });
  });

  test("rejects a malformed clear token instead of clearing without a guard", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      await invoke("set_environment_unread", { environmentId: "e1", unread: true });

      await expect(invoke("set_environment_unread", {
        environmentId: "e1",
        unread: false,
        expectedLastActivityAt: 42,
      })).rejects.toThrow("Expected expectedLastActivityAt to be a string");
      expect(await storage.getEnvironment("e1")).toMatchObject({ hasUnreadWork: true });
    });
  });

  test("ignores a stale completion without raising a new badge", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      const newest = "2026-01-01T00:00:01.000Z";
      await invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: newest,
      });
      await invoke("set_environment_unread", {
        environmentId: "e1", unread: false, expectedLastActivityAt: newest,
      });

      await expect(invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: "2026-01-01T00:00:00.000Z",
      })).resolves.toMatchObject({ lastActivityAt: newest, hasUnreadWork: false });
    });
  });
});

describe("pr monitor commands", () => {
  // The module-level PR monitor service outlives each temporary storage
  // directory; dropping its entries keeps one test's watch requests (and any
  // scheduled polls) from leaking into the next.
  test("pr_monitor_watch validates its arguments", async () => {
    await withCommands(async (invoke) => {
      try {
        await expect(invoke("pr_monitor_watch", {
          environmentId: "e1", mode: "idle",
        })).rejects.toThrow("mode must be normal, create-pending, or merge-pending");
        await expect(invoke("pr_monitor_watch", {
          environmentId: 42, mode: "merge-pending",
        })).rejects.toThrow("Expected environmentId to be a string");
        await expect(invoke("pr_monitor_watch", {
          environmentId: "missing", mode: "merge-pending",
        })).rejects.toThrow("Environment not found: missing");
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("watch requests are durable in the authoritative snapshot", async () => {
    await withCommands(async (invoke) => {
      try {
        const empty = await invoke("get_pr_monitor_state", {});
        expect(isPrMonitorSnapshot(empty)).toBe(true);
        expect((empty as { entries: unknown[] }).entries).toEqual([]);

        await invoke("pr_monitor_watch", { environmentId: "e1", mode: "create-pending" });

        // A later snapshot — the rehydration path a freshly mounted client
        // uses — still carries the pending request; nothing about it lived in
        // the client that asked.
        const snapshot = await invoke("get_pr_monitor_state", {}) as {
          entries: Array<Record<string, unknown>>;
        };
        expect(isPrMonitorSnapshot(snapshot)).toBe(true);
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
          environmentId: "e1",
          mode: "create-pending",
          prUrl: null,
          consecutiveErrors: 0,
        });

        await expect(invoke("pr_monitor_refresh", { environmentId: "e1" })).resolves.toBeUndefined();
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("conflict-resolution refresh intent is durable and backend-only", async () => {
    await withCommands(async (invoke, storage) => {
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });

        const armedAt = await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        }) as string;

        const armed = await storage.getEnvironment("e1");
        expect(armed?.prRecheckAfterAgentCompletionArmedAt).toEqual(expect.any(String));
        expect(armed?.prRecheckAfterAgentCompletionArmedAt).toBe(armedAt);
        expect(toClientEnvironment(armed!)).not.toHaveProperty(
          "prRecheckAfterAgentCompletionArmedAt",
        );

        // A backend completion edge schedules the monitor but does not consume
        // the intent before GitHub confirms the conflict is actually gone.
        await invoke("pr_monitor_agent_turn_completed", { environmentId: "e1" });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(
            armed?.prRecheckAfterAgentCompletionArmedAt,
          );

        // GitHub's indeterminate result must not consume the durable request.
        await invoke("set_environment_pr", {
          environmentId: "e1",
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: null,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(armedAt);

        await invoke("set_environment_pr", {
          environmentId: "e1",
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: false,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();

        await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();

        await storage.updateEnvironment("e1", {
          prState: "open",
          hasMergeConflicts: true,
        });
        await invoke("arm_pr_refresh_after_agent_completion", { environmentId: "e1" });
        await invoke("set_environment_pr", {
          environmentId: "e1",
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "merged",
          hasMergeConflicts: null,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();

        await storage.updateEnvironment("e1", {
          prState: "open",
          hasMergeConflicts: true,
        });
        const disappearanceArm = await invoke(
          "arm_pr_refresh_after_agent_completion",
          { environmentId: "e1" },
        ) as string;
        const knownRequest = getPrMonitorDetectionRequest({
          environmentId: "e1",
          branch: "main",
          kind: "local",
          worktreePath: "/tmp/worktree",
          ready: true,
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
        expect(() => parsePrMonitorDetectionResponse(knownRequest, "not-json"))
          .toThrow("Failed to parse gh pr view output");
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(disappearanceArm);

        // The monitor's upstream-disappearance effect uses the same clear.
        await invoke("clear_environment_pr", { environmentId: "e1" });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("set_environment_pr validates required metadata without clearing an arm", async () => {
    await withCommands(async (invoke, storage) => {
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
        const armedAt = await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        }) as string;

        for (const args of [
          { environmentId: "e1", prUrl: "https://github.com/acme/repo/pull/7", prState: "open" },
          { environmentId: "e1", prUrl: "https://github.com/acme/repo/pull/7", prState: "draft", hasMergeConflicts: false },
          { environmentId: "e1", prUrl: "https://github.com/acme/repo/pull/7", prState: "open", hasMergeConflicts: "no" },
        ]) {
          await expect(invoke("set_environment_pr", args)).rejects.toThrow();
          expect((await storage.getEnvironment("e1"))
            ?.prRecheckAfterAgentCompletionArmedAt).toBe(armedAt);
        }
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("returns the rollback token when monitor hydration fails after persistence", async () => {
    await withCommands(async (invoke, storage) => {
      const warning = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
        const loadEnvironments = storage.loadEnvironments.bind(storage);
        let calls = 0;
        const loadSpy = spyOn(storage, "loadEnvironments").mockImplementation(async () => {
          calls += 1;
          if (calls === 2) throw new Error("temporary storage read failure");
          return loadEnvironments();
        });

        const armedAt = await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        }) as string;
        expect(armedAt).toEqual(expect.any(String));
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(armedAt);
        expect(warning).toHaveBeenCalledWith(
          "[pr-monitor] Failed to track armed environment e1:",
          "temporary storage read failure",
        );
        loadSpy.mockRestore();
      } finally {
        warning.mockRestore();
        shutdownPrMonitorTracking();
      }
    });
  });

  test("token-safe disarm cannot clear a newer Resolve request", async () => {
    await withCommands(async (invoke, storage) => {
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
        const first = await invoke("arm_pr_refresh_after_agent_completion", { environmentId: "e1" }) as string;
        const second = await invoke("arm_pr_refresh_after_agent_completion", { environmentId: "e1" }) as string;
        expect(second).not.toBe(first);

        await invoke("disarm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
          armedAt: first,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(second);

        await expect(invoke("disarm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        })).rejects.toThrow("Expected armedAt to be a string");
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(second);

        await invoke("disarm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
          armedAt: second,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("snapshot reconciliation tracks environments with a stored PR", async () => {
    await withCommands(async (invoke, storage) => {
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: false,
        });

        const snapshot = await invoke("get_pr_monitor_state", {}) as {
          entries: Array<Record<string, unknown>>;
        };
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
          environmentId: "e1",
          mode: "normal",
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
        });
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("production detection uses branch discovery only until a PR URL is known", () => {
    const discovery = getPrMonitorDetectionRequest({
      environmentId: "e1",
      branch: "feature/pr-monitor",
      kind: "local",
      worktreePath: "/tmp/worktree",
      ready: true,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    });
    expect(discovery.args).toEqual([
      "pr", "list", "--head", "feature/pr-monitor", "--state", "all",
      "--limit", "30", "--json", "url,state,mergeable,updatedAt",
    ]);
    expect(discovery.knownPrUrl).toBeNull();

    const known = getPrMonitorDetectionRequest({
      environmentId: "e1",
      branch: "feature/pr-monitor",
      kind: "container",
      containerId: "container-1",
      ready: true,
      prUrl: "https://github.com/acme/repo/pull/7",
      prState: "open",
      hasMergeConflicts: null,
    });
    expect(known.args).toEqual([
      "pr", "view", "https://github.com/acme/repo/pull/7",
      "--json", "url,state,mergeable",
    ]);
    expect(known.shellCommand).toBe(
      "gh pr view 'https://github.com/acme/repo/pull/7' --json url,state,mergeable",
    );
    expect(parsePrMonitorDetectionResponse(known, JSON.stringify({
      url: "https://github.com/acme/repo/pull/7",
      state: "MERGED",
      mergeable: "UNKNOWN",
    }))).toEqual({
      url: "https://github.com/acme/repo/pull/7",
      state: "merged",
      hasMergeConflicts: null,
    });
    expect(parsePrMonitorDetectionResponse(known, JSON.stringify({
      url: "https://github.com/acme/repo/pull/7",
      state: "OPEN",
    }))).toEqual({
      url: "https://github.com/acme/repo/pull/7",
      state: "open",
      hasMergeConflicts: null,
    });
    expect(() => parsePrMonitorDetectionResponse(known, JSON.stringify({
      url: "https://github.com/acme/repo/pull/8",
      state: "OPEN",
      mergeable: "MERGEABLE",
    }))).toThrow("unexpected pull request metadata");

    const terminal = getPrMonitorDetectionRequest({
      environmentId: "e1",
      branch: "feature/pr-monitor",
      kind: "container",
      containerId: "container-1",
      ready: true,
      prUrl: "https://github.com/acme/repo/pull/7",
      prState: "merged",
      hasMergeConflicts: false,
    });
    expect(terminal.knownPrUrl).toBeNull();
    expect(terminal.args.slice(0, 4)).toEqual([
      "pr", "list", "--head", "feature/pr-monitor",
    ]);
  });

  test("production task lookup resolves direct and build-pipeline environment links", async () => {
    await withCommands(async (_invoke, storage) => {
      const direct = await storage.addKanbanTask("proj-1", "Direct", "");
      await storage.updateKanbanTask(direct.id, {
        environmentId: "e1",
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
      });

      await expect(findKanbanTaskForEnvironment(storage, "e1")).resolves.toMatchObject({
        taskId: direct.id,
        status: "backlog",
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
      });

      await storage.updateKanbanTask(direct.id, { environmentId: undefined });
      const pipelineTask = await storage.addKanbanTask("proj-1", "Pipeline", "");
      await storage.saveBuildPipeline("pipeline-1", "proj-1", "e1", 1, {
        taskId: pipelineTask.id,
        source: { type: "kanban" },
      });

      await expect(findKanbanTaskForEnvironment(storage, "e1")).resolves.toMatchObject({
        taskId: pipelineTask.id,
        status: "backlog",
      });
      await storage.deleteKanbanTask(pipelineTask.id);
      await expect(findKanbanTaskForEnvironment(storage, "e1")).resolves.toMatchObject({
        taskId: pipelineTask.id,
        status: null,
        prUrl: null,
      });
      await expect(findKanbanTaskForEnvironment(storage, "missing")).resolves.toBeNull();
    });
  });
});
