import { describe, expect, test } from "bun:test";
import { renderSuborkPrompt, renderSuborkRequestCarrier } from "@orkestrator/protocol/suborks";
import { workflowResultInstruction } from "@orkestrator/protocol/workflow-results";
import { createSuborkFakeModel, FAKE_MODEL_ID } from "./suborks-fake-model";
import { suborkRequest, targetPrompt } from "./suborks-fake-model-script";

const ORIGIN = "http://127.0.0.1:1";
const TAG = "QATAG0123ABCD";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const tools = (...names: string[]) =>
  names.map((name) => ({ type: "function", function: { name } }));

function completion(platform: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}/${platform}/v1/chat/completions`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const targetRequest = {
  messages: [
    {
      role: "user",
      content: `${renderSuborkPrompt(targetPrompt(TAG))}\n\n${workflowResultInstruction("subork-answer", KEY)}`,
    },
  ],
  tools: tools("submit_subork_answer"),
};

/**
 * Waits for the `count`th request to reach its hold: the fake records it just
 * before it starts waiting, so from then on only a release or an abort ends it.
 */
async function reachedHold(model: ReturnType<typeof createSuborkFakeModel>, count: number) {
  for (let turn = 0; model.counts.held.length < count; turn += 1) {
    if (turn > 1_000) throw new Error("the request never reached its hold");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("routing", () => {
  test("serves each platform's models and completions, and refuses anything else", async () => {
    const model = createSuborkFakeModel();
    const models = await model.fetch(new Request(`${ORIGIN}/opencode/v1/models`));
    expect(((await models.json()) as { data: Array<{ id: string }> }).data[0]?.id).toBe(
      FAKE_MODEL_ID,
    );
    expect((await model.fetch(completion("claude", {}))).status).toBe(404);
    expect(
      (await model.fetch(new Request(`${ORIGIN}/pi/v1/chat/completions`, { method: "GET" })))
        .status,
    ).toBe(404);
    expect(
      (await model.fetch(new Request(`${ORIGIN}/pi/v1/embeddings`, { method: "POST" }))).status,
    ).toBe(404);
    expect(model.counts.refused).toBe(3);
    expect(model.counts.completions).toEqual({});
  });

  test("answers a caller on the platform it arrived on, streamed or not", async () => {
    const model = createSuborkFakeModel();
    const carrier = {
      messages: [
        { role: "user", content: renderSuborkRequestCarrier(suborkRequest(["opencode"], TAG)) },
      ],
      tools: tools("orkestrator_ask_agents"),
    };
    const plain = await model.fetch(completion("pi", carrier));
    const message = (
      (await plain.json()) as {
        choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
      }
    ).choices[0]!.message;
    expect(message.tool_calls[0]?.function.name).toBe("orkestrator_ask_agents");
    const streamed = await model.fetch(completion("opencode", { ...carrier, stream: true }));
    expect(streamed.headers.get("content-type")).toBe("text/event-stream");
    expect(await streamed.text()).toEndWith("data: [DONE]\n\n");
    expect(model.counts.completions).toEqual({ pi: 1, opencode: 1 });
    expect(model.counts.toolCalls).toEqual({ orkestrator_ask_agents: 2 });
    expect(model.counts.turns.map((turn) => [turn.platform, turn.role, turn.tag])).toEqual([
      ["pi", "caller", TAG],
      ["opencode", "caller", TAG],
    ]);
  });
});

describe("refusals", () => {
  test("a declared body over the limit is 413", async () => {
    const model = createSuborkFakeModel();
    let read = false;
    // A Request recomputes its own length, so the declared one is set by hand,
    // as a client that sends the header before its body does.
    const declared = {
      method: "POST",
      url: `${ORIGIN}/pi/v1/chat/completions`,
      headers: new Headers({ "content-length": String(9 * 1024 * 1024) }),
      signal: new AbortController().signal,
      text: async () => {
        read = true;
        return "{}";
      },
    } as unknown as Request;
    expect((await model.fetch(declared)).status).toBe(413);
    expect(read, "the body was read").toBe(false);
    expect(model.counts.refused).toBe(1);
  });

  test("a body over the limit without a declared length is 400", async () => {
    const model = createSuborkFakeModel();
    const response = await model.fetch(completion("pi", " ".repeat(8 * 1024 * 1024 + 1)));
    expect(response.status).toBe(400);
    expect(model.counts.refused).toBe(1);
  });

  test("a body that is not JSON is 400 and counts no completion", async () => {
    const model = createSuborkFakeModel();
    expect((await model.fetch(completion("pi", "{not json"))).status).toBe(400);
    expect(model.counts.refused).toBe(1);
    expect(model.counts.completions).toEqual({});
  });

  test("a hold needs a QA tag", async () => {
    const model = createSuborkFakeModel();
    const response = await model.fetch(
      new Request(`${ORIGIN}/__hold?tag=nope`, { method: "POST" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("hold and release", () => {
  test("holds a tagged target until release, then answers it and counts its submit", async () => {
    const model = createSuborkFakeModel();
    const hold = await model.fetch(new Request(`${ORIGIN}/__hold?tag=${TAG}`, { method: "POST" }));
    expect(await hold.json()).toEqual({ holding: [TAG] });
    let answered = false;
    const pending = model.fetch(completion("pi", targetRequest)).then((response) => {
      answered = true;
      return response;
    });
    await reachedHold(model, 1);
    expect(answered).toBe(false);
    const calls = (await (await model.fetch(new Request(`${ORIGIN}/__calls`))).json()) as {
      held: string[];
      toolCalls: Record<string, number>;
    };
    expect(calls.held).toEqual([`pi ${TAG}`]);
    expect(calls.toolCalls).toEqual({});

    await model.fetch(new Request(`${ORIGIN}/__release`, { method: "POST" }));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(model.counts.toolCalls).toEqual({ submit_subork_answer: 1 });
    expect(model.counts.abandoned).toBe(0);

    // Release stops holding: the next request is answered at once.
    expect((await model.fetch(completion("pi", targetRequest))).status).toBe(200);
    expect(model.counts.held).toHaveLength(1);
  });

  test("a held request whose client goes away is abandoned and counts no submit", async () => {
    const model = createSuborkFakeModel();
    await model.fetch(new Request(`${ORIGIN}/__hold?tag=${TAG}`, { method: "POST" }));
    const client = new AbortController();
    const pending = model.fetch(completion("pi", targetRequest, { signal: client.signal }));
    await reachedHold(model, 1);
    client.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(model.counts.abandoned).toBe(1);
    expect(model.counts.toolCalls).toEqual({});
    // Nothing is left to release.
    await model.fetch(new Request(`${ORIGIN}/__release`, { method: "POST" }));
    expect(model.counts.abandoned).toBe(1);
  });

  test("only target requests carrying the held tag are held", async () => {
    const model = createSuborkFakeModel();
    await model.fetch(new Request(`${ORIGIN}/__hold?tag=QATAG99999999`, { method: "POST" }));
    expect((await model.fetch(completion("pi", targetRequest))).status).toBe(200);
    expect(model.counts.held).toEqual([]);
  });
});
