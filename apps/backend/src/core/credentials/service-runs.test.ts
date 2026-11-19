import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { EventEmitter } from "node:events";
import { startCredentialRun } from "./runner.js";
import type { CredentialCaller } from "./access.js";
import {
  createCredentialHarness,
  TEST_SECRET,
  type CredentialHarness,
} from "./service-test-support.js";

/**
 * Credential runs against real processes (`/bin/sh` in a temporary worktree):
 * output filtering end to end, deadlines, cancellation of a whole process
 * group, private files and restart reconciliation. Slow tier
 * (`scripts/test-tiers.ts`): these wait on real processes and wall-clock
 * deadlines; `service.test.ts` covers the same paths with a fake spawner.
 */

const harnesses: CredentialHarness[] = [];

async function harness() {
  const created = await createCredentialHarness();
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  for (const each of harnesses.splice(0)) await each.close();
});

async function grantCommand(h: CredentialHarness, caller: CredentialCaller = h.caller) {
  const request = await h.service.requestAccess(caller, {
    label: "Deploy token",
    purpose: "Publish the package",
    use: "command",
    bindingName: "DEPLOY_TOKEN",
  });
  return (
    await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "value", value: TEST_SECRET },
    })
  ).grant;
}

describe("real command runs", () => {
  test("stdout and stderr are filtered for the value and its encodings", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const result = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command:
        'printf "token=%s\\n" "$DEPLOY_TOKEN"; printf "%s" "$DEPLOY_TOKEN" | base64; printf "%s" "$DEPLOY_TOKEN" >&2',
      waitMs: 20_000,
    });
    expect(result.state).toBe("succeeded");
    expect(result.stdout?.text).toBe("token=[redacted]\n[redacted]\n");
    expect(result.stderr?.text).toBe("[redacted]");
  });

  test("a command stopped at its deadline is an unknown outcome, not a failure", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const result = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "sleep 30",
      timeoutMs: 1_000,
      waitMs: 20_000,
    });
    expect(result.state).toBe("outcome_unknown");
    expect(result.timedOut).toBe(true);
    expect(result.cleanup).toBe("confirmed");
  });

  test("a long run answers running and can be collected later", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const started = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "sleep 1; echo late",
      waitMs: 0,
    });
    expect(["reserved", "running"]).toContain(started.state);
    expect(started.note).toContain("get_credential_operation");
    const done = await h.service.getOperation(h.caller, started.id, 20_000);
    expect(done.state).toBe("succeeded");
    expect(done.stdout?.text).toBe("late\n");
  });

  test("revoking a grant stops its running command", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const started = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "sleep 30",
      waitMs: 0,
    });
    h.service.revokeGrant(grant.id);
    const done = await h.service.getOperation(h.caller, started.id, 20_000);
    expect(done.state).toBe("outcome_unknown");
    expect(done.error).toBe("Cancelled.");
  });

  test("file delivery writes a private file that is removed afterwards", async () => {
    const h = await harness();
    const request = await h.service.requestAccess(h.caller, {
      label: "Key file",
      purpose: "x",
      use: "command",
      bindingName: "KEY_FILE",
      bindingKind: "file",
    });
    const { grant } = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "value", value: TEST_SECRET },
    });
    const result = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      // GNU syntax first: GNU `stat -f` reports the file system, printing to
      // stdout before it fails, while BSD `stat -c` prints nothing.
      command:
        'stat -c "%a" "$KEY_FILE" 2>/dev/null || stat -f "%Lp" "$KEY_FILE"; cat "$KEY_FILE"; echo; echo "$KEY_FILE"',
      waitMs: 20_000,
    });
    const [mode, content, file] = (result.stdout?.text ?? "").trim().split("\n");
    expect(mode).toBe("600");
    expect(content).toBe("[redacted]");
    expect(file?.startsWith(h.dataDir)).toBe(true);
    expect(file?.includes(h.worktree)).toBe(false);
    expect(await Bun.file(file!).exists()).toBe(false);
  });

  test("a restart ends temporary grants and settles open operations", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const saved = await h.service.createConnection({
      name: "kept",
      value: TEST_SECRET,
      projectIds: null,
      httpHosts: [],
    });
    const request = await h.service.requestAccess(h.caller, {
      label: "kept",
      purpose: "x",
      use: "command",
      bindingName: "TOKEN",
    });
    const kept = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "connection", connectionId: saved.id },
    });
    const started = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "sleep 30",
      waitMs: 0,
    });
    const stopped = h.service.getOperation(h.caller, started.id, 4_000);
    await h.service.cancelOperation(h.caller, started.id);
    await stopped;
    h.service.stop();
    const records = h.storage.credentialRecordStore();
    const previous = records.getGrant(grant.id)!;
    records.transaction((rows) =>
      rows.putGrant({
        ...previous,
        internal: { ...previous.internal, owner: { pid: fakePid(10), start: "exited-fixture" } },
      }),
    );
    const restarted = h.restart();
    await restarted.reconcileStartup();
    expect(records.getGrant(grant.id)?.state).toBe("invalidated");
    const active = restarted.tabSnapshot({ environmentId: "env-1" }).grants.map((each) => each.id);
    expect(active).toEqual([kept.grant.id]);
    const operation = restarted.overview().operations.find((each) => each.id === started.id);
    expect(["outcome_unknown", "cancelled_before_start"]).toContain(operation?.state ?? "");
    const result = await restarted.runCommand(h.caller, {
      grantId: kept.grant.id,
      command: 'test -n "$TOKEN" && echo present',
      waitMs: 20_000,
    });
    expect(result.stdout?.text).toBe("present\n");
  });
});

