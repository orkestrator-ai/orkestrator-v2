import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDropImportedLoginCommand,
  buildMergeContainerClaudeCredentialCommand,
  buildRestrictContainerClaudeCredentialCommand,
} from "../src/core/agent-accounts-containers";
import { ContainerLoginFileWatcher } from "../src/core/container-login-file-watcher";
import { runCommand } from "../src/core/shell";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const live = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE ? test : test.skip;

async function docker(args: string[]) {
  return (await runCommand("docker", args, { timeoutMs: 60_000 })).stdout.trim();
}

async function pipe(container: string, command: string, input: unknown) {
  const child = Bun.spawn(["docker", "exec", "-i", container, "bash", "-ec", command], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(`Synthetic credential helper failed (${status}): ${stderr}`);
}

live(
  "privileged entrypoint never follows node's readiness symlink",
  async () => {
    const container = await docker([
      "run",
      "-d",
      "--label",
      "orkestrator-owner=security-symlink-qa",
      "--entrypoint",
      "sleep",
      IMAGE,
      "infinity",
    ]);
    try {
      await docker([
        "exec",
        "-u",
        "root",
        container,
        "bash",
        "-ec",
        `
printf 'root sentinel' > /root/readiness-sentinel
chmod 0600 /root/readiness-sentinel
NETWORK_MODE=full /usr/local/bin/network-policy-entrypoint.sh --record-only
`,
      ]);
      await docker([
        "exec",
        "-u",
        "node",
        container,
        "bash",
        "-ec",
        `
ln -s /root/readiness-sentinel /run/orkestrator/boot-status.json.root.tmp
timeout 3 sudo -n /usr/local/bin/network-policy-entrypoint.sh > /tmp/entrypoint-replay.log 2>&1 || [ "$?" = 124 ]
`,
      ]);
      expect(
        await docker(["exec", "-u", "root", container, "cat", "/root/readiness-sentinel"]),
      ).toBe("root sentinel");
      expect(
        await docker([
          "exec",
          "-u",
          "root",
          container,
          "stat",
          "-c",
          "%u:%a",
          "/root/readiness-sentinel",
        ]),
      ).toBe("0:600");
      expect(
        await docker(["exec", container, "test", "-s", "/run/orkestrator/boot-status.json"]),
      ).toBe("");
    } finally {
      await docker(["rm", "-f", container]);
    }
  },
  90_000,
);

live(
  "official in-image Node merges, restricts and drops real credential paths while retaining owned MCP logins",
  async () => {
    const container = await docker([
      "run",
      "-d",
      "--label",
      "orkestrator-owner=security-node-qa",
      "--entrypoint",
      "sleep",
      IMAGE,
      "infinity",
    ]);
    const file = "/home/node/.claude/.credentials.json";
    try {
      expect(
        await docker([
          "exec",
          container,
          "node",
          "-e",
          "console.log(Boolean(process.versions.node) && !process.versions.bun)",
        ]),
      ).toBe("true");
      await pipe(container, buildMergeContainerClaudeCredentialCommand(), {
        login: {
          claudeAiOauth: { accessToken: "old" },
          mcpOAuth: { owned: { accessToken: "own", refreshToken: "own-refresh" } },
        },
        hostMcpRefresh: {},
      });
      await pipe(container, buildMergeContainerClaudeCredentialCommand(), {
        login: {
          claudeAiOauth: { accessToken: "renewed" },
          mcpOAuth: { imported: { accessToken: "imported" } },
        },
        hostMcpRefresh: {},
      });
      expect(
        await docker([
          "exec",
          container,
          "bash",
          "-ec",
          `jq -e '.claudeAiOauth.accessToken == "renewed" and .mcpOAuth.owned.refreshToken == "own-refresh" and .mcpOAuth.imported.accessToken == "imported"' ${file} > /dev/null; stat -c %a ${file}`,
        ]),
      ).toBe("600");
      await docker([
        "exec",
        container,
        "bash",
        "-ec",
        buildRestrictContainerClaudeCredentialCommand(),
      ]);
      expect(
        await docker([
          "exec",
          container,
          "jq",
          "-r",
          '.mcpOAuth.owned | has("refreshToken")',
          file,
        ]),
      ).toBe("false");
      const grok = "/home/node/.grok/auth.json";
      await docker([
        "exec",
        container,
        "bash",
        "-ec",
        `mkdir -p /home/node/.grok; printf '%s' '{"imported":{"refresh_token":""},"owned":{"refresh_token":"own"}}' > ${grok}`,
      ]);
      await docker(["exec", container, "bash", "-ec", buildDropImportedLoginCommand(grok, "grok")]);
      expect(await docker(["exec", container, "jq", "-r", 'keys | join(",")', grok])).toBe("owned");
      expect(
        await docker(["exec", container, "bash", "-ec", "test ! -e /home/node/-e; test ! -e /-e"]),
      ).toBe("");
    } finally {
      await docker(["rm", "-f", container]);
    }
  },
  90_000,
);

live(
  "watcher retries an unchanged Pi login after lock release and reconciles Grok sign-out across backend restarts",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-login-live-"));
    const savedHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
    const savedData = process.env.XDG_DATA_HOME;
    const container = await docker([
      "run",
      "-d",
      "--label",
      "orkestrator-owner=security-watcher-qa",
      "--entrypoint",
      "sleep",
      IMAGE,
      "infinity",
    ]);
    const env = lifecycleEnvironment({ containerId: container, status: "running" });
    const { context } = memoryLifecycleContext([env], root);
    Object.assign(context, {
      runtimeFlavor: "agent-test",
      credentialSources: new Set(["grok", "opencode", "pi"]),
    });
    Object.assign(context.storage, {
      loadConfig: async () => ({ global: { enabledAgentPlatforms: ["grok", "opencode", "pi"] } }),
    });
    process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = root;
    process.env.XDG_DATA_HOME = path.join(root, "data");
    const write = async (file: string, value: unknown) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(value));
      await fs.rename(`${file}.tmp`, file);
    };
    const grok = path.join(root, ".grok/auth.json");
    const pi = path.join(root, ".pi/agent/auth.json");
    const opencode = path.join(root, "data/opencode/auth.json");
    const read = (file: string) => docker(["exec", container, "cat", file]).then(JSON.parse);
    try {
      const watcher = new ContainerLoginFileWatcher(context);
      // Keep the actual Grok bridge alive across deliveries and sign-out.
      await docker([
        "exec",
        "-d",
        "-e",
        "PORT=17335",
        "-e",
        "HOSTNAME=127.0.0.1",
        "-e",
        "ACP_BRIDGE_TOKEN=synthetic-qa",
        container,
        "node",
        "/opt/acp-bridge/dist/index.js",
      ]);
      const grokStatus = async () =>
        JSON.parse(
          await docker([
            "exec",
            container,
            "curl",
            "-fsS",
            "-H",
            "Authorization: Bearer synthetic-qa",
            "http://127.0.0.1:17335/global/auth",
          ]),
        ).state;
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await grokStatus().catch(() => "")) === "needs-auth") break;
        await Bun.sleep(100);
      }
      expect(await grokStatus()).toBe("needs-auth");
      const expiry = Date.now() + 3_600_000;
      await write(grok, {
        xai: {
          access_token: "first",
          refresh_token: "host",
          expires_at: new Date(expiry).toISOString(),
        },
      });
      await write(pi, {
        anthropic: { type: "oauth", access: "first", refresh: "host", expires: expiry },
      });
      await write(opencode, {
        anthropic: { type: "oauth", access: "first", refresh: "host", expires: expiry },
      });
      await watcher.tick();
      const piFile = "/home/node/.pi/agent/auth.json";
      const openFile = "/home/node/.local/share/opencode/auth.json";
      const grokFile = "/home/node/.grok/auth.json";
      expect((await read(piFile)).anthropic.access).toBe("first");
      expect((await read(openFile)).anthropic.access).toBe("first");
      expect(await grokStatus()).toBe("signed-in");
      // The same memoized runtime used by the real Pi bridge resolves both
      // token generations. No catalogue networking or billed turns are needed.
      const piReader = `
import { createServer } from "node:http";
import { modelRuntime, setModelRuntimeFactoryForTests } from "/opt/pi-bridge/dist/index.js";
import { ModelRuntime } from "/opt/pi-bridge/dist/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
setModelRuntimeFactoryForTests(() => ModelRuntime.create({ authPath: "/home/node/.pi/agent/auth.json", allowModelNetwork: false, refreshOnCreate: false }));
const runtime = await modelRuntime();
createServer(async (_req, res) => {
  try { res.end(JSON.stringify({ pid: process.pid, auth: await runtime.getAuth("anthropic") })); }
  catch { res.statusCode = 500; res.end("credential resolution failed"); }
}).listen(17336, "127.0.0.1");`;
      await docker([
        "exec",
        "-d",
        "-e",
        "PI_BRIDGE_LIBRARY_ONLY=1",
        container,
        "node",
        "--input-type=module",
        "-e",
        piReader,
      ]);
      const piStatus = async () =>
        JSON.parse(await docker(["exec", container, "curl", "-fsS", "http://127.0.0.1:17336/"]));
      let initialPi: { pid: number; auth: unknown } | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        initialPi = await piStatus().catch(() => undefined);
        if (initialPi) break;
        await Bun.sleep(100);
      }
      expect(initialPi).toBeDefined();
      expect(JSON.stringify(initialPi?.auth)).toContain("first");

      await docker(["exec", container, "mkdir", `${piFile}.lock`]);
      await write(pi, {
        anthropic: { type: "oauth", access: "renewed", refresh: "host", expires: expiry },
      });
      await write(opencode, {
        anthropic: { type: "oauth", access: "renewed", refresh: "host", expires: expiry },
      });
      await write(grok, {
        xai: {
          access_token: "renewed",
          refresh_token: "host",
          expires_at: new Date(expiry).toISOString(),
        },
      });
      await watcher.tick();
      expect((await read(piFile)).anthropic.access).toBe("first");
      expect((await read(openFile)).anthropic.access).toBe("renewed");
      expect((await read(grokFile)).xai.access_token).toBe("renewed");
      expect(JSON.stringify((await piStatus()).auth)).toContain("first");
      await docker(["exec", container, "rmdir", `${piFile}.lock`]);
      expect(await watcher.tick()).toEqual(["pi"]);
      expect((await read(piFile)).anthropic).toEqual({
        type: "oauth",
        access: "renewed",
        refresh: "",
        expires: expiry,
      });
      const renewedPi = await piStatus();
      expect(renewedPi.pid).toBe(initialPi?.pid);
      expect(JSON.stringify(renewedPi.auth)).toContain("renewed");
      await fs.rm(grok);
      await new ContainerLoginFileWatcher(context).tick();
      expect(await grokStatus()).toBe("needs-auth");
      await write(grok, {
        xai: {
          access_token: "renewed",
          refresh_token: "host",
          expires_at: new Date(expiry).toISOString(),
        },
      });
      await watcher.tick();
      await docker([
        "exec",
        container,
        "bash",
        "-ec",
        `jq '. + {owned: {access_token: "own", refresh_token: "own-refresh"}}' ${grokFile} > /tmp/own-auth; cat /tmp/own-auth > ${grokFile}`,
      ]);
      await fs.rm(grok);
      await new ContainerLoginFileWatcher(context).tick();
      expect(Object.keys(await read(grokFile))).toEqual(["owned"]);
      expect(await grokStatus()).toBe("signed-in");
    } finally {
      context.runtime.shutdown();
      if (savedHome === undefined) delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
      else process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = savedHome;
      if (savedData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedData;
      await docker(["rm", "-f", container]);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

live(
  "a running OpenCode OAuth transport picks up the watcher's renewed host login",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-opencode-renewal-"));
    const savedData = process.env.XDG_DATA_HOME;
    const container = await docker([
      "run",
      "-d",
      "--label",
      "orkestrator-owner=security-opencode-qa",
      "-p",
      "127.0.0.1::17341",
      "--entrypoint",
      "sleep",
      IMAGE,
      "infinity",
    ]);
    const environment = lifecycleEnvironment({ containerId: container, status: "running" });
    const { context } = memoryLifecycleContext([environment], root);
    Object.assign(context, {
      runtimeFlavor: "agent-test",
      credentialSources: new Set(["opencode"]),
    });
    Object.assign(context.storage, {
      loadConfig: async () => ({ global: { enabledAgentPlatforms: ["opencode"] } }),
    });
    process.env.XDG_DATA_HOME = root;
    const host = path.join(root, "opencode", "auth.json");
    const renew = async (access: string) => {
      await fs.mkdir(path.dirname(host), { recursive: true });
      await fs.writeFile(
        `${host}.tmp`,
        JSON.stringify({
          anthropic: {
            type: "oauth",
            access,
            refresh: "host-refresh",
            expires: Date.now() + 3_600_000,
          },
        }),
      );
      await fs.rename(`${host}.tmp`, host);
    };
    try {
      const watcher = new ContainerLoginFileWatcher(context);
      await renew("sk-ant-oat01-first");
      await watcher.tick();
      const config = {
        model: "anthropic/claude-haiku-4-5",
        small_model: "anthropic/claude-haiku-4-5",
        // Exercise the real pinned OAuth plugin, against a loopback model API.
        plugin: ["opencode-anthropic-auth@0.0.13"],
        enabled_providers: ["anthropic"],
        share: "disabled",
        autoupdate: false,
        provider: { anthropic: { options: { baseURL: "http://127.0.0.1:17340/v1" } } },
      };
      await pipe(container, "cat > /tmp/opencode-qa.json", config);
      const endpoint = `
const http = require("http"), fs = require("fs");
http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    fs.appendFileSync("/tmp/model-auth", JSON.stringify(req.headers) + "\\n");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, data) => res.write("event: " + type + "\\ndata: " + JSON.stringify({ type, ...data }) + "\\n\\n");
    send("message_start", { message: { id: "msg_qa", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    send("message_stop", {}); res.end();
  });
}).listen(17340, "127.0.0.1");`;
      await docker(["exec", "-d", container, "node", "-e", endpoint]);
      await docker([
        "exec",
        "-d",
        "-e",
        "OPENCODE_CONFIG=/tmp/opencode-qa.json",
        container,
        "bash",
        "-c",
        "exec opencode serve --hostname 0.0.0.0 --port 17341 > /tmp/opencode-qa.log 2>&1",
      ]);
      const port = (await docker(["port", container, "17341/tcp"])).split(":").at(-1);
      const base = `http://127.0.0.1:${port}`;
      const request = async (route: string, body?: unknown) => {
        const response = await fetch(`${base}${route}`, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(45_000),
        });
        if (!response.ok) throw new Error(`Synthetic OpenCode request failed (${response.status})`);
        return response.json();
      };
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = await request("/global/health").then(
          () => true,
          () => false,
        );
        if (ready) break;
        await Bun.sleep(200);
      }
      if (!ready)
        throw new Error(
          `Synthetic OpenCode server did not start: ${await docker(["exec", container, "tail", "-20", "/tmp/opencode-qa.log"])}`,
        );
      const pid = await docker(["exec", container, "pgrep", "-f", "^opencode serve"]);
      const session = await request("/session", { title: "Credential renewal QA" });
      const prompt = () =>
        request(`/session/${session.id}/message`, {
          model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
          parts: [{ type: "text", text: "Reply OK without tools." }],
        });
      const initialReply = await prompt();
      if (initialReply.info?.error)
        throw new Error(
          `Synthetic model request failed: ${JSON.stringify(initialReply.info.error)}`,
        );
      expect(await docker(["exec", container, "cat", "/tmp/model-auth"])).toContain(
        "sk-ant-oat01-first",
      );
      await docker(["exec", container, "sh", "-c", ": > /tmp/model-auth"]);
      await renew("sk-ant-oat01-renewed");
      await watcher.tick();
      await prompt();
      const headers = await docker(["exec", container, "cat", "/tmp/model-auth"]);
      expect(headers).toContain("sk-ant-oat01-renewed");
      expect(headers).not.toContain("sk-ant-oat01-first");
      expect(await docker(["exec", container, "pgrep", "-f", "^opencode serve"])).toBe(pid);
    } finally {
      context.runtime.shutdown();
      if (savedData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedData;
      await docker(["rm", "-f", container]);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
