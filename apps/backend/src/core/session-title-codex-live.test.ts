/**
 * Offline qualification of the production Codex title runner: the real pinned
 * CLI against a scripted loopback Responses endpoint, in a temporary home that
 * looks like a real user's. No model is called and no credit is spent.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { generateCodexSessionTitle } from "./session-title-runners.js";
import { runCommand } from "./shell.js";

/** The same lookup as the runner test: an explicit path, else the managed toolchain. */
function pinnedCodexCli(): string | undefined {
  const repoRoot = path.join(import.meta.dir, "../../../..");
  const { version } = JSON.parse(
    readFileSync(path.join(repoRoot, "config", "codex-version.json"), "utf8"),
  ) as { version: string };
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const dataDirectory =
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "orkestrator-v2")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "orkestrator-v2");
  return [
    process.env.CODEX_PROTOCOL_BINARY?.trim(),
    path.join(
      dataDirectory,
      "toolchains",
      "codex",
      version,
      `${platform}-${architecture}`,
      "codex",
    ),
    path.join(repoRoot, "binaries", "codex"),
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

interface ResponsesRequest {
  type?: string;
  generate?: boolean;
  tools?: Array<{ name?: string; type?: string }>;
  input?: Array<{ tools?: Array<{ name?: string; tools?: Array<{ name?: string }> }> }>;
}

function scriptedResponses(answer: () => string | null) {
  const requests: ResponsesRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request)) {
        return undefined;
      }
      return new Response("not served", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message)) as ResponsesRequest;
        if (frame.type !== "response.create") return;
        const id = `resp_${requests.length}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          requests.push(frame);
          const text = answer();
          if (text === null) {
            send({
              type: "response.failed",
              response: { id, error: { code: "invalid_prompt", message: "scripted refusal" } },
            });
            return;
          }
          send({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              id: `msg_${id}`,
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
              status: "completed",
            },
          });
        }
        send({
          type: "response.completed",
          response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        });
      },
    },
  });
  return { port: server.port!, requests, stop: () => server.stop(true) };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A home holding what a real user's does: a skill, MCP servers, config and instructions. */
async function userFixture(cli: string, port: number) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-title-live-"));
  roots.push(root);
  const codexHome = path.join(root, "codex");
  const home = path.join(root, "home");
  const scratch = path.join(root, "scratch");
  const skill = (description: string) =>
    `---\nname: private-skill\ndescription: ${description}\n---\nSKILL-BODY-MARKER\n`;
  await Promise.all([
    mkdir(path.join(codexHome, "skills", "private-skill"), { recursive: true }),
    mkdir(path.join(home, ".agents", "skills", "other-skill"), { recursive: true }),
    mkdir(scratch),
  ]);
  await Promise.all([
    writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    ),
    writeFile(
      path.join(codexHome, "skills", "private-skill", "SKILL.md"),
      skill("USER-SKILL-MARKER"),
    ),
    writeFile(
      path.join(home, ".agents", "skills", "other-skill", "SKILL.md"),
      skill("AGENTS-SKILL-MARKER"),
    ),
    writeFile(
      path.join(codexHome, "config.toml"),
      'developer_instructions = "CONFIG-MARKER"\n[mcp_servers.private]\ncommand = "/bin/false"\n',
    ),
  ]);
  // The endpoint is the only thing the production argv does not already say.
  const executable = path.join(root, "codex-at-loopback");
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${cli}" --config 'openai_base_url="http://127.0.0.1:${port}/v1"' "$@"\n`,
  );
  chmodSync(executable, 0o755);
  return {
    codexHome,
    scratch,
    input: {
      executable,
      env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: codexHome },
      run: runCommand,
      temporaryRoot: scratch,
      timeoutMs: 30_000,
    },
  };
}

function offeredTools(request: ResponsesRequest): string[] {
  return [
    ...(request.tools ?? []).map((tool) => tool.name ?? tool.type ?? "unnamed"),
    ...(request.input ?? [])
      .flatMap((item) => item.tools ?? [])
      .flatMap((tool) => tool.tools?.map((inner) => inner.name ?? "unnamed") ?? [tool.name ?? ""]),
  ];
}

const cli = pinnedCodexCli();
const liveTest = cli ? test : test.skip;

liveTest(
  "a title run gets no tools, no user skills or config, and leaves nothing to resume",
  async () => {
    const responses = scriptedResponses(() => JSON.stringify({ title: "Fix the login race." }));
    try {
      const fixture = await userFixture(cli!, responses.port);
      await expect(
        generateCodexSessionTitle({
          ...fixture.input,
          source: "PRIVATE-STDIN-MARKER fix the login race",
        }),
      ).resolves.toBe("Fix the login race");

      const request = responses.requests.at(-1)!;
      const sent = JSON.stringify(request);
      expect(offeredTools(request)).toEqual([]);
      for (const marker of [
        "USER-SKILL-MARKER",
        "AGENTS-SKILL-MARKER",
        "SKILL-BODY-MARKER",
        "skills_instructions",
        "CONFIG-MARKER",
        "permissions instructions",
      ]) {
        expect(sent).not.toContain(marker);
      }
      expect(sent).toContain("PRIVATE-STDIN-MARKER");
      expect(await readdir(fixture.scratch)).toEqual([]);
      expect(existsSync(path.join(fixture.codexHome, "sessions"))).toBe(false);
    } finally {
      responses.stop();
    }
  },
  40_000,
);

liveTest(
  "a skill named in the prompt is not sent to the title model",
  async () => {
    const responses = scriptedResponses(() => JSON.stringify({ title: "Tidy the repository" }));
    try {
      const fixture = await userFixture(cli!, responses.port);
      await expect(
        generateCodexSessionTitle({
          ...fixture.input,
          source: "use $private-skill and [$private-skill](skill://private-skill) to tidy this",
        }),
      ).resolves.toBe("Tidy the repository");
      const sent = JSON.stringify(responses.requests.at(-1));
      expect(sent).not.toContain("SKILL-BODY-MARKER");
      expect(sent).not.toContain("USER-SKILL-MARKER");
      // Still there for the model to summarize, as JSON-escaped text.
      expect(sent).toContain("u0024private-skill");
    } finally {
      responses.stop();
    }
  },
  40_000,
);

liveTest(
  "a refused request rejects, so the service keeps the fallback",
  async () => {
    const responses = scriptedResponses(() => null);
    try {
      const fixture = await userFixture(cli!, responses.port);
      await expect(
        generateCodexSessionTitle({ ...fixture.input, source: "prompt" }),
      ).rejects.toThrow();
      expect(await readdir(fixture.scratch)).toEqual([]);
    } finally {
      responses.stop();
    }
  },
  40_000,
);