async function waitForCommand(h: CredentialHarness, grantId: string) {
  const started = await h.service.runCommand(h.caller, {
    grantId,
    command: "printf ready > ready; exec sleep 30",
    waitMs: 0,
  });
  const ready = Bun.file(`${h.worktree}/ready`);
  for (let attempt = 0; attempt < 100 && !(await ready.exists()); attempt++) await Bun.sleep(10);
  expect(await ready.exists()).toBe(true);
  return started;
}

describe("credential cancellation while a real command runs", () => {
  test("the cancellation API stops the command", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const run = await waitForCommand(h, grant.id);
    await h.service.cancelOperation(h.caller, run.id);
    const done = await h.service.getOperation(h.caller, run.id, 4_000);
    expect(done).toMatchObject({
      state: "outcome_unknown",
      error: "Cancelled.",
      cleanup: "confirmed",
    });
  });

  test("writer takeover preserves a live owner's file and another backend can cancel the run", async () => {
    const h = await harness();
    const request = await h.service.requestAccess(h.caller, {
      label: "Key file",
      purpose: "Fixture",
      use: "command",
      bindingName: "KEY_FILE",
      bindingKind: "file",
    });
    const { grant } = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "value", value: TEST_SECRET },
    });
    const run = await waitForCommand(h, grant.id);
    const secretFile = `${h.dataDir}/credentials/runs/${run.id}/KEY_FILE`;
    await access(secretFile);
    const other = h.restart();
    await other.reconcileStartup();
    await access(secretFile);
    const records = h.storage.credentialRecordStore();
    expect(records.getGrant(grant.id)?.state).toBe("active");
    expect(records.getOperation(run.id)?.state).toBe("running");
    expect((await other.cancelOperation(h.caller, run.id)).note).toContain(
      "Cancellation requested",
    );
    h.service.sweep();
    expect(await h.service.getOperation(h.caller, run.id, 4_000)).toMatchObject({
      state: "outcome_unknown",
      error: "Cancelled.",
      cleanup: "confirmed",
    });
    await expect(access(secretFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retiring a conversation leaves the environment's grant and its run alone", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const run = await waitForCommand(h, grant.id);
    const key = "env-1\0tab-1";
    const oldSession = h.sessions.get(key)!;
    h.sessions.set(key, { ...oldSession, providerSessionId: "replacement" });
    h.service.conversationRetired(
      h.caller.environmentId,
      oldSession.logicalSessionKey,
      oldSession.providerSessionId!,
    );
    expect(h.service.overview().grants.map((each) => each.id)).toEqual([grant.id]);
    const records = h.storage.credentialRecordStore();
    expect(records.getOperation(run.id)?.state).toBe("running");
    // Revoking is what stops it.
    h.service.revokeGrant(grant.id);
    for (
      let attempt = 0;
      attempt < 100 && records.getOperation(run.id)?.state === "running";
      attempt++
    )
      await Bun.sleep(10);
    expect(records.getOperation(run.id)).toMatchObject({
      state: "outcome_unknown",
      error: "Cancelled.",
    });
  });

  test("an in-flight one-use grant remains in Settings and a second backend can revoke it", async () => {
    const h = await harness();
    const connection = await h.service.createConnection({ name: "Revocable", value: TEST_SECRET });
    const request = await h.service.requestAccess(h.caller, {
      label: "Revocable",
      purpose: "Read fixture",
      use: "command",
      bindingName: "TOKEN",
    });
    const { grant } = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      maxUses: 1,
      source: { kind: "connection", connectionId: connection.id },
    });
    const run = await waitForCommand(h, grant.id);
    expect(h.service.listCallerGrants(h.caller)).toEqual([]);
    const other = h.restart();
    expect(other.overview().grants).toMatchObject([{ id: grant.id, uses: 1, maxUses: 1 }]);
    expect(other.revokeGrant(grant.id)?.state).toBe("revoked");
    h.service.sweep();
    expect(await h.service.getOperation(h.caller, run.id, 4_000)).toMatchObject({
      state: "outcome_unknown",
      error: "Cancelled.",
      cleanup: "confirmed",
    });
  });
});

/** Opt-in. Uses a disposable, networkless container from an explicitly supplied image. */
const image = process.env.ORKESTRATOR_TEST_DOCKER_IMAGE;

