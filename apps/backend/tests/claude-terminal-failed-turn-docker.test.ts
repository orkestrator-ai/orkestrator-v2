/**
 * A container Claude CLI turn that ends on an API error, in a real image
 * (to-do 1200).
 *
 * The real Claude CLI runs inside a container of this checkout's image, with
 * the hooks the image's own entrypoint installs, against a fake Anthropic API
 * on the container's loopback (no provider is called). The real poll reads the
 * state through `docker exec` and persists through real storage, so this
 * proves the image's `StopFailure` hook end to end. It needs no route from the
 * container to the host, unlike `claude-state-signal-docker.test.ts`.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageService } from "../src/core/storage.js";
import { claudeStateSignalSupport } from "../src/core/claude-state-signal.js";
import { readImageManifest } from "../src/core/docker-image.js";
import { CLAUDE_STATE_POLL_INTERVAL_MS, ClaudeStatePollManager } from "../src/core/tmux-poll.js";
import { ManualTime } from "../src/core/recurring-test-support.js";
import { runCommand } from "../src/core/shell.js";
import { dockerOwnerNamespace } from "../src/core/docker-ownership.js";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures.js";

// Build this checkout with `mise run docker:build:dev`; never use `latest`.
// The Linux Engine workflow passes its per-run qualification image.
const image = process.env.ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE;
const dockerTest = image ? test : test.skip;

/**
 * A fake Anthropic API: `refuse` answers 401, `reply` answers "ok". Every
 * request waits for `<release>` so the test can read the turn while it runs,
 * and `<release>.ready` says the port is listening.
 */
const FAKE_API = String.raw`
const http = require("node:http");
const fs = require("node:fs");
const [mode, port, release] = process.argv.slice(2);
const released = () =>
  new Promise((resolve) => {
    const check = () => (fs.existsSync(release) ? resolve() : setTimeout(check, 50));
    check();
  });
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      await released();
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (mode === "refuse") {
        return json(401, {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        });
      }
      if (req.url.includes("count_tokens")) return json(200, { input_tokens: 1 });
      let stream = false;
      try {
        stream = JSON.parse(body).stream === true;
      } catch {}
      const message = {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "claude-fake",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (!stream) return json(200, message);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type, data) =>
        res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n");
      send("message_start", { message: { ...message, content: [], stop_reason: null } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
      send("content_block_stop", { index: 0 });
      send("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      send("message_stop", {});
      res.end();
    });
  })
  .listen(Number(port), "127.0.0.1", () => fs.writeFileSync(release + ".ready", ""));
`;

const PORTS = { refuse: 18401, reply: 18200 } as const;

