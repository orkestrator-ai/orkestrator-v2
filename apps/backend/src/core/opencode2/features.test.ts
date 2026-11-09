import { afterEach, describe, expect, test } from "bun:test";
import { PromptRejectedError } from "../agent-provider-contract.js";
import { FakeOpenCode2Server, fakeOpenCode2Model } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";

let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

function setup() {
  server = new FakeOpenCode2Server();
  provider = new OpenCode2Provider(server.client(), {
    monitorEvents: false,
    allowedModelProviders: async () => [],
  });
  return { server, provider };
}

const posts = (server: FakeOpenCode2Server, suffix: string) =>
  server.calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

describe("OpenCode 2.x models and effort", () => {
  test("a variant is sent as the model ref's variant; default sends none; an unknown one is refused", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x", {
      model: "fixture/fixture",
      effort: "high",
    });
    expect(server.sessions.get(id)?.model).toEqual({
      providerID: "fixture",
      id: "fixture",
      variant: "high",
    });
    await provider.send(id, "a", { requestId: "r1", model: "fixture/fixture", effort: "high" });
    expect(posts(server, "/model")).toHaveLength(0);
    await provider.send(id, "b", { requestId: "r2", model: "fixture/fixture", effort: "low" });
    await provider.send(id, "c", { requestId: "r3", model: "fixture/fixture", effort: "default" });
    expect(posts(server, "/model").map((call) => call.body)).toEqual([
      { model: { providerID: "fixture", id: "fixture", variant: "low" } },
      { model: { providerID: "fixture", id: "fixture" } },
    ]);
    const before = server.calls.length;
    await expect(
      provider.send(id, "d", { requestId: "r4", model: "fixture/fixture", effort: "max" }),
    ).rejects.toBeInstanceOf(PromptRejectedError);
    await expect(provider.send(id, "e", { requestId: "r5", model: "gone/model" })).rejects.toThrow(
      "cannot serve",
    );
    // Refused before anything was switched or prompted.
    expect(server.calls.slice(before).some((call) => call.method === "POST")).toBe(false);
  });

  test("a session state carries the catalogue, the session's selection and the agents", async () => {
    const { server, provider } = setup();
    server.models.push(fakeOpenCode2Model("opencode", "free", ["minimal"]));
    const id = await provider.createSession("build", "x", {
      model: "fixture/fixture",
      effort: "low",
    });
    const state = await provider.features.sessionState(id);
    expect(state.composer?.models.map((model) => model.id)).toEqual([
      "fixture/fixture",
      "opencode/free",
    ]);
    expect(state.composer).toMatchObject({
      selectedModelId: "fixture/fixture",
      selectedReasoningId: "low",
      selectedExecutionProfileId: "build",
    });
    expect(state).toMatchObject({ sessionModelId: "fixture/fixture", sessionReasoningId: "low" });
    expect(state.notices).toEqual([]);
  });
});

describe("OpenCode 2.x attachments", () => {
  test("images go inline and staged paths as file URIs resolved in the session directory", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    await provider.send(id, "look", {
      requestId: "r",
      images: [{ filename: "shot.png", data: "iVBORw0KGgo=" }],
      attachments: [
        { type: "file", path: "/work/notes.txt", filename: "notes.txt" },
        { type: "file", path: "docs/spec.md" },
      ],
    });
    const prompt = posts(server, "/prompt").at(-1)!;
    expect((prompt.body as { files: unknown }).files).toEqual([
      { uri: "data:image/png;base64,iVBORw0KGgo=", name: "shot.png" },
      { uri: "file:///work/notes.txt", name: "notes.txt" },
      { uri: "file:///work/docs/spec.md", name: "spec.md" },
    ]);
  });

  test("a traversal path is refused before anything is sent", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    await expect(
      provider.send(id, "x", {
        requestId: "r",
        attachments: [{ type: "file", path: "/work/../etc/passwd" }],
      }),
    ).rejects.toBeInstanceOf(PromptRejectedError);
    expect(posts(server, "/prompt")).toHaveLength(0);
  });
});

