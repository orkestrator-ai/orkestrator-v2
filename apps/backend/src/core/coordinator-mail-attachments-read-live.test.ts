/**
 * A recipient agent opens a mailed image with its own read tool.
 *
 * The send, the copy and the delivered prompt are the production code (real
 * mail store, real Git worktree, real injection drain). The recipient is the
 * real pinned Claude or Codex CLI, pointed at a scripted loopback model: the
 * script takes the image path from the prompt the CLI actually sent it, asks
 * for the CLI's own image-reading tool on that path (`Read`, `view_image`), and
 * the test checks the CLI handed the picture back as image content. No provider
 * is called and no credit is spent.
 *
 * Each agent is skipped when its pinned CLI is not installed;
 * `ORKESTRATOR_POLICY_CLAUDE_PATH` / `ORKESTRATOR_POLICY_CODEX_PATH` name one
 * explicitly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

import {
  policyQualificationCli,
  withPolicyCliFixture,
} from "../../../../tests/conformance/execution-policy/vendor-cli.js";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
  type ScriptedBlock,
} from "../../../../tests/conformance/execution-policy/scripted-anthropic.js";
import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { runCommand } from "./shell.js";

const CLIS = {
  claude: policyQualificationCli("claude"),
  codex: policyQualificationCli("codex"),
} as const;
type Agent = keyof typeof CLIS;

/** A real 4x4 RGB PNG, so the CLI's image reader accepts it. */
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

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

type Result = Record<string, any>;

async function harness() {
  const world = await MailWorld.create();
  worlds.push(world);
  const commands = createCommandRegistry({ containerFileCopy: { runCommand } });
  const context = {
    storage: world.storage,
    coordinators: world.coordinator,
    drainAgentMail: () => world.mail.drainInjects(),
    runtime: {
      coordinatorRequests: world.coordinatorRequests,
      environments: { fence: { beginMutation: () => () => undefined } },
    },
  } as unknown as CommandContext;
  const main = await world.main();
  const send = (args: Record<string, unknown>, from: MailActor = main) =>
    commands.get("send_coordinator_agent_mail")!(
      {
        projectId: world.projectId,
        coordinatorId: world.coordinatorId,
        conversationId: from.conversationId!,
        body: "Here is the screenshot the user pasted.",
        ...args,
      },
      context,
    ) as Promise<Result>;
  const paste = (actor: MailActor) =>
    world.storage.coordinators.writeCoordinatorAttachment(
      world.coordinatorId,
      actor.conversationId!,
      "screenshot.png",
      PNG.toString("base64"),
    );
  return { world, main, send, paste };
}

type Block = { type?: string; text?: string; content?: unknown; tool_use_id?: string };
type Request = { messages?: Array<{ role: string; content: string | Block[] }> };

const textOf = (request: Request) =>
  (request.messages ?? [])
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])),
    )
    .join("\n");

/** The first attachment path named in a mail carrier inside `text`. */
function mailedPath(text: string): string | undefined {
  const match = text.match(
    /<orkestrator-peer-payload-json>\n([\s\S]*?)\n<\/orkestrator-peer-payload-json>/,
  );
  if (!match) return undefined;
  const payload = JSON.parse(match[1]!) as { attachments?: Array<{ path: string }> };
  return payload.attachments?.[0]?.path;
}

/** Image blocks the CLI returned for the given tool call. */
function returnedImages(request: unknown, toolUseId: string): string[] {
  const blocks = ((request as Request).messages ?? []).flatMap((message) =>
    typeof message.content === "string" ? [] : message.content,
  );
  const result = blocks.find(
    (block) => block.type === "tool_result" && block.tool_use_id === toolUseId,
  );
  const content = Array.isArray(result?.content) ? (result.content as Block[]) : [];
  return content
    .filter((block) => block.type === "image")
    .map((block) => (block as { source?: { data?: string } }).source?.data ?? "");
}

