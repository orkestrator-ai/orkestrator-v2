import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import {
  nativeTabLogicalSessionKey,
  type PublicSessionCommandList,
} from "@orkestrator/protocol/public-api-resources";
import { AmbiguousPromptDispatchError, PromptRejectedError } from "../agent-provider-contract.js";
import type { ProviderCommandCatalogue, ProviderSendOptions } from "../native-agent-provider.js";
import { nativePromptQueueKey } from "./prompt-delivery.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";
import type { PublicApiHarness } from "./test-support.js";

/**
 * The CLI command surface added after the first release: selected slash
 * commands and explicit literal intent, durable enqueue for busy sessions,
 * and prompt attachments. Real storage, the real native-agent service and
 * dispatch journal, and a controlled provider; nothing spends tokens.
 */

afterEach(cleanupSessionHarnesses);

function command(name: string, extra: Partial<NativeAgentSlashCommand> = {}) {
  return {
    name,
    source: "project" as const,
    id: `claude:${name}`,
    executionKind: "provider-prompt" as const,
    bindingRevision: `rev:${name}`,
    description: `Run ${name}`,
    ...extra,
  };
}

async function receipt(harness: PublicApiHarness, operationId: string): Promise<PublicReceipt> {
  const response = await harness.call("run.get", { operationId });
  if (!response.receipt) throw new Error(`run.get failed: ${JSON.stringify(response)}`);
  return response.receipt;
}

/** An idle session whose provider reports a command catalogue. */
async function idleSession(catalogue: NativeAgentSlashCommand[] = [command("/review")]) {
  const context = await setup();
  const { harness, service, stub } = context;
  let commands = catalogue;
  Object.assign(stub.provider, {
    commandCatalogue: async (): Promise<ProviderCommandCatalogue> => ({
      enhanced: true,
      status: "ready",
      commands,
    }),
  });
  const started = await harness.call<{ sessionId: string; tabId: string; runId: string }>(
    "session.start",
    { environmentId: "env-1", agent: "claude", prompt: "hello" },
    { requestId: "start" },
  );
  if (!started.ok) throw new Error(started.error.message);
  stub.setStatus(async () => "idle");
  setActivity(service, "claude", started.result.tabId, stub.sends[0]!.sessionId, "idle");
  expect((await receipt(harness, started.result.runId)).state).toBe("succeeded");
  const sendOptions = () =>
    (stub.provider.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => call[2] as ProviderSendOptions,
    );
  return {
    ...context,
    sessionId: started.result.sessionId,
    tabId: started.result.tabId,
    providerSessionId: stub.sends[0]!.sessionId,
    sendOptions,
    setCommands(next: NativeAgentSlashCommand[]) {
      commands = next;
    },
  };
}

describe("session.commands", () => {
  test("lists the catalogue with IDs and policy, never the private binding", async () => {
    const { harness, sessionId } = await idleSession([
      command("/review", { argumentHint: "<target>", inputPolicy: { arguments: "required" } }),
      command("/gone", {
        availability: { state: "unavailable", reason: "disabled", message: "Disabled here" },
      }),
    ]);
    const listed = await harness.call<PublicSessionCommandList>("session.commands", {
      sessionId,
      refresh: true,
    });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.result.catalogue.status).toBe("ready");
    const review = listed.result.commands.find((entry) => entry.name === "/review");
    expect(review).toEqual({
      id: "claude:/review",
      name: "/review",
      aliases: [],
      description: "Run /review",
      argumentHint: "<target>",
      source: "project",
      bindingRevision: "rev:/review",
      available: true,
      unavailableReason: null,
      arguments: "required",
      busy: null,
    });
    expect(listed.result.commands.find((entry) => entry.name === "/gone")).toMatchObject({
      available: false,
      unavailableReason: "Disabled here",
    });
    // Orkestrator's own session action is listed; `/steer` (live turns only) is not.
    expect(listed.result.commands.map((entry) => entry.id)).toContain("orkestrator:compact");
    expect(listed.result.commands.map((entry) => entry.id)).not.toContain("orkestrator:steer");
    expect(JSON.stringify(listed.result)).not.toContain("executionKind");
    // The cached catalogue is served without asking the provider again.
    const cached = await harness.call<PublicSessionCommandList>("session.commands", { sessionId });
    expect(cached.ok && cached.result.commands.length).toBe(listed.result.commands.length);
  });
});