describe("OpenCode 2.x slash commands", () => {
  test("the catalogue is the server's list, executable as provider commands", async () => {
    const { provider } = setup();
    const catalogue = await provider.commandCatalogue();
    expect(catalogue).toMatchObject({ enhanced: true, status: "ready" });
    expect(catalogue.commands.map((command) => [command.name, command.executionKind])).toEqual([
      ["/init", "provider-command"],
      ["/review", "provider-command"],
    ]);
  });

  test("a selected command runs through /command, never as a prompt", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    const review = (await provider.commandCatalogue()).commands.find((c) => c.name === "/review")!;
    await provider.send(id, "/review HEAD", {
      requestId: "r",
      allowProviderCommands: true,
      command: {
        id: review.id!,
        name: review.name,
        executionKind: "provider-command",
        bindingRevision: review.bindingRevision,
        arguments: "HEAD",
      },
    });
    expect(posts(server, "/command").map((call) => call.body)).toEqual([
      { name: "review", text: "HEAD", delivery: "queue" },
    ]);
    expect(posts(server, "/prompt")).toHaveLength(0);
  });

  test("typed text resolves only an advertised name; a gone selection is refused", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    await provider.send(id, "/init", { requestId: "r1", allowProviderCommands: true });
    expect(posts(server, "/command").map((call) => (call.body as { name: string }).name)).toEqual([
      "init",
    ]);
    // Not advertised: an ordinary prompt, as typed.
    await provider.send(id, "/unknown thing", { requestId: "r2", allowProviderCommands: true });
    expect((posts(server, "/prompt").at(-1)!.body as { text: string }).text).toBe("/unknown thing");
    // Literal intent: never a command.
    await provider.send(id, "/init", { requestId: "r3", allowProviderCommands: false });
    expect(posts(server, "/command")).toHaveLength(1);
    server.commands = [];
    provider.refreshCatalog();
    const before = server.calls.length;
    await expect(
      provider.send(id, "/review", {
        requestId: "r4",
        allowProviderCommands: true,
        command: {
          id: "opencode:review",
          name: "/review",
          executionKind: "provider-command",
          arguments: "",
        },
      }),
    ).rejects.toThrow("no longer available");
    // The catalogue was re-read (GET /api/command); nothing was posted.
    expect(server.calls.slice(before).some((call) => call.method === "POST")).toBe(false);
  });
});

describe("OpenCode 2.x Plan/Build", () => {
  test("the chosen agent is switched once; an unknown one is refused", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    await provider.send(id, "a", { requestId: "r1", executionAgent: "build" });
    expect(posts(server, "/agent")).toHaveLength(0);
    await provider.send(id, "b", { requestId: "r2", executionAgent: "plan" });
    await provider.send(id, "c", { requestId: "r3", executionAgent: "plan" });
    expect(posts(server, "/agent").map((call) => call.body)).toEqual([{ agent: "plan" }]);
    await expect(
      provider.send(id, "d", { requestId: "r4", executionAgent: "general" }),
    ).rejects.toBeInstanceOf(PromptRejectedError);
  });
});