dockerTest(
  "a failed Claude CLI turn in the image stops reading working and rings agent_failed",
  async () => {
    if (!image || !/^orkestrator-v2:(dev|qualification)-/.test(image))
      throw new Error("Use this checkout's development or qualification image");
    const dir = await mkdtemp(join(tmpdir(), "ork-failed-turn-docker-"));
    const storage = new StorageService(dir);
    await storage.init();
    let containerId: string | undefined;
    let manager: ClaudeStatePollManager | undefined;
    const docker = async (args: string[], timeoutMs = 30_000) =>
      (await runCommand("docker", args, { timeoutMs })).stdout.trim();
    const exec = (script: string, extra: string[] = [], timeoutMs?: number) =>
      docker(["exec", ...extra, containerId!, "sh", "-c", script], timeoutMs);
    /** Writes `content` to a container path as node, through base64. */
    const write = (path: string, content: string) =>
      exec(
        `mkdir -p "$(dirname "${path}")" && printf %s '${Buffer.from(content).toString("base64")}' | base64 -d > "${path}"`,
      );
    const waitFor = async (predicate: () => Promise<boolean>, step?: () => Promise<void>) => {
      const deadline = Date.now() + 30_000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("Failed-turn condition timed out");
        await step?.();
        await Bun.sleep(100);
      }
    };
    try {
      containerId = await docker([
        "run",
        "--detach",
        "--label",
        "app=orkestrator-v2",
        "--label",
        `orkestrator-owner=${dockerOwnerNamespace(dir)}`,
        "--user",
        "node",
        "--entrypoint",
        "sleep",
        image,
        "infinity",
      ]);
      const imageId = await docker(["inspect", "--format", "{{.Image}}", containerId]);
      const environment = lifecycleEnvironment({
        containerId,
        status: "running",
        containerLifecycle: {
          schemaVersion: 1,
          revision: 1,
          lastRuntimeGeneration: 1,
          runtime: { containerId, runtimeGeneration: 1, owner: dockerOwnerNamespace(dir), imageId },
          storage: { format: "legacy-layer", workspaceGeneration: 1 },
          outcomes: [],
        },
      });
      const { context } = memoryLifecycleContext([environment], dir);
      await storage.addEnvironment(environment);
      context.storage = storage;
      const states: string[] = [];
      context.emit = (_event, payload) => {
        states.push((payload as { state: string }).state);
      };
      context.probeAgentCreatedPullRequest = async () => undefined;

      // The image declares the version with the StopFailure hook, and the
      // backend still arms the doorbell for it.
      const manifest = await readImageManifest(imageId, context);
      expect(manifest.kind).toBe("manifest");
      if (manifest.kind === "manifest")
        expect(manifest.manifest.capabilities["claude-state-signal"]).toBe(3);
      expect(await claudeStateSignalSupport(containerId, context)).toBe("supported");

      // The user settings the image's own entrypoint writes for terminal Claude.
      const entrypoint = await exec("cat /usr/local/bin/entrypoint.sh");
      const settings = entrypoint.match(
        /cat > "\$HOME\/\.claude\/settings\.json" << 'EOF'\n([\s\S]*?)\nEOF\n/,
      )![1]!;
      const hooks = (JSON.parse(settings) as { hooks: Record<string, unknown> }).hooks;
      expect(Object.keys(hooks).sort()).toEqual(["Stop", "StopFailure", "UserPromptSubmit"]);
      await write("/home/node/.claude/settings.json", settings);
      await write("/tmp/fake-api.cjs", FAKE_API);
      for (const [mode, port] of Object.entries(PORTS)) {
        await docker([
          "exec",
          "--detach",
          containerId,
          "node",
          "/tmp/fake-api.cjs",
          mode,
          String(port),
          `/tmp/release-${mode}`,
        ]);
        await waitFor(async () =>
          (await exec(`test -f /tmp/release-${mode}.ready && echo yes || true`)).includes("yes"),
        );
      }

      // The plain one-second poll, reading through `docker exec`.
      const time = new ManualTime(Date.now());
      manager = new ClaudeStatePollManager({
        nowMs: time.now,
        now: () => new Date(time.now()).toISOString(),
        schedule: time.setInterval.bind(time),
        cancel: time.clear.bind(time),
      });
      manager.start(containerId, context);
      const read = async () => (await storage.getEnvironment(environment.id))!;
      const tick = () => time.advance(CLAUDE_STATE_POLL_INTERVAL_MS);
      const sourceIs = (state: string) => async () =>
        (await read()).agentActivitySources?.["claude-terminal"]?.state === state;
      const markRead = () =>
        storage.updateEnvironment(environment.id, {
          hasUnreadWork: false,
          unreadReason: undefined,
        });
      /** One `claude -p` turn against the fake API; resolves to its exit status. */
      const turn = (mode: keyof typeof PORTS) =>
        exec(
          "timeout 90 claude -p hello >/dev/null 2>&1; echo $?",
          [
            "--workdir",
            "/tmp",
            "--env",
            `ANTHROPIC_BASE_URL=http://127.0.0.1:${PORTS[mode]}`,
            "--env",
            "ANTHROPIC_API_KEY=sk-ant-fake-not-a-key",
            "--env",
            "CLAUDE_CODE_MAX_RETRIES=0",
            "--env",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
            "--env",
            "DISABLE_AUTOUPDATER=1",
          ],
          120_000,
        );
      const snapshot = () => exec("cat /tmp/.claude-state-snapshot /tmp/.claude-state");

      // A turn refused by the API: StopFailure runs instead of Stop.
      const refused = turn("refuse");
      await waitFor(sourceIs("working"), tick);
      await markRead();
      await exec("touch /tmp/release-refuse");
      expect(await refused).not.toBe("0");
      await waitFor(sourceIs("idle"), tick);
      expect(await snapshot()).toBe("failed 2 0\nidle");
      const failed = await read();
      expect(failed.hasUnreadWork).toBe(true);
      expect(failed.unreadReason).toBe("agent_failed");
      expect(failed.agentActivityState).toBe("idle");
      expect(states.at(-1)).toBe("idle");

      // A turn that finishes: Stop rings as it did before.
      await markRead();
      const replied = turn("reply");
      await waitFor(sourceIs("working"), tick);
      await markRead();
      await exec("touch /tmp/release-reply");
      expect(await replied).toBe("0");
      await waitFor(sourceIs("waiting"), tick);
      expect(await snapshot()).toBe("waiting 4 1\nwaiting");
      const finished = await read();
      expect(finished.hasUnreadWork).toBe(true);
      expect(finished.unreadReason).toBe("agent_waiting");
      expect(states.at(-1)).toBe("waiting");
    } finally {
      if (containerId) {
        manager?.shutdown(containerId);
        await docker(["rm", "--force", containerId]);
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);