describe("session.command", () => {
  test("submits a selection with verbatim arguments through the dispatch journal", async () => {
    const { harness, stub, sessionId, sendOptions } = await idleSession();
    const response = await harness.call<{ runId: string; commandId: string }>(
      "session.command",
      { sessionId, command: "review", arguments: "the open  diff" },
      { requestId: "cmd-1" },
    );
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    expect(response.result.commandId).toBe("claude:/review");
    expect(response.receipt?.dispatch?.state).toBe("accepted");
    expect(stub.sends.at(-1)).toMatchObject({
      prompt: "/review the open  diff",
      requestId: response.result.runId,
    });
    expect(sendOptions().at(-1)?.command).toMatchObject({
      id: "claude:/review",
      bindingRevision: "rev:/review",
      arguments: "the open  diff",
    });
    // Same key replays without a second send; changed arguments conflict.
    const sent = stub.sends.length;
    const replay = await harness.call(
      "session.command",
      { sessionId, command: "review", arguments: "the open  diff" },
      { requestId: "cmd-1" },
    );
    expect(replay.receipt?.replayed).toBe(true);
    const conflict = await harness.call(
      "session.command",
      { sessionId, command: "review", arguments: "something else" },
      { requestId: "cmd-1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
    expect(stub.sends).toHaveLength(sent);
  });

  test("refuses missing, ambiguous, changed, unavailable and mis-argued commands before admission", async () => {
    const { harness, stub, sessionId } = await idleSession([
      command("/review", { inputPolicy: { arguments: "required" } }),
      command("/plain", { inputPolicy: { arguments: "none" } }),
      command("/twin", { id: "claude:project:/twin" }),
      command("/twin", { id: "claude:user:/twin", source: "user" }),
      command("/off", { availability: { state: "unavailable", message: "Turned off" } }),
    ]);
    await harness.call("session.commands", { sessionId, refresh: true });
    const sent = stub.sends.length;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ command: "/nope" }, "not-found"],
      [{ command: "/twin" }, "ambiguous-target"],
      [{ command: "/review", arguments: "x", expectedBindingRevision: "old" }, "revision-conflict"],
      [{ command: "/off" }, "capability-unavailable"],
      [{ command: "/review" }, "invalid-input"],
      [{ command: "/plain", arguments: "x" }, "invalid-input"],
    ];
    for (const [index, [input, code]] of cases.entries()) {
      const response = await harness.call(
        "session.command",
        { sessionId, ...input },
        { requestId: `refused-${index}` },
      );
      expect({ input, code: response.ok ? null : (response.error.code as string) }).toEqual({
        input,
        code,
      });
      expect(response.receipt).toBeUndefined();
    }
    // An exact ID resolves a name shared by two commands.
    const byId = await harness.call(
      "session.command",
      { sessionId, command: "claude:user:/twin" },
      { requestId: "by-id" },
    );
    expect(byId.ok).toBe(true);
    expect(stub.sends).toHaveLength(sent + 1);
  });

  test("a selection that vanishes before dispatch fails the run and sends nothing", async () => {
    const { harness, service, stub, sessionId, tabId, setCommands } = await idleSession();
    await harness.call("session.commands", { sessionId, refresh: true });
    const listedAt = service.cachedProjectionSnapshot.bind(service);
    const stale = listedAt("env-1", "claude", nativeTabLogicalSessionKey("env-1", tabId));
    expect(stale?.slashCommands?.some((entry) => entry.name === "/review")).toBe(true);
    // The provider drops /review; admission still sees the listing it was chosen from.
    setCommands([command("/other")]);
    await harness.call("session.commands", { sessionId, refresh: true });
    Object.assign(service, { cachedProjectionSnapshot: () => stale });
    const sent = stub.sends.length;
    const response = await harness.call(
      "session.command",
      { sessionId, command: "claude:/review" },
      { requestId: "vanished" },
    );
    expect(!response.ok && response.error.code).toBe("operation-failed");
    expect(response.receipt?.state).toBe("failed");
    expect(response.receipt?.dispatch?.state).toBe("rejected");
    expect(stub.sends).toHaveLength(sent);
  });
});

