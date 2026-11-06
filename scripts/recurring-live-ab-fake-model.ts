import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A fake OpenAI-compatible model endpoint for the recurring-work soak
 * (`scripts/recurring-live-ab.ts --soak-sessions`), so real Pi sessions can run
 * turns on an isolated profile without a credential, a provider or a bill.
 *
 * Only the model is fake. The profile's own Pi bridge, Pi SDK sessions, JSONL
 * session files, backend projection and observation all run for real; Pi is
 * pointed at this endpoint by a `models.json` in the profile's isolated HOME
 * (`writeFakePiModels`), never the user's `~/.pi`.
 *
 * It listens on 127.0.0.1 on a port the kernel picks, answers every chat
 * completion with one short streamed reply, and keeps only counts: no prompt,
 * header or body is retained or logged.
 */

export const FAKE_PI_PROVIDER = "soak-fake";
export const FAKE_PI_MODEL = "soak-1";
/** `provider/modelId`, as the CLI's `--model` takes a Pi model. */
export const FAKE_PI_MODEL_REF = `${FAKE_PI_PROVIDER}/${FAKE_PI_MODEL}`;
const REPLY = "Soak reply.";
/** A request body larger than this is refused; Pi's soak prompts are tiny. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export type FakeModelServer = {
  baseUrl: string;
  /** Requests answered, by route. */
  counts(): { completions: number; models: number; refused: number };
  stop(): Promise<void>;
};

function chunk(id: string, delta: Record<string, unknown>, finish: string | null, usage?: object) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: FAKE_PI_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

/**
 * `platform.Response` is the class handlers answer with: a test under a DOM
 * preload passes Bun's native one, which `Bun.serve` requires.
 */
export function startFakeModelServer(
  platform: { Response: typeof Response } = { Response: globalThis.Response },
): FakeModelServer {
  const Reply = platform.Response;
  const counts = { completions: 0, models: 0, refused: 0 };
  let sequence = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        counts.models += 1;
        return Reply.json({ object: "list", data: [{ id: FAKE_PI_MODEL, object: "model" }] });
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        counts.refused += 1;
        return new Reply("not found", { status: 404 });
      }
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > MAX_REQUEST_BYTES) {
        counts.refused += 1;
        return new Reply("too large", { status: 413 });
      }
      let stream = false;
      try {
        const text = await request.text();
        if (text.length > MAX_REQUEST_BYTES) throw new Error("too large");
        stream = (JSON.parse(text) as { stream?: unknown }).stream === true;
      } catch {
        counts.refused += 1;
        return new Reply("bad request", { status: 400 });
      }
      counts.completions += 1;
      const id = `soak-${++sequence}`;
      const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
      if (!stream) {
        return Reply.json({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: FAKE_PI_MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: REPLY },
              finish_reason: "stop",
            },
          ],
          usage,
        });
      }
      const body =
        chunk(id, { role: "assistant", content: REPLY }, null) +
        chunk(id, {}, "stop", usage) +
        "data: [DONE]\n\n";
      return new Reply(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    counts: () => ({ ...counts }),
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** The `models.json` that adds the fake provider; its key is a literal placeholder. */
export function fakePiModelsConfig(baseUrl: string) {
  return {
    providers: {
      [FAKE_PI_PROVIDER]: {
        name: "Soak fake",
        baseUrl,
        api: "openai-completions",
        apiKey: "soak-fake-no-provider",
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        },
        models: [
          {
            id: FAKE_PI_MODEL,
            name: "Soak 1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32_000,
            maxTokens: 256,
          },
        ],
      },
    },
  };
}

/**
 * The Pi agent directory of a profile's backend: agent-test backends run with
 * `HOME=<dataDir>/agent-credentials/home` (`apps/desktop/electron/backend-process.ts`),
 * and a local Pi bridge uses Pi's default `~/.pi/agent` under that HOME.
 */
export function profilePiAgentDirectory(dataDir: string): string {
  return path.join(dataDir, "agent-credentials", "home", ".pi", "agent");
}

/**
 * Writes the fake provider into the profile's own Pi `models.json`. Refuses
 * when that file already exists with other content: it belongs to the profile,
 * and the soak only ever writes a profile it just created.
 */
export function writeFakePiModels(dataDir: string, baseUrl: string): string {
  const resolvedData = path.resolve(dataDir);
  const directory = profilePiAgentDirectory(resolvedData);
  if (!directory.startsWith(`${resolvedData}${path.sep}`)) {
    throw new Error("Pi agent directory escapes the profile data directory");
  }
  const file = path.join(directory, "models.json");
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8")) as { providers?: object };
    const providers = Object.keys(existing.providers ?? {});
    if (providers.some((provider) => provider !== FAKE_PI_PROVIDER)) {
      throw new Error("The profile's Pi models.json already names other providers");
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(fakePiModelsConfig(baseUrl), null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return file;
}
