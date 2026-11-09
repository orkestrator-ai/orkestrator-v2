import { afterEach, describe, expect, test } from "bun:test";
import { AmbiguousPromptDispatchError, PromptRejectedError } from "../agent-provider-contract.js";
import { FakeOpenCode2Server, fakeOpenCode2Model } from "./fake-server.test-support.js";
import { OpenCode2Provider, parseOpenCode2Model } from "./provider.js";

let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

function setup(options: { monitorEvents?: boolean } = {}) {
  server = new FakeOpenCode2Server();
  provider = new OpenCode2Provider(server.client(), {
    monitorEvents: options.monitorEvents ?? false,
    monitorRetryMs: 5,
  });
  return { server, provider };
}

describe("parseOpenCode2Model", () => {
  test("splits provider/model on the first slash only", () => {
    expect(parseOpenCode2Model("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude",
    });
    expect(parseOpenCode2Model("bare")).toBeUndefined();
    expect(parseOpenCode2Model("/x")).toBeUndefined();
    expect(parseOpenCode2Model("x/")).toBeUndefined();
  });
});

describe("OpenCode2Provider", () => {
  test("creates a session with its model and dispatches a prompt carrying the request id", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "Implement", { model: "fixture/fixture" });
    expect(server.sessions.get(id)?.model).toEqual({ providerID: "fixture", id: "fixture" });
    await provider.send(id, "hello", { requestId: "req-1", model: "fixture/fixture" });
    // The model was already applied at creation: no switch call.
    expect(
      server.calls.filter((call) => call.method === "POST" && call.path.endsWith("/model")),
    ).toHaveLength(0);
    const prompt = server.calls.find((call) => call.path.endsWith("/prompt"))!;
    expect(prompt.body).toMatchObject({
      text: "hello",
      delivery: "queue",
      metadata: { orkestrator: { requestId: "req-1" } },
    });
    expect(String((prompt.body as { id: string }).id)).toMatch(/^msg_[0-9a-f]{12}/);
    expect(await provider.dispatchStatus(id, "req-1")).toBe("dispatched");
    expect(await provider.dispatchStatus(id, "never-sent")).toBe("unknown");
  });

  test("a model change is applied before the prompt", async () => {
    const { server, provider } = setup();
    server.models.push(fakeOpenCode2Model("openai", "gpt-5"));
    const id = await provider.createSession("build", "x");
    await provider.send(id, "hi", { requestId: "r", model: "openai/gpt-5" });
    // The session's switch and prompt only (`GET /api/model` is the catalogue read).
    const paths = server.calls
      .filter((call) => call.method === "POST" && call.path.startsWith("/api/session/"))
      .map((call) => call.path.split("/").at(-1))
      .filter((path) => path === "model" || path === "prompt");
    expect(paths).toEqual(["model", "prompt"]);
    expect(server.sessions.get(id)?.model).toEqual({ providerID: "openai", id: "gpt-5" });
  });

  test("a 4xx refusal is definitive: rejected, and later reported absent", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    server.failNextPrompt = { status: 400, body: { _tag: "InvalidRequestError", message: "no" } };
    await expect(provider.send(id, "hi", { requestId: "r1" })).rejects.toBeInstanceOf(
      PromptRejectedError,
    );
    expect(await provider.dispatchStatus(id, "r1")).toBe("absent");
  });

  test("a 5xx proves nothing: the dispatch is ambiguous and stays unknown", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    server.failNextPrompt = "network";
    await expect(provider.send(id, "hi", { requestId: "r2" })).rejects.toBeInstanceOf(
      AmbiguousPromptDispatchError,
    );
    expect(await provider.dispatchStatus(id, "r2")).toBe("unknown");
  });

  test("a command the server does not list is refused before anything is sent", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    server.commands = [];
    await expect(
      provider.send(id, "hi", {
        requestId: "r",
        command: { name: "review" } as never,
      }),
    ).rejects.toThrow("is not an OpenCode command");
    expect(
      server.calls.some((call) => call.path.endsWith("/prompt") || call.path.endsWith("/command")),
    ).toBe(false);
  });

  test("activity reads one active-session map; a parked question reads as waiting", async () => {
    const { server, provider } = setup();
    const a = await provider.createSession("build", "a");
    const b = await provider.createSession("build", "b");
    await provider.send(a, "go", { requestId: "ra" });
    expect(await provider.activityBatch([a, b])).toEqual(
      new Map([
        [a, "working"],
        [b, "idle"],
      ]),
    );
    server.sessions.get(a)!.forms.push({ id: "frm_1", sessionID: a, title: "Q", fields: {} });
    expect(await provider.status(a)).toBe("blocked");
    server.finishRun(a);
    expect(await provider.status(a)).toBe("idle");
    expect(await provider.status(b)).toBe("idle");
    // Histories were never read for activity.
    expect(server.calls.some((call) => call.path.endsWith("/message"))).toBe(false);
  });

  test("a steer aimed at the running run is delivered into it", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    await provider.send(id, "work", { requestId: "r" });
    const run = await provider.activeSteerRun(id);
    expect(run.state).toBe("running");
    const runId = (run as { runId: string }).runId;
    const outcome = await provider.performSessionAction(id, {
      kind: "steer",
      text: "also do this",
      requestId: "steer-1",
      expectedRunId: runId,
    });
    expect(outcome).toEqual({ outcome: "applied", requestId: "steer-1" });
    expect(server.calls.at(-1)?.body).toMatchObject({
      delivery: "steer",
      metadata: { orkestrator: { requestId: "steer-1", steer: true } },
    });
    expect(await provider.steerStatus(id, "steer-1")).toBe("dispatched");
  });

  test("a steer aimed at a run that has settled is not sent", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    await provider.send(id, "work", { requestId: "r" });
    const runId = ((await provider.activeSteerRun(id)) as { runId: string }).runId;
    server.finishRun(id);
    const before = server.calls.length;
    expect(
      await provider.performSessionAction(id, {
        kind: "steer",
        text: "too late",
        requestId: "s-idle",
        expectedRunId: runId,
      }),
    ).toEqual({ outcome: "idle" });
    // A new run has started since: the old run id no longer matches.
    await provider.send(id, "next", { requestId: "r2" });
    expect(
      await provider.performSessionAction(id, {
        kind: "steer",
        text: "too late",
        requestId: "s-mismatch",
        expectedRunId: runId,
      }),
    ).toEqual({ outcome: "mismatch" });
    const steers = server.calls
      .slice(before)
      .filter((call) => (call.body as { delivery?: string } | undefined)?.delivery === "steer");
    expect(steers).toHaveLength(0);
  });

  test("abort interrupts and denies parked permissions and questions", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    await provider.send(id, "work", { requestId: "r" });
    const session = server.sessions.get(id)!;
    session.permissions.push({ id: "per_1", sessionID: id, action: "shell", resources: ["ls"] });
    session.forms.push({ id: "frm_1", sessionID: id, title: "Q", fields: {} });
    // Abort with the run still open: the fake interrupts it on request.
    await provider.abort(id);
    expect(session.running).toBe(false);
    expect(session.replies).toEqual([
      { kind: "permission", id: "per_1", decision: "reject" },
      { kind: "form", id: "frm_1", decision: "rejected" },
    ]);
  });

  test("close stops the session without deleting it", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "x");
    await provider.closeSession(id);
    expect(
      server.calls.some((call) => call.method === "DELETE" && call.path === `/api/session/${id}`),
    ).toBe(false);
    expect(server.sessions.has(id)).toBe(true);
  });

  test("live events invalidate cached activity; dispose stops the monitor", async () => {
    const { server, provider } = setup({ monitorEvents: true });
    const id = await provider.createSession("build", "x");
    await provider.send(id, "work", { requestId: "r" });
    expect(await provider.activity(id)).toBe("working");
    server.finishRun(id);
    // The settle event marks the session dirty, so the next read goes to the server.
    for (let attempt = 0; attempt < 50 && (await provider.activity(id)) !== "idle"; attempt++) {
      await Bun.sleep(10);
    }
    expect(await provider.activity(id)).toBe("idle");
    await provider.dispose();
    expect(provider.observationStreamLive()).toBe(false);
  });
});