describe("literal intent", () => {
  test("--literal sends slash text with provider commands disabled", async () => {
    const { harness, stub, sessionId, sendOptions } = await idleSession();
    const literal = await harness.call(
      "session.prompt",
      { sessionId, prompt: "/srv/data is a path, not a command", literal: true },
      { requestId: "literal-1" },
    );
    expect(literal.ok).toBe(true);
    expect(stub.sends.at(-1)?.prompt).toBe("/srv/data is a path, not a command");
    expect(sendOptions().at(-1)?.allowProviderCommands).toBe(false);
    expect(sendOptions().at(-1)?.command).toBeUndefined();
    // literal is part of the request's intent.
    const conflict = await harness.call(
      "session.prompt",
      { sessionId, prompt: "/srv/data is a path, not a command" },
      { requestId: "literal-1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
  });

  test("--literal text a provider would still run as a command is refused, not sent", async () => {
    // Claude reads a leading known command itself and has no "plain text"
    // switch, so literal intent is refused rather than silently run.
    const { harness, stub, sessionId } = await idleSession();
    const sent = stub.sends.length;
    const refused = await harness.call(
      "session.prompt",
      { sessionId, prompt: "/review is just a word here", literal: true },
      { requestId: "literal-refused" },
    );
    expect(!refused.ok && refused.error.code).toBe("operation-failed");
    expect(refused.receipt?.dispatch?.state).toBe("rejected");
    expect(stub.sends).toHaveLength(sent);
  });

  test("without --literal a native tab still treats a leading /name as typed", async () => {
    const { harness, sessionId, sendOptions } = await idleSession();
    const typed = await harness.call(
      "session.prompt",
      { sessionId, prompt: "/review now" },
      { requestId: "typed-1" },
    );
    expect(typed.ok).toBe(true);
    expect(sendOptions().at(-1)?.command).toMatchObject({ id: "claude:/review" });
  });
});

describe("session.start delivery options", () => {
  test("a first prompt can be literal and carry attachments", async () => {
    const { harness, stub } = await setup();
    const started = await harness.call<{ runId: string; sessionId: string }>(
      "session.start",
      {
        environmentId: "env-1",
        agent: "claude",
        prompt: "/srv is a directory",
        literal: true,
        attachments: [{ name: "a.txt", dataBase64: Buffer.from("A\n").toString("base64") }],
      },
      { requestId: "start-literal" },
    );
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    const [, prompt, options] = (
      stub.provider.send as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1)! as [string, string, ProviderSendOptions];
    expect(prompt).toBe("/srv is a directory");
    expect(options.allowProviderCommands).toBe(false);
    expect(options.attachments).toEqual([
      expect.objectContaining({
        type: "file",
        filename: "a.txt",
        path: path.join(
          harness.root,
          ".orkestrator",
          "prompt-attachments",
          started.result.runId,
          "01-a.txt",
        ),
      }),
    ]);
  });
});

describe("recovery keeps command intent", () => {
  test("run retry of a parked typed-command prompt replays the same selection", async () => {
    const { harness, stub, sessionId, sendOptions } = await idleSession();
    stub.setSend(async () => {
      throw new AmbiguousPromptDispatchError("response lost");
    });
    const parked = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "/review the diff" },
      { requestId: "typed-parked" },
    );
    expect(parked.receipt?.state).toBe("unknown");
    expect(sendOptions().at(-1)?.command).toMatchObject({ id: "claude:/review" });
    stub.setSend(async () => undefined);
    const retried = await harness.call(
      "run.retry",
      { operationId: parked.receipt!.operationId },
      { requestId: "typed-retry" },
    );
    expect(retried.ok).toBe(true);
    expect(stub.sends.at(-1)).toMatchObject({
      prompt: "/review the diff",
      requestId: parked.receipt!.operationId,
    });
    // The retry carries the resolved selection, never re-resolved text.
    expect(sendOptions().at(-1)?.command).toMatchObject({
      id: "claude:/review",
      bindingRevision: "rev:/review",
    });
  });
});

