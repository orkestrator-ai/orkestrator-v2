/**
 * A Codex recipient opens a mailed image with its own `view_image` tool, on
 * the **real** pinned `codex app-server` the bridge runs (to-do 4420 task 3,
 * the app-server part).
 *
 * `coordinator-mail-attachments-read-live.test.ts` showed this for
 * `codex exec`; the bridge does not use `exec`, so this runs the bridge's own
 * engine and process configuration (`codexAppServerConfigOverrides`). A
 * loopback Responses endpoint plays the model: it takes the image path from
 * the mail carrier Codex sent it, calls `view_image` on it, and records what
 * Codex returned. No model is called and no credits are spent. The carrier is
 * the one the backend's mail drain delivers (`renderAgentMailCarrier`).
 *
 * Two recipients: a worker, whose copy sits in its worktree, and a
 * coordinator, whose copy sits in the attachment directory the launcher names
 * (`ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT`), outside its checkout and readable
 * only through the grant its permission profile adds.
 *
 * Gated like the other live contract tests because it needs the pinned binary.
 * Point `CODEX_PROTOCOL_BINARY` at a worktree copy (`mise run download:codex`)
 * so nothing is read from an installed toolchain:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 CODEX_PROTOCOL_BINARY=$PWD/binaries/codex \
 *     bun --cwd=bridges/codex-bridge test src/app-server/live-mailed-image-read.test.ts
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  AGENT_MAIL_VERSION,
  renderAgentMailCarrier,
  type AgentMailMessage,
} from "@orkestrator/protocol/agent-mail";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  BRIDGE_ATTACHMENT_ROOT_ENV,
  codexAppServerConfigOverrides,
  codexCoordinatorPolicy,
} from "../codex-config.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineTurnConfig } from "../engine/types.js";
import { resolveCodexBinary } from "./live-binary.js";

// See `live-contract.test.ts`: the test preload replaces `Response`, and
// `Bun.serve` only accepts its own.
const NATIVE_WEB_PLATFORM_KEY = Symbol.for("orkestrator.tests.native-web-platform");
const NativeResponse =
  (globalThis as typeof globalThis & { [key: symbol]: { Response?: typeof Response } | undefined })[
    NATIVE_WEB_PLATFORM_KEY
  ]?.Response ?? Response;

const LIVE = process.env.RUN_LIVE_CODEX_APP_SERVER === "1";
const describeLive = LIVE ? describe : describe.skip;
const CLIENT_INFO = { name: "orkestrator", title: "Orkestrator", version: "2.4.9" };
const PROFILE = "coordinator-mailed-image-live";

/** A real 4x4 RGB PNG, so Codex's image reader accepts it. */
function realPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
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

