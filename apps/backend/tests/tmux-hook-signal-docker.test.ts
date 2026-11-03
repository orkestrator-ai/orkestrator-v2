/**
 * The claude-tmux hook doorbell in a real image (to-do 1202 task 8).
 *
 * Proves the container side end to end with no route from the container to
 * the host: the image declares `tmux-hook-signal=1`, the backend's install
 * command writes the config and its probe rings, and the hook script the
 * backend installs rings after writing a hook file. The ring goes to a fake
 * doorbell on the container's loopback that checks the bearer token. Then a
 * real tab poll loop runs against a real tmux session in the container and
 * its `docker exec`s are counted, idle with a confirmed doorbell, and a hook
 * the doorbell announces is drained at once.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../src/core/commands.js";
import {
  tmuxHookSignalInstallCommand,
  tmuxHookSignalSupport,
} from "../src/core/claude-state-signal.js";
import { readImageManifest } from "../src/core/docker-image.js";
import { dockerOwnerNamespace } from "../src/core/docker-ownership.js";
import { runCommand } from "../src/core/shell.js";
import { TmuxBackend } from "../src/core/tmux-backend.js";
import type { TmuxHookDoorbell } from "../src/core/tmux-hook-signal.js";
import { hookScript } from "../src/core/tmux-hooks.js";
import { TmuxSession, TmuxSessionManager } from "../src/core/tmux-session-manager.js";
import { tmuxSessionName } from "../src/core/tmux-shared.js";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures.js";

// Build this checkout with `mise run docker:build:dev`; never use `latest`.
const image = process.env.ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE;
const dockerTest = image ? test : test.skip;

const PORT = 18_431;
const TOKEN = "fake-doorbell-token-not-a-credential";
/** Logs `<method> <path> <token ok>` per request; the token itself is never written. */
const FAKE_DOORBELL = String.raw`
const http = require("node:http");
const fs = require("node:fs");
const [port, token, log] = process.argv.slice(2);
http
  .createServer((req, res) => {
    const ok = req.headers.authorization === "Bearer " + token;
    fs.appendFileSync(log, req.method + " " + req.url + " " + (ok ? "ok" : "bad") + "\n");
    req.resume();
    res.writeHead(204);
    res.end();
  })
  .listen(Number(port), "127.0.0.1", () => fs.writeFileSync(log + ".ready", ""));
`;

