/**
 * A Pi recipient opens a mailed image with Pi's own `read` tool (to-do 4420
 * task 3, the Pi part).
 *
 * The bridge, its approval gate and read boundary, the SDK's agent loop and
 * its `read` tool are all real. The model is a loopback server speaking the
 * OpenAI completions protocol, so nothing reaches a provider and no login is
 * used: it takes the image path from the mail carrier the bridge actually sent
 * it, asks for `read` on that path, and the test checks the bytes Pi handed
 * back to the model on the next call. The carrier is the one the backend's
 * mail drain delivers (`renderAgentMailCarrier`); that the backend names the
 * placed copy in it is `coordinator-mail-attachments-read-live.test.ts`'s
 * claim.
 *
 * Two recipients: a worker, whose copy sits in its worktree, and a
 * coordinator, whose copy sits in its attachment directory under the data
 * directory that the coordinator read boundary otherwise refuses. The
 * coordinator case also reads a credential file beside it, which must be
 * refused, so a pass shows the carve-out and not a missing boundary.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  AGENT_MAIL_VERSION,
  renderAgentMailCarrier,
  type AgentMailMessage,
} from "@orkestrator/protocol/agent-mail";
import { COORDINATOR_PROTECTED_DATA_DIR_ENV } from "@orkestrator/protocol/coordinator";
import { piCompletionChunk, piProviderConfig } from "../../../scripts/pi-fake-model-shared";

// `config.ts` reads its environment once, at import; see `http.test.ts`.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const { closeSession, setAgentSessionTestHooks } = await import("./agent-session.js");
const { refreshModels } = await import("./models.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { nativeFetch } = await import("./testing/native-fetch.js");
const { ModelRuntime } = await import("./pi-sdk.js");
const { BRIDGE_ATTACHMENT_ROOT_ENV } = await import("./prompt-attachments.js");
const { PI_READ_BOUNDARY_REFUSAL } = await import("./read-boundary.js");

const MODEL = "mail-image-fixture";
const PROVIDER = "mail-image-loopback";

/** A real 4x4 RGB PNG, so Pi's reader takes it for an image. */
function realPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(
    Array.from({ length: 4 }, (_, row) =>
      Buffer.from([0, ...Array.from({ length: 4 }, (_, col) => [row * 60, col * 60, 200]).flat()]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = realPng();

let origin: string;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-mailed-image-"));
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await shutdown();
  await rm(directory, { recursive: true, force: true });
});

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The carrier the mail drain hands the recipient for one message with `image` attached. */
function carrier(toEnvironmentId: string, image: string): string {
  const message: AgentMailMessage = {
    version: AGENT_MAIL_VERSION,
    id: "msg-mailed-image",
    threadId: "msg-mailed-image",
    requestId: "mailed-image",
    createdAt: new Date().toISOString(),
    from: {
      kind: "tab",
      projectId: "project-1",
      environmentId: "env-sender",
      tabId: "startup-agent",
      incarnationId: "incarnation-1",
      agent: "claude",
      title: null,
    },
    toEnvironmentId,
    toTabId: "startup-agent",
    toIncarnationId: "incarnation-2",
    body: "Here is the screenshot the user pasted.",
    bodyBytes: 39,
    trust: "same-project",
    injectDepth: 1,
    threadDepth: 0,
    placement: "inject-pending",
    attachments: [
      {
        name: "screenshot.png",
        path: image,
        mediaType: "image/png",
        bytes: PNG.length,
        sha256: createHash("sha256").update(PNG).digest("hex"),
      },
    ],
    revision: 1,
  };
  return renderAgentMailCarrier(message);
}

/** The first attachment path a carrier names. */
function mailedPath(text: string): string | undefined {
  const match = text.match(
    /<orkestrator-peer-payload-json>\n([\s\S]*?)\n<\/orkestrator-peer-payload-json>/,
  );
  if (!match) return undefined;
  const payload = JSON.parse(match[1]!) as { attachments?: Array<{ path: string }> };
  return payload.attachments?.[0]?.path;
}

type CompletionRequest = { messages?: Array<{ role: string; content: unknown }> };

const textParts = (content: unknown): string[] =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((part: { type?: string; text?: string }) =>
          part.type === "text" && part.text ? [part.text] : [],
        )
      : [];

/** Base64 PNG data in every image part of a request, wherever Pi put it. */
const imageData = (request: CompletionRequest): string[] =>
  JSON.stringify(request.messages ?? []).match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [];

type Reading = {
  /** The path the scripted model found in the prompt the bridge sent it. */
  asked: string | undefined;
  /** Model calls the bridge made. */
  calls: number;
  /** Images Pi returned to the model for the read. */
  images: Buffer[];
  /** Text of the tool results Pi returned. */
  toolText: string;
  /** The turn ran to its scripted end. */
  finished: boolean;
};

/**
 * One Pi session on the loopback model, prompted with `prompt`. The model
 * reads the mailed path, then `extraRead` if given, then ends the turn.
 */
async function piReads(
  clientSessionKey: string,
  prompt: string,
  extraRead?: string,
): Promise<Reading> {
  const requests: CompletionRequest[] = [];
  let asked: string | undefined;
  const reads = (): string[] => [asked, extraRead].filter((path): path is string => !!path);
  const endpoint = createServer(async (request: IncomingMessage, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as CompletionRequest;
    requests.push(parsed);
    if (requests.length === 1) {
      asked = mailedPath(
        (parsed.messages ?? [])
          .filter((message) => message.role === "user")
          .flatMap((message) => textParts(message.content))
          .join("\n"),
      );
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const next = reads()[requests.length - 1];
    if (next) {
      const id = `read_${requests.length}`;
      response.end(
        piCompletionChunk(
          MODEL,
          id,
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: next }) },
              },
            ],
          },
          null,
        ) +
          piCompletionChunk(MODEL, id, {}, "tool_calls", {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          }) +
          "data: [DONE]\n\n",
      );
      return;
    }
    response.end(
      piCompletionChunk(MODEL, "done", { role: "assistant", content: "Seen." }, null) +
        piCompletionChunk(MODEL, "done", {}, "stop", {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        }) +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const port = (endpoint.address() as AddressInfo).port;

  // The SDK's fetch must be Bun's own, not the DOM preload's (see `sdk-session.test.ts`).
  const previousPlatform = {
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    Response: globalThis.Response,
  };
  const nativePlatform = (globalThis as Record<symbol, unknown>)[
    Symbol.for("orkestrator.tests.native-web-platform")
  ] as typeof previousPlatform | undefined;
  if (nativePlatform) Object.assign(globalThis, nativePlatform);
  globalThis.fetch = nativeFetch;

  const agentDirectory = await mkdtemp(join(directory, "agent-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousSessionDir = process.env.PI_SESSION_DIR;
  process.env.PI_AGENT_DIR = agentDirectory;
  process.env.PI_SESSION_DIR = agentDirectory;
  let state: ReturnType<typeof sessions.get>;
  setAgentSessionTestHooks(undefined);
  try {
    const config = piProviderConfig({
      provider: PROVIDER,
      providerName: "Mailed image loopback",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "fixture-only-not-a-key",
      model: MODEL,
      modelName: "Mailed image fixture",
    });
    // A model that takes images, so Pi's `read` returns the picture, not a note.
    for (const model of config.providers[PROVIDER]!.models) model.input = ["text", "image"];
    await writeFile(join(agentDirectory, "models.json"), JSON.stringify(config));
    const runtime = await ModelRuntime.create({
      authPath: join(agentDirectory, "auth.json"),
      modelsPath: join(agentDirectory, "models.json"),
      allowModelNetwork: false,
    });
    setModelRuntimeFactoryForTests(async () => runtime);
    refreshModels();
    const created = await call("/session/create", {
      method: "POST",
      body: JSON.stringify({ clientSessionKey, model: `${PROVIDER}/${MODEL}` }),
    });
    expect(created.status).toBe(201);
    const current = sessions.get(((await created.json()) as { sessionId: string }).sessionId)!;
    state = current;
    const prompted = await call(`/session/${current.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    expect(prompted.status).toBe(202);
    await waitFor(() => current.status === "idle" && !current.dispatching);
    const results = requests
      .slice(1)
      .flatMap((request) => (request.messages ?? []).filter((message) => message.role === "tool"));
    const last = requests.at(-1) ?? {};
    return {
      asked,
      calls: requests.length,
      images: imageData(last).map((url) => Buffer.from(url.split(",", 2)[1]!, "base64")),
      toolText: results.flatMap((message) => textParts(message.content)).join("\n"),
      finished: JSON.stringify(current.messages).includes("Seen."),
    };
  } finally {
    if (state) {
      await closeSession(state);
      sessions.delete(state.id);
      if (state.clientSessionKey) clientSessionKeys.delete(state.clientSessionKey);
    }
    setAgentSessionTestHooks(undefined);
    setModelRuntimeFactoryForTests();
    refreshModels();
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_SESSION_DIR;
    else process.env.PI_SESSION_DIR = previousSessionDir;
    Object.assign(globalThis, previousPlatform);
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("a Pi worker reads the image its delivered message names, from its worktree", async () => {
  const worktree = join(directory, "worktree");
  const image = join(worktree, ".orkestrator", "mail-attachments", "batch-1", "screenshot.png");
  await mkdir(join(image, ".."), { recursive: true });
  await writeFile(image, PNG);

  const read = await piReads("mailed-image-worker", carrier("env-worker", image));

  expect(read.asked).toBe(image);
  expect(read.calls).toBe(2);
  expect(read.images).toHaveLength(1);
  expect(read.images[0]!.equals(PNG)).toBe(true);
  expect(read.finished).toBe(true);
}, 30_000);

test("a Pi coordinator reads its own attachment directory under the data directory, and nothing else there", async () => {
  const dataDir = join(directory, "data");
  const attachments = join(dataDir, "coordinator-attachments", "coordinator-1", "conversation-1");
  const image = join(attachments, "screenshot.png");
  const credential = join(dataDir, "control-mcp.json");
  await mkdir(attachments, { recursive: true });
  await writeFile(image, PNG);
  await writeFile(credential, '{"token":"fixture-credential-not-a-secret"}');
  const previous = {
    dataDir: process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV],
    root: process.env[BRIDGE_ATTACHMENT_ROOT_ENV],
  };
  process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV] = dataDir;
  process.env[BRIDGE_ATTACHMENT_ROOT_ENV] = attachments;
  try {
    const read = await piReads(
      "mailed-image-coordinator",
      carrier("coordinator:coordinator-1", image),
      credential,
    );

    expect(read.asked).toBe(image);
    expect(read.calls).toBe(3);
    // The image came back; the credential beside it did not.
    expect(read.images).toHaveLength(1);
    expect(read.images[0]!.equals(PNG)).toBe(true);
    expect(read.toolText).toContain(PI_READ_BOUNDARY_REFUSAL);
    expect(read.toolText).not.toContain("fixture-credential-not-a-secret");
    expect(read.finished).toBe(true);
  } finally {
    if (previous.dataDir === undefined) delete process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV];
    else process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV] = previous.dataDir;
    if (previous.root === undefined) delete process.env[BRIDGE_ATTACHMENT_ROOT_ENV];
    else process.env[BRIDGE_ATTACHMENT_ROOT_ENV] = previous.root;
  }
}, 30_000);