/**
 * Hands `prompt` to the pinned CLI as one turn in `cwd`, as the recipient's
 * agent would get it, and lets the scripted model read the path it names.
 *
 * `Read` is approved up front, as the Claude bridge approves it for every
 * session, worker and read-only coordinator alike
 * (`session-manager-prompt-query.ts`). Without that the CLI asks before
 * reading outside its working directory, which is where a coordinator
 * conversation's attachment directory is.
 */
async function claudeReads(prompt: string, cwd: string): Promise<Reading> {
  return withPolicyCliFixture(async (fixture) => {
    let asked: string | undefined;
    const endpoint = scriptedAnthropicEndpoint((_origin, first): ScriptedBlock[][] => {
      asked = mailedPath(textOf(first as Request));
      return asked
        ? [
            [{ type: "tool_use", id: "open_image", name: "Read", input: { file_path: asked } }],
            [{ type: "text", text: "Seen." }],
          ]
        : [[{ type: "text", text: "No path in the message." }]];
    });
    try {
      const env = scriptedClaudeEnv(fixture, endpoint, path.join(fixture.root, "claude"));
      const run = await runCommand(
        CLIS.claude!,
        [
          "--print",
          "--tools",
          "Read",
          "--allowedTools",
          "Read",
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--model",
          "claude-sonnet-4-6",
          "--max-turns",
          "3",
        ],
        { cwd, env, stdin: prompt, timeoutMs: 60_000 },
      );
      const requests = endpoint.requests();
      return {
        asked,
        calls: requests.length,
        images: requests[1] ? returnedImages(requests[1], "open_image") : [],
        finished: run.stdout.includes("Seen."),
      };
    } finally {
      endpoint.stop();
    }
  });
}

type Reading = {
  /** The path the scripted model found in the prompt it was given. */
  asked: string | undefined;
  /** Model calls the CLI made. */
  calls: number;
  /** Base64 image content the CLI returned for the read. */
  images: string[];
  /** The CLI ran the turn to its scripted end. */
  finished: boolean;
};

type ResponsesFrame = {
  type?: string;
  generate?: boolean;
  input?: Array<{ type?: string; call_id?: string; output?: unknown; content?: unknown }>;
};

/** Every input text of a Responses request, in order. */
const responsesText = (frame: ResponsesFrame) =>
  (frame.input ?? [])
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .flatMap((part: { type?: string; text?: string }) =>
      part.type === "input_text" && part.text ? [part.text] : [],
    )
    .join("\n");

/**
 * The same turn for Codex: `codex exec` over a scripted Responses WebSocket.
 * The first sample calls `view_image` on the mailed path, the next ends the
 * turn; the test keeps the tool output Codex sent back for the call.
 */
