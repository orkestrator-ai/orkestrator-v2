/**
 * Offline qualification of the data-directory read boundary on the pinned
 * OpenCode CLI: a real `opencode serve`, the coordinator's own permission
 * rules, a scripted loopback model and a fixture data directory. No provider
 * turn, and nothing here reads a real credential.
 *
 * Two layers hold it. The coordinator's `{"*": "deny"}` base: the data
 * directory is never inside a checkout, so every read of it is an
 * `external_directory` access, and no coordinator rule allows that
 * permission. OpenCode judges that from the path as written, though, so a
 * link inside the checkout reached the directory until the read-boundary
 * plugin (`opencode-read-boundary-plugin.ts`) resolved it. The cases without
 * the plugin pin what each layer holds on its own; re-run on every OpenCode bump.
 */
import { describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  policyQualificationCli,
  withPolicyCliFixture,
} from "../../../../tests/conformance/execution-policy/vendor-cli.js";
import { COORDINATOR_PROTECTED_DATA_DIR_ENV } from "@orkestrator/protocol/coordinator";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  installHostOpenCodePlugins,
  writeHostOpenCodeCredentialPlugin,
} from "./opencode-host-credential.js";
import { OpenCodeProvider } from "./opencode-provider.js";

const opencode = policyQualificationCli("opencode");
const SECRET = "FIXTURE-OPERATOR-CREDENTIAL";
const OWN = "FIXTURE-CHECKOUT-FILE";

interface ScriptedCall {
  tool: string;
  args: Record<string, unknown>;
}

interface ToolOutcome {
  tool: string;
  status: string;
  output: string;
}

const coordinatorPolicy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "restricted" },
  "coordinator",
);

