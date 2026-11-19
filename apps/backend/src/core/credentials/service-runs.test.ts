import { afterEach, describe, expect, test } from "bun:test";
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
      command:
        'stat -f "%Lp" "$KEY_FILE" 2>/dev/null || stat -c "%a" "$KEY_FILE"; cat "$KEY_FILE"; echo; echo "$KEY_FILE"',
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
    h.service.stop();
    const restarted = h.restart();
    await restarted.reconcileStartup();
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
