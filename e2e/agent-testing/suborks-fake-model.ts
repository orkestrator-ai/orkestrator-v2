/**
 * A loopback model for the subork specs (`suborks-live.spec.ts`,
 * `suborks-restart-live.spec.ts`, 4340 (retired) tasks 1 and 4), so Pi and
 * OpenCode callers and targets run on a profile's real bridges and servers
 * with no login and nothing billed. Run with Bun (specs run under Node):
 * `bun suborks-fake-model.ts`. It prints its origin
 * (`http://127.0.0.1:<port>`) as the first stdout line.
 *
 * It serves OpenAI chat completions (`POST /<platform>/v1/chat/completions`)
 * under one base path per platform, `/pi/v1` and `/opencode/v1`, so a target
 * knows which agent it is answering as. What it answers is
 * `suborks-fake-model-script.ts`.
 *
 * Control routes, loopback only:
 * - `GET /__calls`: counts only (completions, refusals, tool calls by name
 *   whose answer was sent, held and abandoned requests, and the facts the
 *   script reports for each request). No prompt, header, body or argument is
 *   kept.
 * - `POST /__hold?tag=<tag>`: every target request carrying that tag is held
 *   open, with no answer, until `POST /__release` (or the server stops), so a
 *   spec can kill the backend while a subork's turn is in flight. Release
 *   answers the held requests and stops holding; later requests are answered
 *   at once. A held request whose client disconnects first (the killed
 *   backend's) ends then, is counted as `abandoned`, and its tool call is not
 *   counted.
 */
import {
  FAKE_REPLY,
  SCRIPTED_PLATFORMS,
  scriptedTurn,
  type FakeStep,
  type TurnFacts,
} from "./suborks-fake-model-script";

export const FAKE_MODEL_ID = "subqa-1";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED = 1_000;

type Platform = (typeof SCRIPTED_PLATFORMS)[number];

export interface SuborkFakeCounts {
  refused: number;
  completions: Record<string, number>;
  /** Tool calls by name, counted only when their answer was sent. */
  toolCalls: Record<string, number>;
  turns: Array<TurnFacts & { platform: string }>;
  held: string[];
  /** Held requests whose client went away first (a killed backend's). */
  abandoned: number;
}

function chunk(id: string, delta: Record<string, unknown>, finish: string | null, usage?: object) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: FAKE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

let sequence = 0;

function answer(step: FakeStep, stream: boolean): Response {
  const id = `subqa-${++sequence}`;
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
  const call =
    step.kind === "tool"
      ? {
          id: `call-${sequence}`,
          type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.input) },
        }
      : undefined;
  const text = step.kind === "text" ? step.text : FAKE_REPLY;
  if (!stream) {
    return Response.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: FAKE_MODEL_ID,
      choices: [
        {
          index: 0,
          message: call
            ? { role: "assistant", content: null, tool_calls: [call] }
            : { role: "assistant", content: text },
          finish_reason: call ? "tool_calls" : "stop",
        },
      ],
      usage,
    });
  }
  const body = call
    ? chunk(id, { role: "assistant", tool_calls: [{ index: 0, ...call }] }, null) +
      chunk(id, {}, "tool_calls", usage)
    : chunk(id, { role: "assistant", content: text }, null) + chunk(id, {}, "stop", usage);
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function platformOf(pathname: string): Platform | undefined {
  const first = pathname.split("/")[1];
  return SCRIPTED_PLATFORMS.find((name) => name === first);
}

function tally(record: Record<string, number>, key: string): void {
  if (Object.keys(record).length < MAX_TRACKED || key in record)
    record[key] = (record[key] ?? 0) + 1;
}

/**
 * The fake's request handler and its counters, without a server, so the
 * routes have unit tests (`suborks-fake-model.test.ts`).
 */
export function createSuborkFakeModel() {
  const counts: SuborkFakeCounts = {
    refused: 0,
    completions: {},
    toolCalls: {},
    turns: [],
    held: [],
    abandoned: 0,
  };
  const holdTags = new Set<string>();
  const releases: Array<() => void> = [];

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__calls") return Response.json(counts);
    if (request.method === "POST" && url.pathname === "/__hold") {
      const tag = url.searchParams.get("tag") ?? "";
      if (!/^QATAG[0-9A-F]{8}$/.test(tag)) return new Response("bad tag", { status: 400 });
      holdTags.add(tag);
      return Response.json({ holding: [...holdTags] });
    }
    if (request.method === "POST" && url.pathname === "/__release") {
      holdTags.clear();
      for (const release of releases.splice(0)) release();
      return Response.json({ released: true });
    }
    const platform = platformOf(url.pathname);
    if (request.method === "GET" && platform && url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: FAKE_MODEL_ID, object: "model" }] });
    }
    if (!platform || request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      counts.refused += 1;
      return new Response("not served", { status: 404 });
    }
    if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
      counts.refused += 1;
      return new Response("too large", { status: 413 });
    }
    let body: { stream?: unknown; messages?: unknown; tools?: unknown };
    try {
      const text = await request.text();
      if (text.length > MAX_REQUEST_BYTES) throw new Error("too large");
      body = JSON.parse(text) as typeof body;
    } catch {
      counts.refused += 1;
      return new Response("bad request", { status: 400 });
    }
    tally(counts.completions, platform);
    const turn = scriptedTurn(platform, { messages: body.messages, tools: body.tools });
    if (counts.turns.length < MAX_TRACKED) counts.turns.push({ platform, ...turn.facts });
    const tag = turn.facts.tag;
    if (turn.facts.role === "target" && tag && holdTags.has(tag)) {
      if (counts.held.length < MAX_TRACKED) counts.held.push(`${platform} ${tag}`);
      await new Promise<void>((resolve) => {
        const done = () => {
          request.signal.removeEventListener("abort", done);
          const index = releases.indexOf(done);
          if (index >= 0) releases.splice(index, 1);
          resolve();
        };
        releases.push(done);
        request.signal.addEventListener("abort", done);
        if (request.signal.aborted) done();
      });
      if (request.signal.aborted) {
        // Nobody reads this answer: a submit it carried never happened.
        counts.abandoned += 1;
        return new Response("client gone", { status: 499 });
      }
    }
    if (turn.step.kind === "tool") tally(counts.toolCalls, turn.step.name);
    return answer(turn.step, body.stream === true);
  }

  return { fetch, counts };
}

if (import.meta.main) {
  const model = createSuborkFakeModel();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A held turn stays open for as long as the spec needs it.
    idleTimeout: 0,
    fetch: model.fetch,
  });
  console.log(`http://127.0.0.1:${server.port}`);
}