function completionStream(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** One tool call per model request, then a final answer. */
function scriptedModel(calls: readonly ScriptedCall[]) {
  let requests = 0;
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
        return new Response(null, { status: 404 });
      }
      await request.body?.cancel();
      const call = calls[requests];
      requests += 1;
      const chunk = { id: `chatcmpl-${requests}`, object: "chat.completion.chunk", created: 1 };
      return completionStream([
        {
          ...chunk,
          choices: [
            {
              index: 0,
              delta: call
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${requests}`,
                        type: "function",
                        function: { name: call.tool, arguments: JSON.stringify(call.args) },
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
          choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
        },
      ]);
    },
  });
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (port <= 0) throw new Error("Could not allocate an OpenCode test port");
  return port;
}

async function waitForHealth(baseUrl: string, child: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited (${child.exitCode})`);
    const healthy = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (healthy) return;
    await Bun.sleep(100);
  }
  throw new Error("OpenCode did not become healthy");
}

interface Fixture {
  dataDir: string;
  cwd: string;
  secrets: { credentials: string; database: string; account: string };
  link: string;
  own: string;
}

interface QualifyOptions {
  /** Load the host plugins, as a coordinator's server does. */
  plugin?: boolean;
  /**
   * Run with a user's own `OPENCODE_CONFIG_DIR`. With `plugin`, the host
   * plugins are added the way the launcher adds them beside one.
   */
  userConfigDir?: boolean;
  /** Rules appended to the coordinator's own. */
  extraRules?: { permission: string; pattern: string; action: "allow" | "deny" }[];
}

const USER_PLUGIN_MARKER = "user-plugin-loaded";

/**
 * A user's own `OPENCODE_CONFIG_DIR`, with a plugin that leaves a marker when
 * OpenCode loads it, so a run can show the user's directory still applied.
 */
async function userConfigDir(root: string): Promise<string> {
  const directory = join(root, "user-opencode");
  await mkdir(join(directory, "plugins"), { recursive: true });
  await writeFile(
    join(directory, "plugins", "user-marker.js"),
    `import { writeFileSync } from "node:fs";
export const UserMarker = async () => {
  writeFileSync(${JSON.stringify(join(root, USER_PLUGIN_MARKER))}, "loaded");
  return {};
};
`,
  );
  return directory;
}

/** Runs one scripted coordinator turn and returns what each tool answered. */
async function qualify(
  calls: (fixture: Fixture) => ScriptedCall[],
  { plugin = true, userConfigDir: withUserConfigDir = false, extraRules = [] }: QualifyOptions = {},
  inspect?: (root: string) => Promise<void>,
): Promise<ToolOutcome[]> {
  return withPolicyCliFixture(async (cli) => {
    const root = await realpath(cli.root);
    const cwd = await realpath(cli.cwd);
    const dataDir = join(root, "data-dir");
    const seed = async (path: string, content: string) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content);
      return path;
    };
    const fixture: Fixture = {
      dataDir,
      cwd,
      secrets: {
        credentials: await seed(join(dataDir, "control-mcp.json"), SECRET),
        database: await seed(join(dataDir, "orkestrator.sqlite"), SECRET),
        account: await seed(join(dataDir, "agent-accounts", "opencode", "a1", "auth.json"), SECRET),
      },
      link: join(cwd, "innocent.json"),
      own: await seed(join(cwd, "README.md"), OWN),
    };
    await symlink(fixture.secrets.credentials, fixture.link);
    await symlink(dataDir, join(cwd, "linked-dir"));
    const scripted = calls(fixture);
    const model = scriptedModel(scripted);
    await writeFile(
      join(cwd, "opencode.json"),
      JSON.stringify({
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "Local fixture",
            options: { baseURL: `${model.url}v1`, apiKey: "test-key" },
            models: { fixture: { name: "Fixture", limit: { context: 16000, output: 2000 } } },
          },
        },
      }),
    );
    const port = await availableLoopbackPort();
    // The launcher's coordinator environment: the protected directory, and the
    // host configuration directory that carries the plugins.
    const env: Record<string, string | undefined> = {
      ...cli.env,
      [COORDINATOR_PROTECTED_DATA_DIR_ENV]: dataDir,
      ...(plugin && !withUserConfigDir
        ? { OPENCODE_CONFIG_DIR: await writeHostOpenCodeCredentialPlugin(join(root, "host")) }
        : {}),
    };
    if (withUserConfigDir) {
      env.OPENCODE_CONFIG_DIR = await userConfigDir(root);
      if (plugin) {
        // The production launcher path, on a user directory it must keep.
        const installed = await installHostOpenCodePlugins(env, join(root, "host"), {
          coordinator: true,
        });
        expect(installed).toEqual({ mode: "config-content" });
      }
    }
    const child = Bun.spawn(
      [opencode!, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd, env, stdout: "ignore", stderr: "ignore" },
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = createOpencodeClient({ baseUrl, directory: cwd });
    const provider = new OpenCodeProvider(
      { agent: "opencode", baseUrl, authToken: "unused", directory: cwd },
      { openCodeClient: client },
    );
    try {
      await waitForHealth(baseUrl, child);
      const sessionId = await provider.createSession("coordinator", "Read boundary fixture", {
        policy: coordinatorPolicy,
      });
      if (extraRules.length > 0) {
        const updated = await client.session.update({
          sessionID: sessionId,
          permission: extraRules,
        });
        if (updated.error) throw new Error("Permission update failed");
      }
      await provider.send(sessionId, "Run the fixture", {
        requestId: "read-boundary",
        model: "fixture/fixture",
      });
      const deadline = Date.now() + 30_000;
      while (!(await provider.settleTurn(sessionId, "read-boundary"))) {
        if (Date.now() >= deadline) throw new Error("The fixture turn did not settle");
        await Bun.sleep(50);
      }
      const messages = await client.session.messages({ sessionID: sessionId });
      const outcomes = (messages.data ?? []).flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool"
            ? [
                {
                  tool: part.tool,
                  status: part.state.status,
                  output:
                    part.state.status === "completed"
                      ? part.state.output
                      : part.state.status === "error"
                        ? part.state.error
                        : "",
                },
              ]
            : [],
        ),
      );
      expect(outcomes.map((outcome) => outcome.tool)).toEqual(scripted.map((call) => call.tool));
      await inspect?.(root);
      return outcomes;
    } finally {
      await provider.dispose();
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([child.exited, Bun.sleep(2_000)]);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
      model.stop(true);
    }
  });
}

