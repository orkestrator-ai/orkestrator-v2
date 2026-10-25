import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

const ENV_KEYS = ["PI_BRIDGE_TOKEN", "PI_BRIDGE_LIBRARY_ONLY", "PI_BRIDGE_STATE_DIR"] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { route } = await import("./http.js");
const { authToken: TOKEN } = await import("./config.js");
const { newSessionState, setAgentSessionTestHooks } = await import("./agent-session.js");
const { sessions } = await import("./state.js");
const { buildCommandCatalogue } = await import("./commands.js");
const { setCommandPreviewReaderForTests } = await import("./command-preview.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { refreshModels } = await import("./models.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal).catch(() => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  sessions.clear();
  setAgentSessionTestHooks(undefined);
  setCommandPreviewReaderForTests(undefined);
  setModelRuntimeFactoryForTests();
  refreshModels();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function call(path: string, body?: unknown): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
}

test.each([false, true])(
  "revalidates a preview selection through the first prompt attach (shadowed: %s)",
  async (shadowed) => {
    const state = newSessionState(undefined, {
      id: "interactive-host",
      sandbox: "provider",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
    });
    sessions.set(state.id, state);
    const path = "/fixture/.pi/prompts/review.md";
    const templates = [
      {
        name: "review",
        description: "Review the tree",
        content: "Review $@",
        filePath: path,
        sourceInfo: { path, source: "local", scope: "project", origin: "top-level" },
      },
    ];
    let reads = 0;
    let attaches = 0;
    let binds = 0;
    const extensions: Array<{ name: string; description: string }> = [];
    const prompts: Array<{ text: string; expandPromptTemplates?: boolean }> = [];
    let finish!: () => void;
    const run = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = {
      sessionId: "pi-preview-first-turn",
      sessionFile: "/tmp/pi-preview-first-turn.jsonl",
      promptTemplates: templates,
      resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
      extensionRunner: {
        getRegisteredCommands: () => extensions,
        getCommand: (name: string) => extensions.find((command) => command.name === name),
      },
      bindExtensions: async () => {
        binds += 1;
        // Commands only become visible after the real attach binds extensions.
        if (shadowed) extensions.push({ name: "review", description: "Extension review" });
      },
      subscribe: () => () => undefined,
      dispose: () => undefined,
      prompt: (
        text: string,
        options: {
          expandPromptTemplates?: boolean;
          preflightResult?: (disposition: string) => void;
        },
      ) => {
        prompts.push({ text, expandPromptTemplates: options.expandPromptTemplates });
        options.preflightResult?.("started");
        return run;
      },
      setThinkingLevel: () => undefined,
      getAvailableThinkingLevels: () => ["off"],
      getContextUsage: () => undefined,
      getSessionStats: () => ({ cost: 0 }),
    } as unknown as AgentSession;
    setAgentSessionTestHooks({
      createAgentSession: async () => {
        attaches += 1;
        return session;
      },
    });
    // No model call is needed: the fake SDK accepts at preflight.
    setModelRuntimeFactoryForTests(
      async () => ({ getAvailable: async () => [] }) as unknown as ModelRuntime,
    );
    refreshModels();
    setCommandPreviewReaderForTests(async () => {
      reads += 1;
      return buildCommandCatalogue({ promptTemplates: templates as never });
    });

    try {
      state.lastAccessed = 1;
      const listed = await call(`/session/${state.id}/commands`);
      expect(listed.status).toBe(200);
      const catalogue = await listed.json();
      expect(catalogue).toMatchObject({ status: "stale", attachPending: true });
      const row = catalogue.commands.find(
        (command: { id: string }) => command.id === "pi:template:review",
      );
      expect(row.bindingRevision).toBeString();
      expect(attaches).toBe(0);
      expect(state.session).toBeNull();
      expect(state.lastAccessed).toBe(1);
      const args = "src/file.ts  keep  spacing\nand this line";
      const response = await call(`/session/${state.id}/prompt`, {
        prompt: `/review ${args}`,
        requestId: "preview-first-prompt",
        command: {
          id: row.id,
          name: row.name,
          executionKind: row.executionKind,
          bindingRevision: row.bindingRevision,
          arguments: args,
        },
      });
      expect(attaches).toBe(1);
      expect(binds).toBe(1);
      expect(reads).toBe(1);
      expect(state.session).toBe(session);
      expect(state.commandPreview).toBeUndefined();
      expect(state.commandCatalogue.status).toBe("ready");
      if (shadowed) {
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ kind: "command-unavailable" });
        expect(prompts).toEqual([]);
        expect(state.promptJournal.has("preview-first-prompt")).toBe(false);
        expect(state.messages).toEqual([]);
        expect(state.dispatching).toBe(false);
        expect(state.promptClaim).toBeUndefined();
        expect(state.slashCommands.map((command) => command.id)).toEqual(["pi:extension:review"]);
      } else {
        expect(response.status).toBe(202);
        expect(prompts).toEqual([{ text: `/review ${args}`, expandPromptTemplates: true }]);
        expect(state.slashCommands.find((command) => command.id === row.id)?.bindingRevision).toBe(
          row.bindingRevision,
        );
        expect(state.promptJournal.get("preview-first-prompt")?.state).toBe("accepted");
      }
    } finally {
      finish();
      // dispatchPrompt's settlement releases the prompt claim asynchronously.
      const deadline = Date.now() + 1_000;
      while ((state.status === "running" || state.dispatching) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(state.dispatching).toBe(false);
      expect(state.status).toBe("idle");
    }
  },
);