describe("OpenCode 2.x session actions", () => {
  test("compact queues a compaction", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    expect(await provider.performSessionAction(id, { kind: "compact" })).toEqual({
      outcome: "applied",
    });
    expect(posts(server, "/compact").map((call) => call.body)).toEqual([{ delivery: "queue" }]);
  });

  test("undo hides the newest turn until redo; a prompt then commits it", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    await provider.send(id, "first", { requestId: "r1" });
    server.finishRun(id);
    await provider.send(id, "second", { requestId: "r2" });
    server.finishRun(id);
    const texts = async () =>
      ((await provider!.messages(id)) as Array<{ type: string; text?: string }>)
        .filter((row) => row.type === "user")
        .map((row) => row.text);
    expect(await texts()).toEqual(["first", "second"]);
    await provider.performSessionAction(id, { kind: "undo" });
    expect(await texts()).toEqual(["first"]);
    const native = await provider.transcriptSnapshot(id, { limit: 20, targetBytes: 1e6 });
    expect(native).toMatchObject({ complete: true });
    expect(JSON.stringify(native)).not.toContain('"second"');
    expect(JSON.stringify(await provider.interactiveState(id))).not.toContain('"second"');
    expect((await provider.features.sessionState(id)).notices).toHaveLength(1);
    // Undo again goes one turn further back.
    await provider.performSessionAction(id, { kind: "undo" });
    expect(await texts()).toEqual([]);
    await provider.performSessionAction(id, { kind: "redo" });
    expect(await texts()).toEqual(["first", "second"]);
    expect(JSON.stringify(await provider.interactiveState(id))).toContain('"second"');
    await provider.performSessionAction(id, { kind: "undo" });
    await provider.send(id, "replacement", { requestId: "r3" });
    expect(await texts()).toEqual(["first", "replacement"]);
    // The request evidence never hides behind a staged revert.
    expect(await provider.dispatchStatus(id, "r3")).toBe("dispatched");
  });

  test("undo while a turn runs is refused with the reason", async () => {
    const { provider } = setup();
    const id = await provider.createSession("build", "x");
    await provider.send(id, "working", { requestId: "r1" });
    await expect(provider.performSessionAction(id, { kind: "undo" })).rejects.toThrow(
      "waits for the running turn",
    );
    await expect(provider.performSessionAction(id, { kind: "redo" })).rejects.toThrow(
      "waits for the running turn",
    );
  });

  test("fork, title, archive and resume", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x", { model: "fixture/fixture" });
    await provider.send(id, "first", { requestId: "r1" });
    server.finishRun(id);
    await provider.setSessionTitle(id, "Named");
    expect(server.sessions.get(id)?.title).toBe("Named");
    const firstUser = server.sessions.get(id)!.rows.find((row) => row.type === "user")!.id;
    const fork = await provider.forkSession(id, firstUser);
    expect(fork).toMatchObject({
      title: "Named (fork #1)",
      controls: { modelId: "fixture/fixture" },
    });
    expect(server.sessions.get(fork.sessionId)?.rows).toHaveLength(0);
    await expect(provider.forkSession(id, "not-a-message")).rejects.toBeInstanceOf(
      PromptRejectedError,
    );
    const listed = await provider.listResumableSessions();
    expect(listed.map((entry) => entry.sessionId)).toEqual([
      `opencode2:${fork.sessionId}`,
      `opencode2:${id}`,
    ]);
    await provider.setResumableSessionArchived(`opencode2:${fork.sessionId}`, true);
    expect((await provider.listResumableSessions()).map((entry) => entry.sessionId)).toEqual([
      `opencode2:${id}`,
    ]);
    await expect(provider.resumeSession(`opencode2:${fork.sessionId}`)).rejects.toThrow("archived");
    expect(await provider.resumeSession(`opencode2:${id}`)).toBe(id);
    await expect(provider.resumeSession("opencode2:ses_gone")).rejects.toThrow("not found");
  });
});

describe("OpenCode 2.x status reads", () => {
  test("sign-in status comes from the 2.x server's providers", async () => {
    const { provider } = setup();
    expect(await provider.authStatus()).toMatchObject({
      state: "signed-in",
      providers: [{ id: "fixture", state: "signed-in" }],
    });
  });

  test("runtime health counts the current to-dos and commands", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    server.sessions.get(id)!.rows.push({
      id: "msg_000000000099fake",
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "t1",
          name: "todowrite",
          state: { status: "completed", input: { todos: [{ content: "a", status: "pending" }] } },
        },
      ],
      time: { created: 1 },
    });
    expect(await provider.runtimeHealth(id)).toMatchObject({
      summary: { todos: 1, commands: 2 },
      authoritative: true,
    });
  });
});
