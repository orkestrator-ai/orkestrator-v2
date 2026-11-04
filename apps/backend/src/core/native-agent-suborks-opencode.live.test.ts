/**
 * Suborks through a real provider process: the pinned `opencode serve` binary,
 * talking to a scripted OpenAI-compatible model on loopback, with the real
 * agent tools server, subork service, branch runner and mail drain. No billed
 * turn, login or real data directory is involved: OpenCode runs with a
 * throwaway HOME and XDG directories, and the "model" is this file's script.
 *
 * What it proves that the fake-provider suites cannot:
 * - the plain-text form ("ask codex and opencode to review this index.html")
 *   reaches `ask_agents` through a real provider's MCP client in a local
 *   environment, with the shared description offered to the model;
 * - a real OpenCode subork runs as a read-only plan turn, never sees
 *   `ask_agents` (depth 1) nor anything of the caller's conversation, and
 *   answers through `submit_subork_answer`;
 * - the labelled answers are mailed back and continue the real caller session.
 *
 * What a real model does with the description is still not shown: here the
 * script decides to call the tool. Run it with
 * `RUN_LIVE_OPENCODE_COMPATIBILITY=1 OPENCODE_CLI_PATH=<pinned opencode>`
 * (`mise run download:opencode` puts one in `binaries/`).
 */
import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBORK_TOOL_NAME } from "@orkestrator/protocol/suborks";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { AgentMailService } from "./agent-mail-service.js";
import { ORKESTRATOR_AGENT_MCP_SERVER_NAME } from "./agent-tools.js";
import { SUBORK_TOOL_DESCRIPTION } from "./agent-tools-subork-schema.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { GraphAgentProviders } from "./graph-agent-providers.js";
import { CATALOG, suborkWorld, type SuborkWorld } from "./native-agent-suborks-test-support.js";
import { configureOpenCodeAgentTools } from "./opencode-agent-tools.js";
import { openCodeWorkflowResultToolId } from "./opencode-provider-helpers.js";
import { OpenCodeProvider } from "./opencode-provider.js";

const liveTest = process.env.RUN_LIVE_OPENCODE_COMPATIBILITY === "1" ? test : test.skip;

const CALLER_REQUEST = "Please ask codex and opencode to review this index.html for me.";
const SUBORK_PROMPT =
  "Review index.html in the current working directory and say what you would change.";
const OPENCODE_ANSWER = "OpenCode read index.html: add a lang attribute.";
const ASK_TOOL = `${ORKESTRATOR_AGENT_MCP_SERVER_NAME}_${SUBORK_TOOL_NAME}`;
const SUBMIT_TOOL = openCodeWorkflowResultToolId("submit_subork_answer");

type ChatMessage = { role: string; content?: unknown };
type ChatTool = { function: { name: string; description?: string } };

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("\n");
  }
  return "";
}

