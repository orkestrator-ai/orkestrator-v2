import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { AgentToolsServer } from "./agent-tools.js";
import { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";
import { OpenCodeProvider } from "./opencode-provider.js";
import { readProviderStatus } from "./agent-provider-contract.js";
import {
  effectiveOpenCodePolicy,
  openCodePermissionRules,
  openCodeReviewPermissionRules,
  openCodeWorkflowResultPermissionRules,
  openCodeWorkflowResultTurnTools,
  openCodeWorkflowResultToolId,
} from "./opencode-provider-helpers.js";

const liveTest = process.env.RUN_LIVE_OPENCODE_COMPATIBILITY === "1" ? test : test.skip;

liveTest(
  "a real OpenCode workflow submits despite an idle observer and settles after provider recreation",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ork-opencode-workflow-lifecycle-")));
    const results = new WorkflowResultService(root);
    const tools = new AgentToolsServer(new StorageService(root), "127.0.0.1", results);
    const resultKey = crypto.randomUUID();
    const selected = openCodeWorkflowResultToolId("submit_validation_plan");
    const inventories: string[][] = [];
    let capability = "";
    const plan = {
      headRef: "a".repeat(40),
      commands: [],
      limitations: ["No validation commands are defined for this isolated fixture."],
    };
    const model = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/chat/completions"))
          return new Response(null, { status: 404 });
        const body = (await request.json()) as { tools?: Array<{ function: { name: string } }> };
        inventories.push(body.tools?.map((tool) => tool.function.name) ?? []);
        const first = inventories.length === 1;
        const chunk = {
          id: "chatcmpl-lifecycle",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
        };
        return completionStream([
          {
            ...chunk,
            choices: [
              {
                index: 0,
                delta: first
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_submit",
                          type: "function",
                          function: {
                            name: selected,
                            arguments: JSON.stringify({ resultKey, capability, result: plan }),
                          },
                        },
                      ],
                    }
                  : { role: "assistant", content: "Done." },
                finish_reason: null,
              },
            ],
          },
          {
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
          },
        ]);
      },
    });
    let server: ReturnType<typeof Bun.spawn> | undefined;
    const providers: OpenCodeProvider[] = [];
    try {
      await tools.start();
      await results.prepare({
        resultKey,
        kind: "validation-plan",
        environmentId: "env-live",
        projectId: "project-live",
        provider: "opencode",
      });
      const agentMcp = tools.workflowResultConnection(
        "env-live",
        "project-live",
        "host",
        resultKey,
        "opencode",
      );
      capability = agentMcp.workflowResultCapability!;
      const config = join(root, "config"),
        data = join(root, "data"),
        state = join(root, "state"),
        cache = join(root, "cache");
      await Promise.all([config, data, state, cache].map((directory) => mkdir(directory)));
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
      const client = createOpencodeClient({ baseUrl, directory: root });
      const connection = {
        agent: "opencode" as const,
        baseUrl,
        authToken: "unused",
        directory: root,
      };
      const makeProvider = () => {
        const provider = new OpenCodeProvider(connection, { openCodeClient: client });
        providers.push(provider);
        return provider;
      };
      const owner = makeProvider(),
        observer = makeProvider();
      const policy = effectiveOpenCodePolicy(
        resolveNativeAgentExecutionPolicy(
          { environmentType: "local", networkAccessMode: "full" },
          "looped-review",
        ),
      );
      const sessionId = await owner.createSession("validation", "Isolated workflow lifecycle", {
        reviewerSession: true,
        policy,
      });
      const options = {
        requestId: resultKey,
        workflowResultTool: "submit_validation_plan",
        agentMcp,
        model: "fixture/fixture",
        mode: "plan" as const,
        readOnly: true,
        reviewShellPolicy: policy,
      };
      await owner.prepareDispatch(sessionId, options);
      // Observe precisely between the permission grant and the real HTTP prompt.
      // This was the production race: another provider saw idle and revoked it.
      const promptAsync = client.session.promptAsync.bind(client.session);
      client.session.promptAsync = (async (...args: Parameters<typeof promptAsync>) => {
        expect((await readProviderStatus(observer, sessionId)).status).toBe("idle");
        const snapshot = await client.session.get({ sessionID: sessionId });
        expect(snapshot.data?.metadata?.["orkestrator.reviewSession"]).toEqual({
          version: 1,
          policy,
        });
        expect(
          snapshot.data?.permission?.findLast((rule) => rule.permission === selected)?.action,
        ).toBe("allow");
        return promptAsync(...args);
      }) as typeof promptAsync;
      await owner.send(sessionId, "Submit the validation plan.", options);
      client.session.promptAsync = promptAsync;
      await observer.dispose();
      await owner.dispose();
      const restored = makeProvider();
      const deadline = Date.now() + 15000;
      while (!(await restored.settleTurn(sessionId, resultKey))) {
        if (Date.now() >= deadline) throw new Error("Workflow turn did not settle");
        await Bun.sleep(25);
      }
      expect(inventories[0]).toContain(selected);
      expect(inventories[0]).toContain(openCodeWorkflowResultToolId("validate_workflow_result"));
      expect(inventories[0]).not.toContain(openCodeWorkflowResultToolId("submit_review_report"));
      const messages = await client.session.messages({ sessionID: sessionId });
      for (const message of messages.data ?? []) {
        if (message.info.role === "assistant") expect(message.info.error).toBeUndefined();
        for (const part of message.parts) {
          if (part.type === "tool" && part.tool === selected) {
            expect(part.state.status === "error" ? part.state.error : undefined).toBeUndefined();
            expect(part.state.status).toBe("completed");
          }
        }
      }
      expect(await results.projection(resultKey)).toBe("received");
      expect(await results.structured(resultKey)).toMatchObject({ ok: true, value: plan });
      const settled = await client.session.get({ sessionID: sessionId });
      expect(settled.data?.metadata?.["orkestrator.reviewSession"]).toEqual({
        version: 1,
        policy,
      });
      expect(
        settled.data?.permission?.findLast((rule) => rule.permission === selected)?.action,
      ).toBe("deny");
      const beforeOrdinary = inventories.length;
      await restored.send(sessionId, "Say done.", {
        requestId: "ordinary",
        model: "fixture/fixture",
      });
      while (!(await restored.settleTurn(sessionId, "ordinary"))) {
        if (Date.now() >= deadline) throw new Error("Ordinary turn did not settle");
        await Bun.sleep(25);
      }
      expect(inventories.length).toBeGreaterThan(beforeOrdinary);
      expect(inventories.at(-1)).not.toContain(selected);
    } finally {
      await Promise.all(providers.map((provider) => provider.dispose()));
      if (server && server.exitCode === null) {
        server.kill();
        await Promise.race([server.exited, Bun.sleep(2000)]);
        if (server.exitCode === null) {
          server.kill("SIGKILL");
          await server.exited;
        }
      }
      model.stop(true);
      await tools.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

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

liveTest(
  "a partial prompt tools map replaces session.permission; omitting tools keeps the review suffix",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-opencode-workflow-tools-mask-"));
    const port = await availableLoopbackPort();
    const cliPath = process.env.OPENCODE_CLI_PATH?.trim() || "opencode";
    let server: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const config = join(root, "config");
      const data = join(root, "data");
      const state = join(root, "state");
      const cache = join(root, "cache");
      await Promise.all([config, data, state, cache].map((directory) => mkdir(directory)));
      await writeFile(join(root, "opencode.json"), JSON.stringify({}));
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
        title: "Workflow tools mask probe",
        permission: openCodePermissionRules(policy),
      });
      if (created.error || !created.data?.id) throw new Error("OpenCode did not create a session");
      const sessionId = created.data.id;
      const workflow = openCodeWorkflowResultPermissionRules("submit_review_report");
      const review = openCodeReviewPermissionRules(policy);
      const updated = await client.session.update({
        sessionID: sessionId,
        permission: [...review, ...workflow],
      });
      if (updated.error) throw new Error("OpenCode did not update permissions");
      const afterUpdate = await client.session.get({ sessionID: sessionId });
      expect(afterUpdate.data?.permission?.slice(-workflow.length)).toEqual(workflow);

      const withoutTools = await client.session.promptAsync({
        sessionID: sessionId,
        parts: [{ type: "text", text: "Do not call tools." }],
      });
      if (withoutTools.error) throw new Error("OpenCode rejected the unmasked prompt");
      const preserved = await client.session.get({ sessionID: sessionId });
      expect(preserved.data?.permission?.slice(-workflow.length)).toEqual(workflow);

      const masked = await client.session.promptAsync({
        sessionID: sessionId,
        tools: openCodeWorkflowResultTurnTools("submit_review_report"),
        parts: [{ type: "text", text: "Do not call tools." }],
      });
      if (masked.error) throw new Error("OpenCode rejected the masked prompt");
      // prompt_async acknowledges before processing the tools map. Observe
      // its persisted effect instead of racing the background prompt handler.
      let replaced = await client.session.get({ sessionID: sessionId });
      const deadline = Date.now() + 5000;
      while (
        JSON.stringify(replaced.data?.permission?.slice(-workflow.length)) ===
          JSON.stringify(workflow) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(25);
        replaced = await client.session.get({ sessionID: sessionId });
      }
      expect(replaced.data?.permission?.slice(-workflow.length)).not.toEqual(workflow);
    } finally {
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