type FrameInput = {
  type?: string;
  call_id?: string;
  output?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

type Reading = {
  /** The path the scripted model found in the prompt Codex sent it. */
  asked: string | undefined;
  /** Samples Codex asked for. */
  sampled: number;
  /** Image data Codex returned for each call, by call id. */
  images: Record<string, Buffer[]>;
  /** Text Codex returned for each call, by call id. */
  text: Record<string, string>;
};

/**
 * A Responses WebSocket: a prewarm gets an empty response, the turn's first
 * sample calls `view_image` on the mailed path, then on `extraRead` if given,
 * and every later sample ends the turn.
 */
function startScriptedResponses(extraRead?: string) {
  const reading: Reading = { asked: undefined, sampled: 0, images: {}, text: {} };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request)) {
        return undefined;
      }
      return new NativeResponse("not served", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message)) as {
          type?: string;
          generate?: boolean;
          input?: FrameInput[];
        };
        if (frame.type !== "response.create") return;
        const id = `resp_${Math.random().toString(36).slice(2)}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          reading.sampled += 1;
          for (const item of frame.input ?? []) {
            if (reading.sampled === 1 && item.type === "message") {
              reading.asked ??= mailedPath(
                (item.content ?? []).map((part) => part.text ?? "").join("\n"),
              );
            }
            if (item.type !== "function_call_output" || !item.call_id) continue;
            const output = Array.isArray(item.output) ? item.output : [item.output];
            const parts = output as Array<{ type?: string; image_url?: string; text?: string }>;
            reading.images[item.call_id] = parts.flatMap((part) =>
              part?.type === "input_image" && part.image_url?.startsWith("data:image/")
                ? [Buffer.from(part.image_url.split(",", 2)[1] ?? "", "base64")]
                : [],
            );
            reading.text[item.call_id] = JSON.stringify(item.output ?? "");
          }
          const reads = [reading.asked, extraRead].filter((path): path is string => !!path);
          const next = reads[reading.sampled - 1];
          const item = next
            ? {
                type: "function_call",
                id: `fc_read_${reading.sampled}`,
                call_id: `read_${reading.sampled}`,
                name: "view_image",
                arguments: JSON.stringify({ path: next }),
                status: "completed",
              }
            : {
                type: "message",
                id: `msg_${id}`,
                role: "assistant",
                content: [{ type: "output_text", text: "Seen.", annotations: [] }],
                status: "completed",
              };
          send({ type: "response.output_item.done", output_index: 0, item });
        }
        send({
          type: "response.completed",
          response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        });
      },
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    reading,
    stop: () => server.stop(true),
  };
}

const WORKER_POLICY: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "provider",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

/** One turn on a fresh app-server whose input is `prompt`; resolves once it ends. */
async function runTurn(input: {
  codexHome: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  config: EngineTurnConfig;
  prompt: string;
  extraRead?: string;
}): Promise<Reading> {
  const responses = startScriptedResponses(input.extraRead);
  const engine = new AppServerEngine({
    codexPath: await realpath(await resolveCodexBinary()),
    cwd: input.workspace,
    codexHome: input.codexHome,
    clientInfo: CLIENT_INFO,
    configOverrides: {
      ...codexAppServerConfigOverrides(input.env),
      openai_base_url: JSON.stringify(responses.baseUrl),
    },
    supervisorOverrides: { pidFileEnabled: false },
  });
  let completed!: () => void;
  const turnCompleted = new Promise<void>((resolve) => {
    completed = resolve;
  });
  engine.subscribe((event: EngineEvent) => {
    if (event.kind === "turn.completed") completed();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await engine.start();
    const thread = await engine.startThread({ config: input.config });
    await engine.startTurn({
      handle: thread.handle,
      input: [{ type: "text", text: input.prompt }],
      config: input.config,
    });
    await Promise.race([
      turnCompleted,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for the turn")), 90_000);
      }),
    ]);
    return responses.reading;
  } finally {
    clearTimeout(timer);
    await engine.stop();
    await responses.stop();
  }
}

async function fixtureRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ork-mailed-image-")));
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "checkout");
  await mkdir(codexHome, { recursive: true });
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  // Never a real key: the only server it can reach is the loopback fake.
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    { mode: 0o600 },
  );
  return { root, codexHome, workspace };
}

describeLive("live mailed image read on app-server", () => {
  test("a worker reads the image its delivered message names, from its worktree", async () => {
    const { root, codexHome, workspace } = await fixtureRoot();
    try {
      const image = join(workspace, ".orkestrator", "mail-attachments", "batch-1", "shot.png");
      await mkdir(dirname(image), { recursive: true });
      await writeFile(image, PNG);
      const read = await runTurn({
        codexHome,
        workspace,
        env: {},
        config: {
          mode: "build",
          cwd: workspace,
          sandbox: "workspace-write",
          approvalPolicy: "never",
          policy: WORKER_POLICY,
        },
        prompt: carrier("env-worker", image),
      });
      expect(read.asked).toBe(image);
      expect(read.sampled).toBe(2);
      expect(read.images.read_1).toHaveLength(1);
      expect(read.images.read_1![0]!.equals(PNG)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("a coordinator reads its attachment directory outside the checkout through the profile's grant", async () => {
    const { root, codexHome, workspace } = await fixtureRoot();
    const previousPolicy = process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
    // The engine reads the process authority, as the bridge does.
    process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = "coordinator-read-only";
    try {
      const codexPath = await realpath(await resolveCodexBinary());
      const attachments = join(root, "data", "coordinator-attachments", "conversation-1");
      const image = join(attachments, "shot.png");
      // Beside the grant, under the same data directory: the profile's control.
      const outside = join(root, "data", "other.png");
      await mkdir(attachments, { recursive: true });
      await writeFile(image, PNG);
      await writeFile(outside, PNG);
      const env: NodeJS.ProcessEnv = {
        TMPDIR: process.env.TMPDIR,
        ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
        CODEX_BRIDGE_PERMISSION_PROFILE: PROFILE,
        CODEX_BRIDGE_READABLE_RUNTIME_ROOT: dirname(codexPath),
        CWD: workspace,
        [BRIDGE_ATTACHMENT_ROOT_ENV]: attachments,
      };
      const read = await runTurn({
        codexHome,
        workspace,
        env,
        // What `toEngineConfig` builds for a coordinator process.
        config: {
          mode: "build",
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "read-only",
          networkAccessEnabled: false,
          permissionProfile: PROFILE,
          policy: codexCoordinatorPolicy({}),
        },
        prompt: carrier("coordinator:coordinator-1", image),
        extraRead: outside,
      });
      expect(read.asked).toBe(image);
      expect(read.sampled).toBe(3);
      expect(read.images.read_1).toHaveLength(1);
      expect(read.images.read_1![0]!.equals(PNG)).toBe(true);
      // The grant is that directory alone: a file beside it is not returned.
      expect(read.images.read_2 ?? []).toHaveLength(0);
      // Answered, and refused by the sandbox (macOS: "Operation not permitted").
      expect(read.text.read_2).toMatch(/not permitted|permission denied/i);
    } finally {
      if (previousPolicy === undefined) delete process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
      else process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = previousPolicy;
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