liveTest(
  "the plain-text form reaches ask_agents on a real OpenCode, a real OpenCode subork answers, and the caller continues",
  async () => {
    const seen = {
      callerTools: [] as string[],
      askDescription: undefined as string | undefined,
      suborkTools: [] as string[][],
      suborkText: [] as string[],
      continuation: undefined as string | undefined,
    };
    const model = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/chat/completions"))
          return new Response(null, { status: 404 });
        const body = (await request.json()) as { messages?: ChatMessage[]; tools?: ChatTool[] };
        const messages = body.messages ?? [];
        const tools = body.tools ?? [];
        const names = tools.map((tool) => tool.function.name);
        const all = messages.map((message) => contentText(message.content)).join("\n");
        const lastUser = contentText(messages.findLast((m) => m.role === "user")?.content);
        const afterTool = messages.at(-1)?.role === "tool";
        if (all.includes("submit_subork_answer")) {
          seen.suborkTools.push(names);
          seen.suborkText.push(all);
          if (afterTool || !names.includes(SUBMIT_TOOL)) return text("Done.");
          const resultKey = /resultKey "([^"]+)"/.exec(all)?.[1];
          const capability = /capability "([^"]+)"/.exec(all)?.[1];
          return toolCall(SUBMIT_TOOL, {
            resultKey,
            ...(capability ? { capability } : {}),
            result: { answer: OPENCODE_ANSWER },
          });
        }
        if (lastUser.includes("codex says hi")) {
          seen.continuation = lastUser;
          return text("Both answered; carrying on.");
        }
        if (lastUser.includes(CALLER_REQUEST) && names.includes(ASK_TOOL)) {
          if (afterTool) return text("Asked them; the answers will arrive by mail.");
          seen.callerTools = names;
          seen.askDescription = tools.find((tool) => tool.function.name === ASK_TOOL)?.function
            .description;
          return toolCall(ASK_TOOL, {
            tabId: "agent",
            targets: [{ agent: "codex" }, { agent: "opencode", model: "fixture" }],
            prompt: SUBORK_PROMPT,
          });
        }
        // Titles and anything else OpenCode asks of its small model.
        return text("ok");
      },
    });

    let w: SuborkWorld | undefined;
    let server: ReturnType<typeof Bun.spawn> | undefined;
    let mail: AgentMailService | undefined;
    const real: OpenCodeProvider[] = [];
    let root = "";
    try {
      let baseUrl = "";
      let world: SuborkWorld | undefined;
      w = world = await suborkWorld({
        service: {
          providers: new GraphAgentProviders({
            create: async (_environment, agent: AgentPlatform) => {
              if (agent !== "opencode") return world!.provider(agent).asProvider();
              const provider = new OpenCodeProvider(
                { agent: "opencode", baseUrl, authToken: "unused", directory: root },
                { openCodeClient: createOpencodeClient({ baseUrl, directory: root }) },
              );
              real.push(provider);
              return provider as unknown as BuildPipelineProvider;
            },
          }),
          modelCatalog: async () => [
            ...CATALOG,
            { platform: "opencode", id: "fixture/fixture", label: "Fixture" },
          ],
          settingsTiers: async () => ({
            global: { platforms: { codex: { model: "gpt-6.1-sol" } } },
          }),
        },
      });
      // The caller is an OpenCode tab, on OpenCode's environment-wide credential.
      const layout = (await w.storage.getPaneLayout("e1"))!;
      const root0 = layout.root as { tabs: { nativeAgentData?: { platform: string } }[] };
      root0.tabs[0]!.nativeAgentData!.platform = "opencode";
      await w.storage.savePaneLayout("e1", layout, layout.revision);
      await w.storage.synchronizeAgentMailboxes();

      root = await realpath(await mkdtemp(join(tmpdir(), "ork-subork-opencode-")));
      const xdg = join(root, ".xdg");
      const config = join(xdg, "config"),
        data = join(xdg, "data"),
        state = join(xdg, "state"),
        cache = join(xdg, "cache");
      await Promise.all([config, data, state, cache].map((dir) => mkdir(dir, { recursive: true })));
      await writeFile(join(root, "index.html"), "<html><body>hi</body></html>\n");
      await writeFile(
        join(root, "opencode.json"),
        JSON.stringify({
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              name: "Local fixture",
              options: { baseURL: new URL("v1", model.url).href, apiKey: "test-key" },
              models: { fixture: { name: "Fixture", limit: { context: 16000, output: 2000 } } },
            },
          },
          model: "fixture/fixture",
          small_model: "fixture/fixture",
        }),
      );
      const port = await availableLoopbackPort();
      server = Bun.spawn(
        [
          process.env.OPENCODE_CLI_PATH?.trim() || "opencode",
          "serve",
          "--pure",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: xdg,
            XDG_CONFIG_HOME: config,
            XDG_DATA_HOME: data,
            XDG_STATE_HOME: state,
            XDG_CACHE_HOME: cache,
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(baseUrl, server);
      await configureOpenCodeAgentTools(
        port,
        "unused",
        w.agentTools.connection("e1", "p1", "host"),
        root,
      );

      const client = createOpencodeClient({ baseUrl, directory: root });
      const caller = await client.session.create({ title: "Caller" });
      const callerId = caller.data!.id;
      const fixtureModel = { providerID: "fixture", modelID: "fixture" };
      await client.session.prompt({
        sessionID: callerId,
        model: fixtureModel,
        parts: [{ type: "text", text: CALLER_REQUEST }],
      });

      // The tool and its description were offered to the model.
      expect(seen.callerTools).toContain(ASK_TOOL);
      expect(seen.askDescription).toContain(SUBORK_TOOL_DESCRIPTION.slice(0, 80));

      const calls = await client.session.messages({ sessionID: callerId });
      const askPart = (calls.data ?? [])
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === ASK_TOOL);
      expect(askPart?.type === "tool" ? askPart.state.status : undefined).toBe("completed");
      const output =
        askPart?.type === "tool" && askPart.state.status === "completed"
          ? askPart.state.output
          : "";
      const handle = JSON.parse(output) as { batchId: string; suborks: { status: string }[] };
      expect(handle.suborks.map((subork) => subork.status)).toEqual(["starting", "starting"]);

      const deadline = Date.now() + 60_000;
      for (;;) {
        const view = await w.service.advanceNow(handle.batchId);
        await w.settleProviders();
        if (view && view.status !== "running" && view.delivery !== "waiting") break;
        if (Date.now() >= deadline) throw new Error("The suborks did not settle");
        await Bun.sleep(100);
      }

      // Depth 1 and prompt isolation, as the real OpenCode subork saw them.
      expect(seen.suborkTools.length).toBeGreaterThan(0);
      for (const names of seen.suborkTools) {
        expect(names).not.toContain(ASK_TOOL);
        expect(names).toContain(SUBMIT_TOOL);
        // Nothing from the environment-wide server: as elsewhere, only its result tools.
        const prefix = `${ORKESTRATOR_AGENT_MCP_SERVER_NAME}_`;
        const resultPrefix = openCodeWorkflowResultToolId("");
        expect(
          names.filter((name) => name.startsWith(prefix) && !name.startsWith(resultPrefix)),
        ).toEqual([]);
        // OpenCode's own editing tools are not offered to a plan turn.
        expect(names).not.toContain("edit");
        expect(names).not.toContain("write");
      }
      const suborkSaw = seen.suborkText.join("\n");
      expect(suborkSaw).toContain(SUBORK_PROMPT);
      expect(suborkSaw).not.toContain(CALLER_REQUEST);

      const [delivered] = await w.mail();
      expect(delivered?.body).toContain("codex says hi");
      expect(delivered?.body).toContain(OPENCODE_ANSWER);
      expect(delivered?.body).toContain("OpenCode · Fixture");

      // The real mail drain continues the real caller session with the answers.
      mail = new AgentMailService(
        w.storage,
        {
          sessionActivitySnapshot: () => "idle",
          mailInjectPresence: async () => "idle",
          reconcileMailInject: async () => "not-dispatched",
          dispatchMailInject: async (input) => {
            await client.session.prompt({
              sessionID: callerId,
              model: fixtureModel,
              parts: [{ type: "text", text: input.prompt }],
            });
            return { outcome: "accepted", requestId: input.requestId };
          },
        },
        {
          dispatchMailInject: async () => {
            throw new Error("unexpected terminal dispatch");
          },
        },
      );
      await mail.drainInjects();
      expect(seen.continuation).toContain(OPENCODE_ANSWER);
      expect(seen.continuation).toContain("Codex · GPT-6.1 Sol");
    } finally {
      await mail?.shutdown();
      await Promise.all(real.map((provider) => provider.dispose()));
      if (server && server.exitCode === null) {
        server.kill();
        await Promise.race([server.exited, Bun.sleep(2000)]);
        if (server.exitCode === null) {
          server.kill("SIGKILL");
          await server.exited;
        }
      }
      model.stop(true);
      await w?.cleanup();
      if (root) await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

function text(content: string): Response {
  return completionStream([chunk({ role: "assistant", content }, null), chunk({}, "stop")]);
}

function toolCall(name: string, args: Record<string, unknown>): Response {
  return completionStream([
    chunk(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${crypto.randomUUID().slice(0, 8)}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      null,
    ),
    chunk({}, "tool_calls"),
  ]);
}

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return {
    id: "chatcmpl-subork",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function completionStream(chunks: unknown[]): Response {
  const body = `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

async function availableLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  if (port <= 0) throw new Error("Could not allocate an OpenCode test port");
  return port;
}

async function waitForHealth(baseUrl: string, processHandle: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (processHandle.exitCode !== null) {
      throw new Error(`OpenCode exited before becoming healthy (${processHandle.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error("OpenCode did not become healthy");
}
