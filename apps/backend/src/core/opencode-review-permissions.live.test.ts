import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  effectiveOpenCodePolicy,
  openCodePermissionRules,
  openCodeReviewPermissionRules,
} from "./opencode-provider-helpers.js";

const liveTest = process.env.RUN_LIVE_OPENCODE_COMPATIBILITY === "1" ? test : test.skip;

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (port <= 0) throw new Error("Could not allocate an OpenCode test port");
  return port;
}

async function waitForHealth(baseUrl: string, processHandle: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) {
      throw new Error(`OpenCode exited before becoming healthy (${processHandle.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The server has not bound its socket yet.
    }
    await Bun.sleep(100);
  }
  throw new Error("OpenCode did not become healthy");
}

function completionStream(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

liveTest(
  "a real OpenCode server enforces the emitted reviewer command rules",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-opencode-review-permissions-"));
    const sentinel = join(root, "shell-mutation-sentinel");
    let modelRequests = 0;
    const modelServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/chat/completions"))
          return new Response("not found", { status: 404 });
        modelRequests += 1;
        const body = (await request.json()) as { tools?: Array<{ function?: { name?: string } }> };
        const bash = body.tools?.find((tool) => tool.function?.name === "bash")?.function?.name;
        if ((modelRequests === 1 || modelRequests === 2) && bash) {
          const command = modelRequests === 1 ? "pwd" : `touch ${sentinel}`;
          return completionStream([
            {
              id: `chatcmpl-review-${modelRequests}`,
              object: "chat.completion.chunk",
              created: 1,
              model: "review-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: modelRequests === 1 ? "call_read" : "call_mutation",
                        type: "function",
                        function: {
                          name: bash,
                          arguments: JSON.stringify({ command }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: `chatcmpl-review-${modelRequests}`,
              object: "chat.completion.chunk",
              created: 1,
              model: "review-model",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
          ]);
        }
        return completionStream([
          {
            id: "chatcmpl-review-2",
            object: "chat.completion.chunk",
            created: 2,
            model: "review-model",
            choices: [
              { index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null },
            ],
          },
          {
            id: "chatcmpl-review-2",
            object: "chat.completion.chunk",
            created: 2,
            model: "review-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]);
      },
    });
    const port = await availableLoopbackPort();
    const cliPath = process.env.OPENCODE_CLI_PATH?.trim() || "opencode";
    let server: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const config = join(root, "config");
      const data = join(root, "data");
      const state = join(root, "state");
      const cache = join(root, "cache");
      await Promise.all([config, data, state, cache].map((directory) => mkdir(directory)));
      await writeFile(
        join(root, "opencode.json"),
        JSON.stringify({
          provider: {
            reviewtest: {
              npm: "@ai-sdk/openai-compatible",
              name: "Review permission test",
              options: { baseURL: `${modelServer.url}/v1`, apiKey: "test-key" },
              models: {
                "review-model": {
                  name: "Review model",
                  limit: { context: 16_000, output: 2_000 },
                },
              },
            },
          },
        }),
      );
      server = Bun.spawn(
        [cliPath, "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
        {
          cwd: root,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: config,
            XDG_DATA_HOME: data,
            XDG_STATE_HOME: state,
            XDG_CACHE_HOME: cache,
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(baseUrl, server);
      const client = createOpencodeClient({ baseUrl });
      const policy = effectiveOpenCodePolicy(
        resolveNativeAgentExecutionPolicy(
          { environmentType: "local", networkAccessMode: "full" },
          "looped-review",
        ),
      );
      const created = await client.session.create({
        title: "Review permission probe",
        metadata: {
          "orkestrator.reviewSession": { version: 1, policy },
        },
        permission: openCodePermissionRules(policy),
      });
      if (created.error || !created.data?.id) throw new Error("OpenCode did not create a session");
      const sessionId = created.data.id;
      const permission = openCodeReviewPermissionRules(policy);
      const updated = await client.session.update({ sessionID: sessionId, permission });
      if (updated.error) throw new Error("OpenCode did not update reviewer permissions");
      const persisted = await client.session.get({ sessionID: sessionId });
      expect(persisted.data?.metadata?.["orkestrator.reviewSession"]).toEqual({
        version: 1,
        policy,
      });
      expect(persisted.data?.permission?.slice(-permission.length)).toEqual(permission);

      const dispatched = await client.session.promptAsync({
        sessionID: sessionId,
        model: { providerID: "reviewtest", modelID: "review-model" },
        agent: "plan",
        parts: [{ type: "text", text: "Call bash once with the requested command." }],
      });
      if (dispatched.error) throw new Error("OpenCode rejected the test prompt");
      const deadline = Date.now() + 10_000;
      while (modelRequests === 0 && Date.now() < deadline) await Bun.sleep(25);
      expect(modelRequests).toBeGreaterThan(0);
      for (;;) {
        const statuses = await client.session.status();
        if (statuses.data?.[sessionId]?.type !== "busy") break;
        if (Date.now() >= deadline) throw new Error("OpenCode review turn did not settle");
        await Bun.sleep(25);
      }
      await expect(readFile(sentinel, "utf8")).rejects.toThrow();
      const messages = await client.session.messages({ sessionID: sessionId });
      const transcript = JSON.stringify(messages.data).toLowerCase();
      expect(modelRequests).toBeGreaterThanOrEqual(3);
      expect(transcript).toContain('"command":"pwd"');
      expect(transcript).toContain('"status":"completed"');
      expect(transcript).toContain("touch");
      expect(transcript).toContain("prevents you from using this specific tool call");
    } finally {
      modelServer.stop(true);
      if (server && server.exitCode === null) {
        server.kill();
        await Promise.race([server.exited, Bun.sleep(2_000)]);
        if (server.exitCode === null) server.kill("SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