describe("durable enqueue", () => {
  async function busySession() {
    const context = await idleSession();
    context.stub.setStatus(async () => "running");
    setActivity(context.service, "claude", context.tabId, context.providerSessionId, "working");
    const queueKey = nativePromptQueueKey(
      "claude",
      nativeTabLogicalSessionKey("env-1", context.tabId),
    );
    return { ...context, queueKey };
  }

  test("queues behind a busy session under the run's own ID, then settles from the journal", async () => {
    const { harness, service, stub, sessionId, tabId, providerSessionId, queueKey } =
      await busySession();
    const refused = await harness.call(
      "session.prompt",
      { sessionId, prompt: "after this" },
      { requestId: "q-refused" },
    );
    expect(!refused.ok && refused.error.code).toBe("busy");
    const sent = stub.sends.length;
    const queued = await harness.call<{ runId: string; queued: boolean }>(
      "session.prompt",
      { sessionId, prompt: "after this", enqueue: true },
      { requestId: "q-1" },
    );
    if (!queued.ok) throw new Error(queued.error.message);
    const runId = queued.result.runId;
    expect(queued.receipt).toMatchObject({ state: "running", stage: "queued" });
    expect(queued.receipt?.dispatch?.state).toBe("pending");
    const queue = await harness.storage.getPromptQueue(queueKey);
    expect(queue?.messages).toEqual([
      expect.objectContaining({ id: runId, requestId: runId, text: "after this" }),
    ]);
    // A replay finds the same item; nothing is queued twice.
    const replay = await harness.call(
      "session.prompt",
      { sessionId, prompt: "after this", enqueue: true },
      { requestId: "q-1" },
    );
    expect(replay.receipt?.operationId).toBe(runId);
    expect((await harness.storage.getPromptQueue(queueKey))?.messages).toHaveLength(1);
    expect((await receipt(harness, runId)).dispatch?.state).toBe("pending");

    // The session frees up; the backend drainer sends it.
    stub.setStatus(async () => "idle");
    setActivity(service, "claude", tabId, providerSessionId, "idle");
    await service.drainPromptQueueForSession({
      agent: "claude",
      logicalSessionKey: nativeTabLogicalSessionKey("env-1", tabId),
    });
    expect(stub.sends).toHaveLength(sent + 1);
    expect(stub.sends.at(-1)).toMatchObject({ prompt: "after this", requestId: runId });
    const dispatched = await receipt(harness, runId);
    expect(dispatched.dispatch?.state).toBe("accepted");
  });

  test("a provider refusal at dequeue fails the run with the provider's reason", async () => {
    const { harness, service, stub, sessionId, tabId, providerSessionId } = await busySession();
    const queued = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "plain follow-up", enqueue: true, literal: true },
      { requestId: "q-refuse" },
    );
    if (!queued.ok) throw new Error(queued.error.message);
    stub.setSend(async () => {
      throw new PromptRejectedError("Pi would read this as a command (409)");
    });
    stub.setStatus(async () => "idle");
    setActivity(service, "claude", tabId, providerSessionId, "idle");
    await service.drainPromptQueueForSession({
      agent: "claude",
      logicalSessionKey: nativeTabLogicalSessionKey("env-1", tabId),
    });
    const settled = await receipt(harness, queued.result.runId);
    expect(settled.state).toBe("failed");
    expect(settled.dispatch?.state).toBe("rejected");
    expect(settled.error?.message).toContain("409");
  });

  test("a queued prompt removed before it was sent cancels its run", async () => {
    const { harness, sessionId, queueKey } = await busySession();
    const queued = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "never mind", enqueue: true },
      { requestId: "q-remove" },
    );
    if (!queued.ok) throw new Error(queued.error.message);
    await harness.storage.removePromptQueueMessage(queueKey, "env-1", queued.result.runId);
    const settled = await receipt(harness, queued.result.runId);
    expect(settled.state).toBe("cancelled");
    expect(settled.dispatch?.state).toBe("not-sent");
  });

  test("a selected command can be queued and keeps its selection", async () => {
    const { harness, sessionId, queueKey } = await busySession();
    const queued = await harness.call<{ runId: string }>(
      "session.command",
      { sessionId, command: "/review", arguments: "later", enqueue: true },
      { requestId: "q-cmd" },
    );
    if (!queued.ok) throw new Error(queued.error.message);
    expect((await harness.storage.getPromptQueue(queueKey))?.messages).toEqual([
      expect.objectContaining({
        text: "/review later",
        command: { kind: "selected", commandId: "claude:/review", bindingRevision: "rev:/review" },
      }),
    ]);
  });
});