async function codexReads(prompt: string, cwd: string): Promise<Reading> {
  return withPolicyCliFixture(async (fixture) => {
    let asked: string | undefined;
    let sampled = 0;
    const images: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bun) {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request))
          return undefined;
        return new Response("not served", { status: 400 });
      },
      websocket: {
        message(socket, message) {
          const frame = JSON.parse(String(message)) as ResponsesFrame;
          if (frame.type !== "response.create") return;
          const id = `resp_${sampled}_${Math.random().toString(36).slice(2)}`;
          const send = (event: unknown) => socket.send(JSON.stringify(event));
          send({ type: "response.created", response: { id } });
          if (frame.generate !== false) {
            sampled += 1;
            if (sampled === 1) asked = mailedPath(responsesText(frame));
            for (const item of frame.input ?? []) {
              if (item.type !== "function_call_output" || item.call_id !== "open_image") continue;
              const output = Array.isArray(item.output) ? item.output : [];
              for (const part of output as Array<{ type?: string; image_url?: string }>) {
                const data = part.type === "input_image" ? part.image_url : undefined;
                if (data?.startsWith("data:image/")) images.push(data.split(",", 2)[1] ?? "");
              }
            }
            const item =
              sampled === 1 && asked
                ? {
                    type: "function_call",
                    id: "fc_open_image",
                    call_id: "open_image",
                    name: "view_image",
                    arguments: JSON.stringify({ path: asked }),
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
    try {
      const codexHome = path.join(fixture.root, "codex");
      await mkdir(codexHome);
      // Never a real key: the only server it can reach is the loopback fake.
      await writeFile(
        path.join(codexHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
        { mode: 0o600 },
      );
      const run = await runCommand(
        CLIS.codex!,
        [
          "exec",
          "--config",
          `openai_base_url="http://127.0.0.1:${server.port}/v1"`,
          "--sandbox",
          "read-only",
          "--cd",
          cwd,
          "--skip-git-repo-check",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "-",
        ],
        {
          cwd,
          env: { ...fixture.env, CODEX_HOME: codexHome },
          stdin: prompt,
          timeoutMs: 60_000,
        },
      );
      return { asked, calls: sampled, images, finished: run.stdout.includes("Seen.") };
    } finally {
      server.stop(true);
    }
  });
}

const READERS: Record<Agent, (prompt: string, cwd: string) => Promise<Reading>> = {
  claude: claudeReads,
  codex: codexReads,
};

for (const agent of Object.keys(CLIS) as Agent[]) {
  const liveTest = CLIS[agent] ? test : test.skip;
  const reads = READERS[agent];

  describe(`a ${agent} recipient opens a mailed image with its own read tool`, () => {
    liveTest(
      "an agent tab in a worktree reads the image its delivered message names",
      async () => {
        const { world, send, paste, main } = await harness();
        const worker = await world.addEnvironment("worker", { launched: true });
        const worktree = path.join(world.root, "worker");
        await runCommand("git", ["worktree", "add", "-b", "worker", worktree], {
          cwd: path.join(world.root, "checkout"),
        });
        await world.storage.updateEnvironment(worker.environmentId, { worktreePath: worktree });
        // A launched worker starts mid-turn; mail then waits for it to go idle.
        await world.finishTurn(worker);

        const sent = await send({
          requestId: "read-live",
          toEnvironmentId: worker.environmentId,
          toTabId: worker.tabId,
          attachments: [await paste(main)],
        });
        await world.deliver();
        const [prompt] = world.deliveredPrompts(worker);
        expect(prompt).toBeDefined();

        const read = await reads(prompt!, worktree);

        // The path came from the prompt the CLI sent the model, and is the copy.
        expect(read.asked).toBe(sent.attachments[0].path);
        expect(read.asked!.startsWith(`${worktree}/.orkestrator/mail-attachments/`)).toBe(true);
        expect(read.calls).toBe(2);
        expect(read.images).toHaveLength(1);
        expect(Buffer.from(read.images[0]!, "base64").equals(PNG)).toBe(true);
        expect(read.finished).toBe(true);
      },
      90_000,
    );

    liveTest(
      "a side agent reads the image in its own attachment directory",
      async () => {
        const { world, send, paste, main } = await harness();
        const side = await world.addSide();
        const sent = await send({
          requestId: "read-live-side",
          toEnvironmentId: side.environmentId,
          toTabId: side.tabId,
          attachments: [await paste(main)],
        });
        await world.deliver();
        const [prompt] = world.deliveredPrompts(side);
        expect(prompt).toBeDefined();

        // A coordinator conversation works in the project checkout; its
        // attachment directory is outside it, in the data directory.
        const read = await reads(prompt!, path.join(world.root, "checkout"));

        expect(read.asked).toBe(sent.attachments[0].path);
        expect(path.dirname(read.asked!)).toBe(
          world.storage.coordinators.coordinatorAttachmentDirectory(
            world.coordinatorId,
            side.conversationId!,
          ),
        );
        expect(read.images).toHaveLength(1);
        expect(Buffer.from(read.images[0]!, "base64").equals(PNG)).toBe(true);
        expect(read.finished).toBe(true);
      },
      90_000,
    );
  });
}