dockerTest(
  "the image rings the tmux hook doorbell, and an idle tab on it does not exec every tick",
  async () => {
    if (!image || !/^orkestrator-v2:(dev|qualification)-/.test(image))
      throw new Error("Use this checkout's development or qualification image");
    const dir = await mkdtemp(join(tmpdir(), "ork-tmux-hook-docker-"));
    let containerId: string | undefined;
    let session: TmuxSession | undefined;
    const docker = async (args: string[], timeoutMs = 30_000) =>
      (await runCommand("docker", args, { timeoutMs })).stdout.trim();
    const exec = (script: string) => docker(["exec", containerId!, "sh", "-c", script]);
    const write = (path: string, content: string) =>
      exec(
        `mkdir -p "$(dirname "${path}")" && printf %s '${Buffer.from(content).toString("base64")}' | base64 -d > "${path}"`,
      );
    const rings = async () =>
      (await exec("cat /tmp/doorbell.log 2>/dev/null || true")).split("\n").filter(Boolean);
    const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
      const deadline = Date.now() + 15_000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("Doorbell condition timed out");
        await Bun.sleep(50);
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

      // The image declares the doorbell, and the backend arms it for it.
      const manifest = await readImageManifest(imageId, context);
      expect(manifest.kind).toBe("manifest");
      if (manifest.kind === "manifest")
        expect(manifest.manifest.capabilities["tmux-hook-signal"]).toBe(1);
      expect(await tmuxHookSignalSupport(containerId, context)).toBe("supported");

      // A fake doorbell on the container's loopback.
      await write("/tmp/doorbell.cjs", FAKE_DOORBELL);
      await docker([
        "exec",
        "--detach",
        containerId,
        "node",
        "/tmp/doorbell.cjs",
        String(PORT),
        TOKEN,
        "/tmp/doorbell.log",
      ]);
      await waitFor(async () =>
        (await exec("test -f /tmp/doorbell.log.ready && echo yes || true")).includes("yes"),
      );

      // The backend's install: config from stdin, then the probe ring.
      const install = tmuxHookSignalInstallCommand(containerId, {
        url: `http://127.0.0.1:${PORT}/tmux-hook-signal`,
        token: TOKEN,
      });
      await runCommand(install.command, install.args, install.options);
      await waitFor(async () => (await rings()).length === 1);
      expect(await rings()).toEqual(["POST /tmux-hook-signal ok"]);
      expect(await exec("stat -c %a /tmp/.orkestrator-tmux-hook-signal")).toBe("600");

      // The hook script the backend installs in a container rings after the
      // hook file is written; the Claude state files are untouched.
      const root = "/tmp/orkestrator-v2-claude-tmux/test";
      const sessionId = "abcdef12-3456-4789-8abc-def012345678";
      const backend = TmuxBackend.container(containerId);
      session = new TmuxSession(environment.id, "tab", backend, root, sessionId);
      const paths = session.workspaceHookPaths;
      await write(paths.script, hookScript(paths, { doorbell: true }));
      const hook = (kind: string) =>
        exec(`printf '{"session_id":"${sessionId}"}' | bash ${paths.script} ${kind}`);
      expect(await hook("Notification")).toBe("{}");
      await waitFor(async () => (await rings()).length === 2);
      expect(
        await exec(`ls ${paths.sessionsDir}/${sessionId}/pending | grep -c '^Notification-'`),
      ).toBe("1");
      expect(
        await exec("ls /tmp/.claude-state /tmp/.claude-state-snapshot 2>&1 || true"),
      ).toContain("No such file");

      // Without a config the ring is a no-op and the hook is unaffected: the
      // backend then keeps polling.
      await exec("rm -f /tmp/.orkestrator-tmux-hook-signal");
      expect(await hook("SubagentStop")).toBe("{}");
      await Bun.sleep(500);
      expect(await rings()).toHaveLength(2);

      // A real tab loop on a real tmux session in this container, with the
      // doorbell confirmed and its transcript bound. Its execs are counted
      // from the moment it is idle. The transcript is seeded so the window
      // holds only safety reads: an unbound tab also runs the fallback search
      // on its 2 s to 10 s backoff, which would make the count depend on
      // where the window falls.
      const sessions = new TmuxSessionManager();
      sessions.insert(environment.id, "tab", session);
      await exec(`tmux new-session -d -s ${tmuxSessionName(environment.id, "tab")} sleep infinity`);
      await write(session.expectedTranscriptPath(), '{"type":"summary","summary":"fixture"}\n');
      let execs = 0;
      let searches = 0;
      let inFlight = 0;
      let lastSettledAt = Date.now();
      const realExec = backend.exec.bind(backend);
      backend.exec = (args, stdin, timeoutMs) => {
        execs += 1;
        if (args.some((arg) => arg.includes("find "))) searches += 1;
        inFlight += 1;
        return realExec(args, stdin, timeoutMs).finally(() => {
          inFlight -= 1;
          lastSettledAt = Date.now();
        });
      };
      let ringCount = 0;
      let wake: (() => void) | undefined;
      const doorbell: TmuxHookDoorbell = {
        rings: () => ringCount,
        confirmed: () => true,
        missed: () => {
          throw new Error("no hook was missed");
        },
        release: () => undefined,
      };
      const hooks: string[] = [];
      const loopContext = {
        ...context,
        emit: (_event: string, payload: { kind?: string; event_kind?: string }) => {
          if (payload.kind === "hook" && payload.event_kind) hooks.push(payload.event_kind);
        },
        runtime: {
          tmux: {
            sessions,
            persistEnvironmentActivity: async () => undefined,
            noteTurnFinished: async () => undefined,
            hookSignals: {
              attach: (_id: string, _context: unknown, onRing: () => void) => {
                wake = onRing;
                return doorbell;
              },
            },
          },
        },
      } as unknown as CommandContext;
      (session as unknown as { spawnPollLoop(context: CommandContext): void }).spawnPollLoop(
        loopContext,
      );
      // The two hooks above are drained on the first ticks.
      await waitFor(() => hooks.length === 2);
      // Idle once eight quiet 250 ms ticks have passed; only the idle wait
      // leaves 2 s with no exec in flight, so counting starts inside it.
      await waitFor(() => inFlight === 0 && Date.now() - lastSettledAt >= 2_000);
      execs = 0;
      searches = 0;
      await Bun.sleep(10_000);
      const idleExecs = execs;
      process.stderr.write(`tmux-hook-signal-docker: ${idleExecs} docker execs in 10 s idle\n`);
      // One safety read per 2.5 s, the first within 0.5 s: at most four.
      // The per-tick poll was 18. A bound tab never searches for its
      // transcript.
      expect(idleExecs).toBeLessThanOrEqual(4);
      expect(searches).toBe(0);
      expect(session.recentLiveness(3_000)).toBe(true);

      // A hook the doorbell announces is read at once, not at the safety read.
      await hook("Stop");
      ringCount += 1;
      const rungAt = Date.now();
      wake?.();
      await waitFor(() => hooks.includes("Stop"));
      expect(Date.now() - rungAt).toBeLessThan(2_000);
    } finally {
      if (session) (session as unknown as { stopRequested: boolean }).stopRequested = true;
      if (containerId) await docker(["rm", "--force", containerId]);
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