describe("OpenCode coordinator read boundary", () => {
  (opencode ? test : test.skip)(
    "refuses read, grep and glob on the data directory",
    async () => {
      const outcomes = await qualify((fixture) => [
        { tool: "read", args: { filePath: fixture.secrets.credentials } },
        { tool: "read", args: { filePath: fixture.secrets.database } },
        { tool: "read", args: { filePath: fixture.secrets.account } },
        { tool: "grep", args: { pattern: "CREDENTIAL", path: fixture.dataDir } },
        { tool: "glob", args: { pattern: "**/*.json", path: fixture.dataDir } },
      ]);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("error");
        expect(outcome.output).not.toContain(SECRET);
      }
    },
    90_000,
  );

  (opencode ? test : test.skip)(
    "refuses a link from the checkout into the data directory",
    async () => {
      const outcomes = await qualify((fixture) => [
        { tool: "read", args: { filePath: fixture.link } },
        { tool: "read", args: { filePath: "linked-dir/control-mcp.json" } },
        { tool: "grep", args: { pattern: "CREDENTIAL", path: join(fixture.cwd, "linked-dir") } },
        // Searches from the checkout itself do not follow links.
        { tool: "grep", args: { pattern: "CREDENTIAL" } },
        { tool: "glob", args: { pattern: "**/control-mcp.json" } },
      ]);
      for (const outcome of outcomes.slice(0, 3)) {
        expect(outcome.status).toBe("error");
        expect(outcome.output).toContain("data directory");
      }
      for (const outcome of outcomes) expect(outcome.output).not.toContain(SECRET);
      const glob = outcomes[4]!;
      expect(glob.tool).toBe("glob");
      expect(glob.status).toBe("completed");
      expect(glob.output).not.toContain("linked-dir/control-mcp.json");
    },
    90_000,
  );

  // To-do 7402: a user's own OPENCODE_CONFIG_DIR is kept, and the read check
  // still loads, through OPENCODE_CONFIG_CONTENT's plugin list.
  (opencode ? test : test.skip)(
    "refuses a link into the data directory beside a user OPENCODE_CONFIG_DIR",
    async () => {
      const outcomes = await qualify(
        (fixture) => [
          { tool: "read", args: { filePath: fixture.link } },
          { tool: "read", args: { filePath: "linked-dir/control-mcp.json" } },
          { tool: "grep", args: { pattern: "CREDENTIAL", path: join(fixture.cwd, "linked-dir") } },
          { tool: "read", args: { filePath: fixture.own } },
        ],
        { userConfigDir: true },
        async (root) => {
          // The user's own plugin loaded too: their directory was not replaced.
          expect(await readFile(join(root, USER_PLUGIN_MARKER), "utf8")).toBe("loaded");
        },
      );
      for (const outcome of outcomes.slice(0, 3)) {
        expect(outcome.status).toBe("error");
        expect(outcome.output).toContain("data directory");
      }
      for (const outcome of outcomes) expect(outcome.output).not.toContain(SECRET);
      expect(outcomes[3]!.status).toBe("completed");
      expect(outcomes[3]!.output).toContain(OWN);
    },
    90_000,
  );

  // The control for the case above: the user's directory alone does not refuse.
  (opencode ? test : test.skip)(
    "with only a user OPENCODE_CONFIG_DIR, reads through a link in the checkout",
    async () => {
      const outcomes = await qualify(
        (fixture) => [{ tool: "read", args: { filePath: fixture.link } }],
        { plugin: false, userConfigDir: true },
        async (root) => {
          expect(await readFile(join(root, USER_PLUGIN_MARKER), "utf8")).toBe("loaded");
        },
      );
      expect(outcomes[0]!.status).toBe("completed");
      expect(outcomes[0]!.output).toContain(SECRET);
    },
    90_000,
  );

  // What the permission rules alone leave open, and why the plugin exists.
  (opencode ? test : test.skip)(
    "without the plugin, reads through a link in the checkout",
    async () => {
      const outcomes = await qualify(
        (fixture) => [
          { tool: "read", args: { filePath: fixture.link } },
          { tool: "read", args: { filePath: fixture.secrets.credentials } },
        ],
        { plugin: false },
      );
      expect(outcomes[0]!.status).toBe("completed");
      expect(outcomes[0]!.output).toContain(SECRET);
      expect(outcomes[1]!.status).toBe("error");
    },
    90_000,
  );

  (opencode ? test : test.skip)(
    "still reads the checkout",
    async () => {
      const outcomes = await qualify((fixture) => [
        { tool: "read", args: { filePath: fixture.own } },
        { tool: "grep", args: { pattern: OWN, path: fixture.cwd } },
      ]);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("completed");
        expect(outcome.output).toContain(fixture_own_marker(outcome.tool));
      }
    },
    90_000,
  );

  // The control: the direct refusal is the external_directory rule, not a
  // fixture that cannot be read at all.
  (opencode ? test : test.skip)(
    "reads the fixture credentials once external_directory is allowed",
    async () => {
      const outcomes = await qualify(
        (fixture) => [{ tool: "read", args: { filePath: fixture.secrets.credentials } }],
        {
          plugin: false,
          extraRules: [{ permission: "external_directory", pattern: "*", action: "allow" }],
        },
      );
      expect(outcomes[0]!.status).toBe("completed");
      expect(outcomes[0]!.output).toContain(SECRET);
    },
    90_000,
  );
});

/** What a successful call on the checkout returns: the file's text, or a match in it. */
function fixture_own_marker(tool: string): string {
  return tool === "grep" ? "README.md" : OWN;
}
