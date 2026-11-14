import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProviderStatus } from "../agent-provider-contract.js";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";
import { OPENCODE2_RESTART_CUT_MESSAGE } from "./restart-cut.js";
import { OPENCODE2_CREDENTIAL_PLUGIN_ID, buildOpenCode2CredentialPluginSource } from "./server.js";

/**
 * A run the server is stopped under (to-do 8045 (retired), `restart-cut.ts`),
 * against a real pinned 2.x server and a scripted local model (no
 * credentials, no remote calls). Pins what 2.2.6's plain `opencode serve`
 * does with it, which the provider's restart rule rests on: the restarted
 * server lists no active run, never resumes it and never writes its `idle`
 * row, while the session's `time.busy` stays newer than its `time.idle`.
 * The provider of the new server generation then reads it as a restart
 * interruption whose turn has settled, and the next prompt continues the same
 * session. The backend's own host plugin stops a server whose backend is
 * gone, so a killed backend's server does not run on beside the next one.
 * Run with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the
 * 2.x binary, or through `mise run verify:opencode2:live`.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
const providers: OpenCode2Provider[] = [];
/** Held model requests, released (unanswered) when the server they came from stops. */
let holding = false;
const held: Array<() => void> = [];

const client = () =>
  new OpenCode2Client({
    baseUrl: fixture!.baseUrl,
    password: fixture!.password,
    directory: fixture!.directory,
  });

/** A provider for one server generation, as `environment-provider.ts` builds one per server. */
function generation(): OpenCode2Provider {
  const provider = new OpenCode2Provider(client(), { monitorRetryMs: 100 });
  providers.push(provider);
  return provider;
}

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!);
  fixture.model.hold = ({ texts }) =>
    holding && texts.at(-1)?.includes("HOLD_THIS_TURN")
      ? new Promise<void>((resolve) => held.push(resolve))
      : undefined;
}, 60_000);

afterAll(async () => {
  for (const provider of providers.splice(0)) await provider.dispose();
  for (const release of held.splice(0)) release();
  await fixture?.stop();
});

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(150);
  }
}

const idle = (provider: OpenCode2Provider, sessionId: string) =>
  until(async () => ((await provider.activity(sessionId)) === "idle" ? true : undefined));

for (const scenario of [
  { name: "a held model request, SIGTERM (what the reaper sends first)", signal: "SIGTERM" },
  { name: "a running tool, SIGKILL", signal: "SIGKILL" },
] as const) {
  liveTest(
    `a run the server was stopped under (${scenario.name}) reads as a restart interruption and continues once`,
    async () => {
      const before = generation();
      const id = await before.createSession("build", "restart", { model: "fixture/fixture" });
      // An earlier settled run: its outcome must not mask the cut one.
      await before.send(id, "an earlier turn", { requestId: `${scenario.signal}-earlier` });
      await idle(before, id);
      holding = true;
      const prompt = scenario.signal === "SIGTERM" ? "HOLD_THIS_TURN please" : "RUN_BASH:sleep 60";
      await before.send(id, prompt, { requestId: `${scenario.signal}-cut` });
      await until(async () => ((await before.activity(id)) === "working" ? true : undefined));
      const callsBefore = fixture!.model.calls.length;

      await fixture!.restart({ signal: scenario.signal });
      holding = false;
      for (const release of held.splice(0)) release();
      await Bun.sleep(3_000);

      // What 2.2.6 leaves: no active run, no resumption, no closing `idle`.
      const raw = client();
      expect((await raw.activeSessions()).has(id)).toBe(false);
      const session = await raw.getSession(id);
      expect(session.time?.busy).toBeGreaterThan(session.time?.idle ?? 0);
      expect(session.outcome).toBe("succeeded");
      const rows = (await raw.listMessages(id, { limit: 20, order: "desc" })).messages;
      expect(rows[0]?.type).not.toBe("idle");
      expect(fixture!.model.calls.length).toBe(callsBefore);

      // The next server generation's provider, as a restarted backend builds it.
      const after = generation();
      after.registerSession(id);
      expect(await after.activity(id)).toBe("idle");
      expect(await readProviderStatus(after, id, `${scenario.signal}-cut`)).toMatchObject({
        status: "error",
        interruption: "restart",
        interruptedRequestId: `${scenario.signal}-cut`,
        turnSettled: true,
        error: OPENCODE2_RESTART_CUT_MESSAGE,
      });
      expect((await after.sessionState(id)).status).toBe("idle");

      // The runner's continuation: the same session runs it and settles.
      const continuation = `continue the work (${scenario.signal})`;
      await after.send(id, continuation, { requestId: `${scenario.signal}-continue` });
      await idle(after, id);
      expect(await readProviderStatus(after, id, `${scenario.signal}-continue`)).toMatchObject({
        status: "idle",
        turnSettled: true,
      });
      expect(await after.dispatchStatus(id, `${scenario.signal}-continue`)).toBe("dispatched");
      expect(
        fixture!.model.calls.filter((call) => call.userTexts.at(-1) === continuation),
      ).toHaveLength(1);
    },
    120_000,
  );
}

liveTest(
  "the host plugin stops a server whose backend is gone, leaving its run for the next generation",
  async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "ork-opencode2-parent-"));
    const pluginDir = path.join(configDir, "plugins", OPENCODE2_CREDENTIAL_PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, "index.ts"), buildOpenCode2CredentialPluginSource());
    // Stands for the backend: the server's `ORKESTRATOR_PARENT_PID`.
    const backend = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
    const orphaned = await startOpenCode2Fixture(binary!, {
      env: { OPENCODE_CONFIG_DIR: configDir, ORKESTRATOR_PARENT_PID: String(backend.pid) },
    });
    let holdingHere = true;
    const heldHere: Array<() => void> = [];
    orphaned.model.hold = ({ texts }) =>
      holdingHere && texts.at(-1)?.includes("HOLD_THIS_TURN")
        ? new Promise<void>((resolve) => heldHere.push(resolve))
        : undefined;
    const connect = () =>
      new OpenCode2Client({
        baseUrl: orphaned.baseUrl,
        password: orphaned.password,
        directory: orphaned.directory,
      });
    const before = new OpenCode2Provider(connect(), { monitorEvents: false });
    try {
      const id = await before.createSession("build", "orphan", { model: "fixture/fixture" });
      await before.send(id, "HOLD_THIS_TURN while the backend dies", { requestId: "orphan-cut" });
      await until(async () => ((await before.activity(id)) === "working" ? true : undefined));
      backend.kill("SIGKILL");
      await backend.exited;
      // The server goes down by itself within the watch's one-second probe and its shutdown.
      await until(
        async () =>
          (await connect()
            .info()
            .then(
              () => false,
              () => true,
            ))
            ? true
            : undefined,
        15_000,
      );
      holdingHere = false;
      for (const release of heldHere.splice(0)) release();
      // Nothing outlived it to read the held answer: the next server finds the run cut.
      await orphaned.restart();
      const after = new OpenCode2Provider(connect(), { monitorEvents: false });
      providers.push(after);
      expect(await readProviderStatus(after, id, "orphan-cut")).toMatchObject({
        status: "error",
        interruption: "restart",
        interruptedRequestId: "orphan-cut",
        turnSettled: true,
      });
    } finally {
      await before.dispose();
      if (backend.exitCode === null) backend.kill("SIGKILL");
      for (const release of heldHere.splice(0)) release();
      await orphaned.stop();
      await rm(configDir, { recursive: true, force: true });
    }
  },
  120_000,
);
