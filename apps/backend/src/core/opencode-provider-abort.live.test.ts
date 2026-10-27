import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableLoopbackPort,
  readPinnedSdkVersion,
} from "../../../../scripts/opencode-live-compatibility-probe.js";
import { OpenCodeProvider } from "./opencode-provider.js";

const liveTest = process.env.RUN_LIVE_OPENCODE_COMPATIBILITY === "1" ? test : test.skip;

/** No credentials or remote model: only the pinned CLI in a disposable profile. */
liveTest(
  "a real OpenCode abort retires both parked permissions and questions",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ork-opencode-abort-")));
    let emitTools = true;
    let toolsSeen: string[] = [];
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/chat/completions"))
          return new Response(null, { status: 404 });
        const body = (await request.json()) as { tools?: Array<{ function: { name: string } }> };
        toolsSeen = body.tools?.map((tool) => tool.function.name) ?? [];
        const calls = emitTools
          ? [
              {
                name: "bash",
                arguments: { command: "pwd", description: "Inspect disposable workspace" },
              },
              {
                name: "question",
                arguments: {
                  questions: [
                    {
                      header: "Continue?",
                      question: "Continue the disposable test?",
                      options: [
                        { label: "Yes", description: "Continue" },
                        { label: "No", description: "Stop" },
                      ],
                    },
                  ],
                },
              },
            ]
          : [];
        emitTools = false;
        const chunk = {
          id: "chatcmpl-abort",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
        };
        const chunks = [
          {
            ...chunk,
            choices: [
              {
                index: 0,
                delta: calls.length
                  ? {
                      role: "assistant",
                      tool_calls: calls.map((call, index) => ({
                        index,
                        id: `call_${index}`,
                        type: "function",
                        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                      })),
                    }
                  : { role: "assistant", content: "Done." },
                finish_reason: null,
              },
            ],
          },
          {
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
          },
        ];
        return new Response(
          `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    let server: ReturnType<typeof Bun.spawn> | undefined;
    let provider: OpenCodeProvider | undefined;
    try {
      const directories = ["config", "data", "state", "cache"].map((name) => join(root, name));
      await Promise.all(directories.map((directory) => mkdir(directory)));
      await writeFile(
        join(root, "opencode.json"),
        JSON.stringify({
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              name: "Local fixture",
              options: { baseURL: `${model.url}/v1`, apiKey: "test-key" },
              models: { fixture: { name: "Fixture", limit: { context: 16000, output: 2000 } } },
            },
          },
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
            HOME: root,
            XDG_CONFIG_HOME: directories[0],
            XDG_DATA_HOME: directories[1],
            XDG_STATE_HOME: directories[2],
            XDG_CACHE_HOME: directories[3],
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const baseUrl = `http://127.0.0.1:${port}`;
      await poll(async () => {
        if (server!.exitCode !== null) throw new Error("OpenCode exited before becoming healthy");
        return fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(1000) })
          .then((response) => response.ok)
          .catch(() => false);
      });
      const health = await fetch(`${baseUrl}/global/health`).then((response) => response.json());
      expect(health).toMatchObject({ healthy: true, version: await readPinnedSdkVersion() });
      const client = createOpencodeClient({ baseUrl, directory: root });
      provider = new OpenCodeProvider(
        {
          agent: "opencode",
          baseUrl,
          authToken: "unused",
          directory: root,
        },
        { openCodeClient: client },
      );
      const created = await client.session.create({
        title: "Disposable abort interaction test",
        permission: [
          { permission: "bash", pattern: "*", action: "ask" },
          { permission: "question", pattern: "*", action: "allow" },
        ],
      });
      expect(created.error).toBeUndefined();
      const sessionId = created.data!.id;
      provider.registerSession(sessionId);
      await provider.send(sessionId, "Call bash and question in parallel, then wait.", {
        requestId: "abort-live",
        model: "fixture/fixture",
      });
      let permissions: NonNullable<Awaited<ReturnType<typeof client.permission.list>>["data"]> = [];
      let questions: NonNullable<Awaited<ReturnType<typeof client.question.list>>["data"]> = [];
      await poll(
        async () => {
          permissions = (await client.permission.list()).data ?? [];
          questions = (await client.question.list()).data ?? [];
          return (
            permissions.some((entry) => entry.sessionID === sessionId) &&
            questions.some((entry) => entry.sessionID === sessionId)
          );
        },
        () => `Both requests did not park; model tools: ${toolsSeen.join(", ")}`,
      );
      const rejectionStatuses: Array<{ kind: string; status: number }> = [];
      const permissionReply = client.permission.reply.bind(client.permission);
      client.permission.reply = (async (...args: Parameters<typeof permissionReply>) => {
        const response = await permissionReply(...args);
        rejectionStatuses.push({ kind: "permission", status: response.response.status });
        return response;
      }) as typeof permissionReply;
      const questionReject = client.question.reject.bind(client.question);
      client.question.reject = (async (...args: Parameters<typeof questionReject>) => {
        const response = await questionReject(...args);
        rejectionStatuses.push({ kind: "question", status: response.response.status });
        return response;
      }) as typeof questionReject;
      await provider.abort(sessionId);
      expect(
        (await client.permission.list()).data?.filter((entry) => entry.sessionID === sessionId),
      ).toEqual([]);
      expect(
        (await client.question.list()).data?.filter((entry) => entry.sessionID === sessionId),
      ).toEqual([]);
      expect(rejectionStatuses).toEqual([
        { kind: "permission", status: 200 },
        { kind: "question", status: 200 },
      ]);
      // A stale card can no longer grant permission or answer the question.
      const permission = await client.permission.reply({
        requestID: permissions[0]!.id,
        reply: "once",
      });
      const question = await client.question.reply({
        requestID: questions[0]!.id,
        answers: [["Yes"]],
      });
      expect(permission.response.status).toBe(404);
      expect(question.response.status).toBe(404);

      // Reproduce a request resolved after the cleanup read, using real HTTP
      // rejections from another responder before returning the captured lists.
      emitTools = true;
      await provider.send(sessionId, "Call bash and question in parallel again.", {
        requestId: "abort-live-race",
        model: "fixture/fixture",
      });
      await poll(async () => {
        const permissions = await client.permission.list();
        const questions = await client.question.list();
        return Boolean(permissions.data?.length && questions.data?.length);
      });
      const permissionList = client.permission.list.bind(client.permission);
      client.permission.list = (async (...args: Parameters<typeof permissionList>) => {
        const snapshot = await permissionList(...args);
        for (const request of snapshot.data ?? []) {
          const rejected = await permissionReply({ requestID: request.id, reply: "reject" });
          expect(rejected.response.status).toBe(200);
        }
        return snapshot;
      }) as typeof permissionList;
      const questionList = client.question.list.bind(client.question);
      client.question.list = (async (...args: Parameters<typeof questionList>) => {
        const snapshot = await questionList(...args);
        for (const request of snapshot.data ?? []) {
          const rejected = await questionReject({ requestID: request.id });
          expect(rejected.response.status).toBe(200);
        }
        return snapshot;
      }) as typeof questionList;
      rejectionStatuses.length = 0;
      await expect(provider.abort(sessionId)).resolves.toBeUndefined();
      expect(rejectionStatuses).toEqual([
        { kind: "permission", status: 404 },
        { kind: "question", status: 404 },
      ]);
      expect((await permissionList()).data).toEqual([]);
      expect((await questionList()).data).toEqual([]);
    } finally {
      await provider?.dispose();
      model.stop(true);
      if (server && server.exitCode === null) {
        server.kill();
        await Promise.race([server.exited, Bun.sleep(2000)]);
        if (server.exitCode === null) {
          server.kill("SIGKILL");
          await server.exited;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

async function poll(
  condition: () => Promise<boolean>,
  failure = () => "OpenCode did not become ready",
) {
  const deadline = Date.now() + 10000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(failure());
    await Bun.sleep(25);
  }
}