describe.skipIf(!image)("credential runner in a real container", () => {
  let containerId: string;
  const exec = (...args: string[]) =>
    spawnSync("docker", ["exec", "-u", "node", containerId, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });

  beforeAll(() => {
    const run = spawnSync(
      "docker",
      [
        "run",
        "--pull=never",
        "-d",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "sleep",
        image!,
        "180",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(run.status).toBe(0);
    containerId = run.stdout.trim();
    expect(containerId).toMatch(/^[a-f0-9]{64}$/u);
  });

  afterAll(() => {
    if (/^[a-f0-9]{64}$/u.test(containerId)) {
      spawnSync("docker", ["rm", "--force", containerId], { stdio: "ignore", timeout: 10_000 });
    }
  });

  const launch = () => ({
    target: "container" as const,
    containerId,
    cwd: "/tmp",
    env: process.env,
  });

  test("confirmed cancellation closes admission before a delayed exec reaches the container", async () => {
    const id = randomUUID();
    const queued = Promise.withResolvers<[string, string[]]>();
    const spawner = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      if (!args.includes("orkestrator-credential-run")) return spawn(command, args, options);
      // Represent a daemon-owned exec that can start after the client disconnects.
      const client = Object.assign(new EventEmitter(), {
        pid: fakePid(1),
        stdout: null,
        stderr: null,
        kill: () => {
          client.emit("exit", null, "SIGKILL");
          client.emit("close", null, "SIGKILL");
          return true;
        },
      });
      queueMicrotask(() => {
        client.emit("spawn");
        queued.resolve([command, args]);
      });
      return client;
    }) as typeof spawn;
    const marker = `/tmp/credential-qa-${id}`;
    const run = startCredentialRun({
      id,
      launch: launch(),
      command: `touch "${marker}"`,
      bindings: [],
      redaction: [],
      timeoutMs: 10_000,
      runRoot: "/unused",
      spawnProcess: spawner,
    });
    const [command, args] = await queued.promise;
    run.cancel();
    expect(await run.result).toMatchObject({ cancelled: true, cleanup: "confirmed" });
    // Release the queued exec only after the cleanup acknowledgement.
    expect(spawnSync(command, args, { timeout: 10_000, stdio: "ignore" }).status).toBe(125);
    expect(exec("test", "!", "-e", marker).status).toBe(0);
    expect(exec("test", "!", "-e", `/tmp/orkestrator-credentials/${id}`).status).toBe(0);
  });

  test("startup removes the real container file of an already cancelled reservation", async () => {
    const h = await harness();
    const id = randomUUID();
    const directory = `/tmp/orkestrator-credentials/${id}`;
    expect(
      exec("sh", "-c", 'umask 077; mkdir -p "$1"; printf fixture > "$1/TOKEN"', "stage", directory)
        .status,
    ).toBe(0);
    expect(exec("test", "-s", `${directory}/TOKEN`).status).toBe(0);
    const owner = { pid: fakePid(24), start: "exited-fixture" };
    const records = h.storage.credentialRecordStore();
    records.transaction((rows) => {
      rows.putOperation({
        id,
        environmentId: h.caller.environmentId,
        tabId: h.caller.tabId,
        grantId: "fixture",
        kind: "command",
        state: "cancelled_before_start",
        cleanup: "unconfirmed",
        createdAt: 1,
        finishedAt: 2,
        summary: "fixture",
        internal: { idempotencyKey: null, fingerprint: "fixture", bootId: "prior-boot", owner },
      });
      rows.putRunCleanup({ id, environmentId: h.caller.environmentId, containerId, owner });
    });
    await h.restart().reconcileStartup();
    expect(exec("test", "!", "-e", directory).status).toBe(0);
    expect(records.getOperation(id)).toMatchObject({
      state: "cancelled_before_start",
      cleanup: "confirmed",
    });
    expect(records.listRunCleanup()).toEqual([]);
  });

  test("cleanup stops a detached tagged descendant and removes the bound file", async () => {
    const id = randomUUID();
    const run = startCredentialRun({
      id,
      launch: launch(),
      command:
        'test -s "$FIXTURE_FILE" || exit 1; setsid sleep 60 </dev/null >/dev/null 2>&1 & echo "$!"',
      bindings: [{ binding: { kind: "file", name: "FIXTURE_FILE" }, value: "synthetic fixture" }],
      redaction: [],
      timeoutMs: 10_000,
      runRoot: "/unused",
    });
    const result = await run.result;
    expect(result).toMatchObject({ exitCode: 0, cleanup: "confirmed" });
    const pid = result.stdout.text.trim();
    expect(pid).toMatch(/^\d+$/u);
    expect(
      exec("sh", "-c", 'test ! -e "/proc/$1/stat" || grep -q ") Z " "/proc/$1/stat"', "check", pid)
        .status,
    ).toBe(0);
    expect(exec("test", "!", "-e", `/tmp/orkestrator-credentials/${id}`).status).toBe(0);
  });
});
