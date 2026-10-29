import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const testingDir = path.resolve(import.meta.dir, "../../../bridges/claude-bridge/src/testing");

test("a restarted Claude bridge answers a cold dispatch from disk without registering the session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ork-cold-dispatch-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home);
  await mkdir(workspace);
  const cli = path.join(testingDir, "fake-hanging-turn-cli.ts");
  await chmod(cli, 0o755);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const drains: Promise<string>[] = [];
  const stop = async () => {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await child?.exited;
  };
  const start = async () => {
    child = Bun.spawn([process.execPath, path.join(testingDir, "dispatch-restart-harness.ts")], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
        CLAUDE_BRIDGE_NO_SERVER: "1",
        CLAUDE_BRIDGE_TOKEN: "cold-dispatch-test",
        CLAUDE_CLI_PATH: cli,
        CWD: workspace,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    drains.push(new Response(child.stderr as ReadableStream).text());
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done || text.length > 16_384) throw new Error("Bridge failed to start");
      text += new TextDecoder().decode(value);
      const ready = text
        .split("\n")
        .find((line) => line.startsWith('{"port":') && line.endsWith("}"));
      if (!ready) continue;
      drains.push(
        (async () => {
          while (!(await reader.read()).done) {
            /* Drain bounded startup diagnostics without retaining them. */
          }
          reader.releaseLock();
          return "";
        })(),
      );
      return `http://127.0.0.1:${(JSON.parse(ready) as { port: number }).port}`;
    }
  };
  const timeout = setTimeout(() => child?.kill("SIGKILL"), 25_000);
  try {
    let base = await start();
    const request = (route: string, body?: unknown) =>
      fetch(`${base}${route}`, {
        headers: { Authorization: "Bearer cold-dispatch-test", "Content-Type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
    const created = await request("/session/create", { clientSessionKey: "cold-dispatch" });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    expect(
      (await request(`/session/${sessionId}/prompt`, { prompt: "fixture", requestId: "lost-ack" }))
        .status,
    ).toBe(202);
    const preferences = path.join(home, ".claude", "orkestrator", "session-preferences");
    const deadline = Date.now() + 5_000;
    while (true) {
      const files = await readdir(preferences).catch(() => []);
      const bodies = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map((file) => readFile(path.join(preferences, file), "utf8")),
      );
      // Killed only once the turn's own preference writes (the claim, then
      // the in-flight mark) have landed and released their lock: a lock left
      // by a kill mid-write can block the next process's writes until it is
      // stale (docs/architecture/agent-engines.md, "Claude Code"), which would
      // fail the resend below for the wrong reason.
      const locked = files.some((file) => file.endsWith(".lock"));
      if (
        !locked &&
        bodies.some((body) => body.includes('"lost-ack"') && body.includes('"turnInFlight"'))
      ) {
        break;
      }
      if (Date.now() > deadline) throw new Error("Dispatch claim was never persisted");
      await Bun.sleep(20);
    }
    await stop();
    base = await start();
    const registered = async () =>
      (
        (await (await request(`/__test/registered?id=${sessionId}`)).json()) as {
          registered: boolean;
        }
      ).registered;
    expect(await registered()).toBe(false);
    for (const requestId of ["lost-ack", "never-seen", "lost-ack"]) {
      const response = await request(`/session/${sessionId}/dispatch?requestId=${requestId}`);
      expect(response.status).toBe(200);
      // The session was created by this bridge and every claim reached disk
      // first, so an id missing from its journal provably never arrived.
      expect(await response.json()).toEqual({
        dispatch: requestId === "lost-ack" ? "lost" : "absent",
      });
      expect(await registered()).toBe(false);
    }
    // No Retry, attach, status or transcript read was needed to settle it.
    // A resend acts on that answer: the lost id is refused for good, and the
    // absent one is taken as a first delivery.
    const lostResend = await request(`/session/${sessionId}/prompt`, {
      prompt: "fixture",
      requestId: "lost-ack",
    });
    expect(lostResend.status).toBe(410);
    expect(
      (
        await request(`/session/${sessionId}/prompt`, {
          prompt: "fixture",
          requestId: "never-seen",
        })
      ).status,
    ).toBe(202);
    const after = await request(`/session/${sessionId}/dispatch?requestId=never-seen`);
    expect(((await after.json()) as { dispatch: string }).dispatch).toBe("dispatched");
  } finally {
    clearTimeout(timeout);
    await stop();
    await Promise.all(drains);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