describe("prompt attachments", () => {
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
    "hex",
  ).toString("base64");

  test("stages files in the workspace and sends their workspace paths", async () => {
    const { harness, sessionId, sendOptions } = await idleSession();
    const response = await harness.call<{ runId: string }>(
      "session.prompt",
      {
        sessionId,
        prompt: "look at these",
        attachments: [
          { name: "shot.png", dataBase64: PNG },
          { name: "notes.txt", dataBase64: Buffer.from("hello\n").toString("base64") },
        ],
      },
      { requestId: "attach-1" },
    );
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    const attachments = sendOptions().at(-1)?.attachments ?? [];
    expect(attachments.map((attachment) => attachment.type)).toEqual(["image", "file"]);
    const directory = path.join(
      harness.root,
      ".orkestrator",
      "prompt-attachments",
      response.result.runId,
    );
    expect((await fs.readdir(directory)).sort()).toEqual(["01-shot.png", "02-notes.txt"]);
    expect(await fs.readFile(path.join(directory, "02-notes.txt"), "utf8")).toBe("hello\n");
    expect(attachments[0]!.path).toBe(path.join(directory, "01-shot.png"));
    // The operation record holds no file content.
    const stored = JSON.stringify(await harness.storage.getPublicOperation(response.result.runId));
    expect(stored).not.toContain(PNG);
    // Different bytes under the same key conflict.
    const conflict = await harness.call(
      "session.prompt",
      {
        sessionId,
        prompt: "look at these",
        attachments: [
          { name: "shot.png", dataBase64: PNG },
          { name: "notes.txt", dataBase64: Buffer.from("changed\n").toString("base64") },
        ],
      },
      { requestId: "attach-1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
  });

  test("refuses paths, bad data, oversize payloads and unsupported types before admission", async () => {
    const { harness, sessionId } = await idleSession();
    const big = Buffer.alloc(600 * 1024, 1).toString("base64");
    const cases: Array<[unknown, string]> = [
      [[{ name: "/etc/passwd", dataBase64: PNG }], "invalid-input"],
      [[{ name: "../up.txt", dataBase64: PNG }], "invalid-input"],
      [[{ name: "a.txt", dataBase64: "not base64!" }], "invalid-input"],
      [[{ name: "a.txt", type: "image", dataBase64: "aGVsbG8=" }], "invalid-input"],
      [[{ name: "a.txt", dataBase64: big }], "input-too-large"],
      [[{ name: "a.txt", path: "/x", dataBase64: PNG }], "invalid-input"],
      [
        Array.from({ length: 9 }, (_, i) => ({ name: `${i}.txt`, dataBase64: PNG })),
        "input-too-large",
      ],
    ];
    for (const [index, [attachments, code]] of cases.entries()) {
      const response = await harness.call(
        "session.prompt",
        { sessionId, prompt: "x", attachments },
        { requestId: `bad-${index}` },
      );
      expect({ index, code: response.ok ? null : (response.error.code as string) }).toEqual({
        index,
        code,
      });
      expect(response.receipt).toBeUndefined();
    }
  });
});
