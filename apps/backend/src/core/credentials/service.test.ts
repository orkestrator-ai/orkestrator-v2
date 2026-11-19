import { afterEach, describe, expect, test } from "bun:test";
import { CREDENTIAL_TIMING } from "@orkestrator/protocol/agent-credentials";
import type { CredentialCaller } from "./access.js";
import {
  createCredentialHarness,
  fakeSpawner,
  interactivePolicy,
  TEST_SECRET,
  type CredentialHarness,
} from "./service-test-support.js";

/**
 * The credential service end to end over a real database, with commands
 * started by a fake spawner (no shell, no wall clock). Runs against real
 * processes are in `service-runs.test.ts` (slow tier).
 */

const harnesses: CredentialHarness[] = [];
let spawner = fakeSpawner();

async function harness(options: Parameters<typeof createCredentialHarness>[0] = {}) {
  spawner = fakeSpawner(({ args, env }) => ({
    stdout: `ran:${args.at(-1)}\n${env.DEPLOY_TOKEN ? `token=${env.DEPLOY_TOKEN}\n` : ""}${env.NPM_TOKEN === TEST_SECRET ? "match\n" : ""}${env.TOKEN ? "present\n" : ""}`,
  }));
  const created = await createCredentialHarness({ spawnProcess: spawner.spawnProcess, ...options });
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  for (const each of harnesses.splice(0)) await each.close();
});

async function grantCommand(
  h: CredentialHarness,
  options: { command?: string; maxUses?: number; caller?: CredentialCaller } = {},
) {
  const caller = options.caller ?? h.caller;
  const request = await h.service.requestAccess(caller, {
    label: "Deploy token",
    purpose: "Publish the package",
    use: "command",
    bindingName: "DEPLOY_TOKEN",
    ...(options.command ? { command: options.command } : {}),
  });
  const approved = await h.service.approve({
    requestId: request.id,
    revision: request.revision,
    source: { kind: "value", value: TEST_SECRET },
    lifetimeMs: 60 * 60_000,
    ...(options.maxUses ? { maxUses: options.maxUses } : {}),
  });
  return approved.grant;
}

describe("requests and approval", () => {
  test("a temporary value grants a command run that never shows the value", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const result = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "./publish.sh",
      waitMs: 20_000,
    });
    expect(result.state).toBe("succeeded");
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.text).toBe("ran:./publish.sh\ntoken=[redacted]\n");
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
    // The value reached the process through its own environment only.
    const [run] = spawner.spawned;
    expect(run?.env.DEPLOY_TOKEN).toBe(TEST_SECRET);
    expect(run?.args.join(" ")).not.toContain(TEST_SECRET);
    expect(run?.args).toEqual(["-lc", "./publish.sh"]);
    // Nothing the backend persisted holds it either.
    const overview = JSON.stringify(h.service.overview());
    expect(overview).not.toContain(TEST_SECRET);
    expect(JSON.stringify(h.service.tabSnapshot({ environmentId: "env-1" }))).not.toContain(
      TEST_SECRET,
    );
  });

  test("the request is pending until a person decides, and the agent may wait for it", async () => {
    const h = await harness();
    const request = await h.service.requestAccess(h.caller, {
      label: "API key",
      purpose: "Call the API",
      use: "http",
      hosts: ["API.Example.com"],
    });
    expect(request.state).toBe("pending");
    expect(request.http?.hosts).toEqual(["api.example.com"]);
    const waiting = h.service.getRequest(h.caller, request.id, 10_000);
    h.service.decline({ requestId: request.id, revision: request.revision });
    const answer = await waiting;
    expect(answer.request.state).toBe("declined");
    expect(answer.grant).toBeNull();
  });

  test("an approval of an old revision or a decided request is refused", async () => {
    const h = await harness();
    const request = await h.service.requestAccess(h.caller, {
      label: "Token",
      purpose: "x",
      use: "command",
      bindingName: "TOKEN",
    });
    h.service.decline({ requestId: request.id, revision: request.revision });
    await expect(
      h.service.approve({
        requestId: request.id,
        revision: request.revision,
        source: { kind: "value", value: TEST_SECRET },
      }),
    ).rejects.toThrow("REQUEST_STALE");
  });

  test("two racing approvals produce one grant and leave no orphaned value", async () => {
    const h = await harness();
    const request = await h.service.requestAccess(h.caller, {
      label: "Token",
      purpose: "x",
      use: "command",
      bindingName: "TOKEN",
    });
    const attempts = await Promise.allSettled([
      h.service.approve({
        requestId: request.id,
        revision: request.revision,
        source: { kind: "value", value: `${TEST_SECRET}-a` },
      }),
      h.service.approve({
        requestId: request.id,
        revision: request.revision,
        source: { kind: "value", value: `${TEST_SECRET}-b` },
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(h.service.tabSnapshot({ environmentId: "env-1" }).grants).toHaveLength(1);
  });

  test("an expired request cannot be approved", async () => {
    const h = await harness();
    const request = await h.service.requestAccess(h.caller, {
      label: "Token",
      purpose: "x",
      use: "command",
      bindingName: "TOKEN",
    });
    h.advance(CREDENTIAL_TIMING.requestWaitMs + 1);
    h.service.sweep();
    const snapshot = h.service.tabSnapshot({ environmentId: "env-1" });
    expect(snapshot.requests[0]?.state).toBe("expired");
    await expect(
      h.service.approve({
        requestId: request.id,
        revision: request.revision,
        source: { kind: "value", value: TEST_SECRET },
      }),
    ).rejects.toThrow("REQUEST_STALE");
  });

  test("a conversation that changed since the request cancels it", async () => {
    const h = await harness();
    const request = await h.service.requestAccess(h.caller, {
      label: "Token",
      purpose: "x",
      use: "command",
      bindingName: "TOKEN",
    });
    h.sessions.set("env-1\0tab-1", {
      agent: "claude",
      logicalSessionKey: "env-env-1:tab-1",
      providerSessionId: "provider-session-new",
      policy: interactivePolicy(),
    });
    await expect(
      h.service.approve({
        requestId: request.id,
        revision: request.revision,
        source: { kind: "value", value: TEST_SECRET },
      }),
    ).rejects.toThrow("REQUEST_STALE");
    expect(h.service.tabSnapshot({ environmentId: "env-1" }).requests[0]?.state).toBe("cancelled");
  });

  test("unsafe binding names and bad hosts are refused", async () => {
    const h = await harness();
    await expect(
      h.service.requestAccess(h.caller, {
        label: "x",
        purpose: "x",
        use: "command",
        bindingName: "LD_PRELOAD",
      }),
    ).rejects.toThrow("INVALID_INPUT");
    await expect(
      h.service.requestAccess(h.caller, {
        label: "x",
        purpose: "x",
        use: "http",
        hosts: ["10.0.0.1"],
      }),
    ).rejects.toThrow("INVALID_INPUT");
  });

  test("a tab may have at most four pending requests", async () => {
    const h = await harness();
    for (let index = 0; index < 4; index += 1) {
      await h.service.requestAccess(h.caller, {
        label: `t${index}`,
        purpose: "x",
        use: "command",
        bindingName: "TOKEN",
      });
    }
    await expect(
      h.service.requestAccess(h.caller, {
        label: "t5",
        purpose: "x",
        use: "command",
        bindingName: "TOKEN",
      }),
    ).rejects.toThrow("REQUEST_LIMIT");
  });

  test("approving with saveAs stores a connection limited to the project", async () => {
    const h = await harness();
    const request = await h.service.requestAccess(h.caller, {
      label: "Token",
      purpose: "x",
      use: "command",
      bindingName: "TOKEN",
    });
    const { grant } = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "value", value: TEST_SECRET, saveAs: { name: "npm" } },
    });
    expect(grant.source).toMatchObject({ kind: "connection", connectionName: "npm" });
    const [connection] = h.service.overview().connections;
    expect(connection).toMatchObject({ name: "npm", projectIds: ["project-1"] });
    expect(h.vault.size()).toBe(1);
  });
});

describe("authorization at every use", () => {
  test("another tab cannot use a copied grant id", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const other = { ...h.caller, tabId: "tab-2" };
    await expect(
      h.service.runCommand(other, { grantId: grant.id, command: "true" }),
    ).rejects.toThrow("GRANT_NOT_FOUND");
    await expect(
      h.service.runCommand(
        { ...h.caller, projectId: "project-2" },
        { grantId: grant.id, command: "true" },
      ),
    ).rejects.toThrow("GRANT_NOT_FOUND");
  });

  test("a new conversation in the same tab ends the grant", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    h.sessions.set("env-1\0tab-1", {
      agent: "claude",
      logicalSessionKey: "env-env-1:tab-1",
      providerSessionId: "provider-session-replaced",
      policy: interactivePolicy(),
    });
    await expect(
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true" }),
    ).rejects.toThrow("SCOPE_MISMATCH");
    expect(h.service.tabSnapshot({ environmentId: "env-1" }).grants).toHaveLength(0);
  });

  test("a replaced runtime (rebuilt container, moved worktree) ends the grant", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    h.runtimes.set("env-1", {
      runtime: { kind: "container", isolation: "shared-container" },
      identity: "container:new",
    });
    await expect(
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true" }),
    ).rejects.toThrow("SCOPE_MISMATCH");
  });

  test("expiry is checked at use without the sweep, on either clock", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    // Wall clock moved back: the monotonic clock still ends the grant.
    h.clock.monotonic += 60 * 60_000;
    h.clock.now -= 24 * 60 * 60_000;
    await expect(
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true" }),
    ).rejects.toThrow("ACCESS_EXPIRED");
  });

  test("a revoked grant refuses new uses", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    h.service.revokeGrant(grant.id);
    await expect(
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true" }),
    ).rejects.toThrow("ACCESS_REVOKED");
  });

  test("a command-bound grant runs only that exact command", async () => {
    const h = await harness();
    const grant = await grantCommand(h, { command: "echo ok" });
    await expect(
      h.service.runCommand(h.caller, { grantId: grant.id, command: "echo other" }),
    ).rejects.toThrow("SCOPE_MISMATCH");
    const result = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "echo ok",
      waitMs: 20_000,
    });
    expect(result.stdout?.text).toBe("ran:echo ok\ntoken=[redacted]\n");
  });

  test("a session that asks before commands needs an exact command", async () => {
    const h = await harness();
    h.sessions.set("env-1\0tab-1", {
      agent: "claude",
      logicalSessionKey: "env-env-1:tab-1",
      providerSessionId: "provider-session-1",
      policy: interactivePolicy({ approvals: "ask" }),
    });
    await expect(
      h.service.requestAccess(h.caller, {
        label: "x",
        purpose: "x",
        use: "command",
        bindingName: "TOKEN",
      }),
    ).rejects.toThrow("POLICY_DENIED");
    const grant = await grantCommand(h, { command: "echo bound" });
    const result = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "echo bound",
      waitMs: 20_000,
    });
    expect(result.state).toBe("succeeded");
  });

  test("a read-only coordinator gets trusted GET requests only", async () => {
    const h = await harness();
    h.runtimes.set("env-1", {
      runtime: { kind: "coordinator", isolation: "read-only" },
      identity: "coordinator:/repo",
    });
    await expect(
      h.service.requestAccess(h.caller, {
        label: "x",
        purpose: "x",
        use: "command",
        bindingName: "TOKEN",
      }),
    ).rejects.toThrow("UNSUPPORTED_RUNTIME");
    const request = await h.service.requestAccess(h.caller, {
      label: "API",
      purpose: "read",
      use: "http",
      hosts: ["api.example.com"],
    });
    expect(request.http?.methods).toEqual(["GET", "HEAD"]);
  });

  test("simultaneous uses cannot exceed the use limit", async () => {
    const h = await harness();
    const grant = await grantCommand(h, { maxUses: 1 });
    const attempts = await Promise.allSettled([
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true", waitMs: 20_000 }),
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true", waitMs: 20_000 }),
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true", waitMs: 20_000 }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(
      attempts.filter(
        (attempt) => attempt.status === "rejected" && String(attempt.reason).includes("USE_LIMIT"),
      ),
    ).toHaveLength(2);
  });
});

describe("idempotency and outcomes", () => {
  test("a retry with the key still finds the operation after it used the grant up", async () => {
    const h = await harness();
    const grant = await grantCommand(h, { maxUses: 1 });
    const first = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "echo once",
      idempotencyKey: "only-1",
      waitMs: 20_000,
    });
    expect(first.state).toBe("succeeded");
    const retried = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "echo once",
      idempotencyKey: "only-1",
      waitMs: 20_000,
    });
    expect(retried.id).toBe(first.id);
    expect(spawner.spawned.filter((each) => each.args.includes("echo once"))).toHaveLength(1);
    await expect(
      h.service.runCommand(h.caller, {
        grantId: grant.id,
        command: "echo once",
        idempotencyKey: "only-2",
      }),
    ).rejects.toThrow();
  });

  test("the same key and request return the same operation without a second use", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const first = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "echo once",
      idempotencyKey: "publish-1",
      waitMs: 20_000,
    });
    const again = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "echo once",
      idempotencyKey: "publish-1",
      waitMs: 20_000,
    });
    expect(again.id).toBe(first.id);
    expect(h.service.listCallerGrants(h.caller)[0]?.uses).toBe(1);
    await expect(
      h.service.runCommand(h.caller, {
        grantId: grant.id,
        command: "echo changed",
        idempotencyKey: "publish-1",
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });
});

describe("container runs", () => {
  test("the value rides in the docker client's environment, never on its command line", async () => {
    const h = await harness();
    h.setLaunch({
      target: "container",
      cwd: "/workspace",
      containerId: "container-abc",
      env: { PATH: "/usr/bin:/bin" },
    });
    h.runtimes.set("env-1", {
      runtime: { kind: "container", isolation: "shared-container" },
      identity: "container:container-abc",
    });
    const grant = await grantCommand(h);
    const result = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "npm publish",
      waitMs: 20_000,
    });
    expect(result.state).toBe("succeeded");
    const exec = spawner.spawned.find((each) => each.args.includes("npm publish"));
    expect(exec?.command).toBe("docker");
    expect(exec?.args).toContain("DEPLOY_TOKEN");
    expect(exec?.env.DEPLOY_TOKEN).toBe(TEST_SECRET);
    for (const each of spawner.spawned) expect(each.args.join(" ")).not.toContain(TEST_SECRET);
    // The run's processes and private directory are cleaned up inside the container.
    expect(
      spawner.spawned.some((each) => each.args.includes("orkestrator-credential-cleanup")),
    ).toBe(true);
    expect(result.cleanup).toBe("confirmed");
  });

  test("a file binding is written from stdin inside the container", async () => {
    const h = await harness();
    h.setLaunch({ target: "container", cwd: "/workspace", containerId: "container-abc", env: {} });
    h.runtimes.set("env-1", {
      runtime: { kind: "container", isolation: "shared-container" },
      identity: "container:container-abc",
    });
    const request = await h.service.requestAccess(h.caller, {
      label: "Key",
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
    await h.service.runCommand(h.caller, { grantId: grant.id, command: "deploy", waitMs: 20_000 });
    const write = spawner.spawned.find((each) => each.args.includes("orkestrator-credential-file"));
    expect(write?.input).toBe(TEST_SECRET);
    const exec = spawner.spawned.find((each) => each.args.includes("deploy"));
    expect(exec?.args.some((arg) => arg.startsWith("KEY_FILE=/tmp/orkestrator-credentials/"))).toBe(
      true,
    );
    for (const each of spawner.spawned) expect(each.args.join(" ")).not.toContain(TEST_SECRET);
  });
});

describe("review regressions", () => {
  test("a grant revoked while a container run is being set up never starts the command", async () => {
    const h = await harness();
    h.setLaunch({ target: "container", cwd: "/workspace", containerId: "container-abc", env: {} });
    h.runtimes.set("env-1", {
      runtime: { kind: "container", isolation: "shared-container" },
      identity: "container:container-abc",
    });
    const request = await h.service.requestAccess(h.caller, {
      label: "Key",
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
    const started = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "npm publish",
      waitMs: 0,
    });
    h.service.revokeGrant(grant.id);
    const done = await h.service.getOperation(h.caller, started.id, 20_000);
    expect(done.state).toBe("cancelled_before_start");
    expect(spawner.spawned.some((each) => each.args.includes("npm publish"))).toBe(false);
  });

  test("renaming a saved connection keeps its grants", async () => {
    const h = await harness();
    const connection = await h.service.createConnection({
      name: "npm",
      value: TEST_SECRET,
      projectIds: null,
      httpHosts: [],
    });
    const request = await h.service.requestAccess(h.caller, {
      label: "npm",
      purpose: "x",
      use: "command",
      bindingName: "NPM_TOKEN",
    });
    const { grant } = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "connection", connectionId: connection.id },
    });
    h.service.updateConnection({
      id: connection.id,
      revision: connection.revision,
      name: "npm registry",
      projectIds: null,
      httpHosts: [],
    });
    const result = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: "true",
      waitMs: 20_000,
    });
    expect(result.state).toBe("succeeded");
  });
});

describe("trusted HTTP", () => {
  async function httpHarness(fetchImpl: typeof fetch) {
    const h = await harness({ fetch: fetchImpl });
    const request = await h.service.requestAccess(h.caller, {
      label: "API key",
      purpose: "x",
      use: "http",
      hosts: ["api.example.com"],
    });
    const { grant } = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "value", value: TEST_SECRET },
    });
    return { h, grant };
  }

  test("attaches the credential, refuses redirects and filters the answer", async () => {
    const seen: Array<{ url: string; authorization: string | null; redirect: string | undefined }> =
      [];
    const fetchImpl = (async (input: URL | string | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        authorization: headers.get("authorization"),
        redirect: init?.redirect,
      });
      return new Response(`{"echo":"${TEST_SECRET}"}`, {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "session=abc" },
      });
    }) as typeof fetch;
    const { h, grant } = await httpHarness(fetchImpl);
    const result = await h.service.httpRequest(h.caller, {
      grantId: grant.id,
      method: "GET",
      url: "https://api.example.com/v1/items?limit=1",
    });
    expect(seen[0]).toEqual({
      url: "https://api.example.com/v1/items?limit=1",
      authorization: `Bearer ${TEST_SECRET}`,
      redirect: "manual",
    });
    expect(result.state).toBe("succeeded");
    expect(result.http?.body).toBe('{"echo":"[redacted]"}');
    expect(result.http?.headers["set-cookie"]).toBeUndefined();
    expect(result.summary).toBe("GET api.example.com/v1/items");
  });

  test("a value cut by the body limit is still filtered", async () => {
    const limit = 128 * 1024;
    const { h, grant } = await httpHarness(
      (async () =>
        new Response(`${"x".repeat(limit - 5)}${TEST_SECRET}`, {
          status: 200,
        })) as unknown as typeof fetch,
    );
    const result = await h.service.httpRequest(h.caller, {
      grantId: grant.id,
      method: "GET",
      url: "https://api.example.com/echo",
    });
    expect(result.http?.bodyTruncated).toBe(true);
    expect(result.http?.body).not.toContain(TEST_SECRET.slice(0, 5));
  });

  test("header values outside visible ASCII are refused before sending", async () => {
    const { h, grant } = await httpHarness(
      (async () => new Response("")) as unknown as typeof fetch,
    );
    await expect(
      h.service.httpRequest(h.caller, {
        grantId: grant.id,
        method: "GET",
        url: "https://api.example.com/",
        headers: { "X-Note": "caf\u00e9" },
      }),
    ).rejects.toThrow("INVALID_INPUT");
  });

  test("other hosts, plain http and Authorization headers are refused before sending", async () => {
    let calls = 0;
    const { h, grant } = await httpHarness((async () => {
      calls += 1;
      return new Response("");
    }) as unknown as typeof fetch);
    await expect(
      h.service.httpRequest(h.caller, {
        grantId: grant.id,
        method: "GET",
        url: "https://evil.example.net/",
      }),
    ).rejects.toThrow("SCOPE_MISMATCH");
    await expect(
      h.service.httpRequest(h.caller, {
        grantId: grant.id,
        method: "GET",
        url: "http://api.example.com/",
      }),
    ).rejects.toThrow("POLICY_DENIED");
    await expect(
      h.service.httpRequest(h.caller, {
        grantId: grant.id,
        method: "GET",
        url: "https://api.example.com/",
        headers: { Authorization: "Bearer mine" },
      }),
    ).rejects.toThrow("INVALID_INPUT");
    expect(calls).toBe(0);
    expect(h.service.listCallerGrants(h.caller)[0]?.uses).toBe(0);
  });

  test("a POST that times out is an unknown outcome; a refused connection had no effect", async () => {
    const timeout = Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    let next: Error = timeout;
    const { h, grant } = await httpHarness((async () => {
      throw next;
    }) as unknown as typeof fetch);
    const unknown = await h.service.httpRequest(h.caller, {
      grantId: grant.id,
      method: "POST",
      url: "https://api.example.com/deploy",
      body: "{}",
    });
    expect(unknown.state).toBe("outcome_unknown");
    next = refused;
    const notSent = await h.service.httpRequest(h.caller, {
      grantId: grant.id,
      method: "POST",
      url: "https://api.example.com/deploy",
      body: "{}",
    });
    expect(notSent.state).toBe("failed_no_effect");
  });
});

describe("connections", () => {
  test("replacing a value or changing the policy ends grants that pinned the old one", async () => {
    const h = await harness();
    const connection = await h.service.createConnection({
      name: "npm",
      value: TEST_SECRET,
      projectIds: null,
      httpHosts: [],
    });
    const request = await h.service.requestAccess(h.caller, {
      label: "npm",
      purpose: "x",
      use: "command",
      bindingName: "NPM_TOKEN",
    });
    const { grant } = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "connection", connectionId: connection.id },
    });
    const ok = await h.service.runCommand(h.caller, {
      grantId: grant.id,
      command: 'test "$NPM_TOKEN" = "' + TEST_SECRET + '" && echo match',
      waitMs: 20_000,
    });
    expect(ok.stdout?.text).toContain("match\n");
    await h.service.replaceConnectionValue({ id: connection.id, value: `${TEST_SECRET}-2` });
    await expect(
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true" }),
    ).rejects.toThrow();
    expect(h.service.tabSnapshot({ environmentId: "env-1" }).grants).toHaveLength(0);
    expect(h.vault.size()).toBe(1);
  });

  test("a connection outside the project or without the host cannot be chosen", async () => {
    const h = await harness();
    const other = await h.service.createConnection({
      name: "elsewhere",
      value: TEST_SECRET,
      projectIds: ["project-2"],
      httpHosts: ["api.example.com"],
    });
    const noHost = await h.service.createConnection({
      name: "nohost",
      value: TEST_SECRET,
      projectIds: null,
      httpHosts: [],
    });
    const request = await h.service.requestAccess(h.caller, {
      label: "API",
      purpose: "x",
      use: "http",
      hosts: ["api.example.com"],
    });
    await expect(
      h.service.approve({
        requestId: request.id,
        revision: request.revision,
        source: { kind: "connection", connectionId: other.id },
      }),
    ).rejects.toThrow("SCOPE_MISMATCH");
    await expect(
      h.service.approve({
        requestId: request.id,
        revision: request.revision,
        source: { kind: "connection", connectionId: noHost.id },
      }),
    ).rejects.toThrow("SCOPE_MISMATCH");
    expect(
      h.service
        .tabSnapshot({ environmentId: "env-1", projectId: "project-1" })
        .connections.map((c) => c.name),
    ).toEqual(["nohost"]);
  });

  test("deleting a connection removes its value and ends its grants", async () => {
    const h = await harness();
    const connection = await h.service.createConnection({
      name: "gone",
      value: TEST_SECRET,
      projectIds: null,
      httpHosts: [],
    });
    const request = await h.service.requestAccess(h.caller, {
      label: "x",
      purpose: "x",
      use: "command",
      bindingName: "TOKEN",
    });
    const { grant } = await h.service.approve({
      requestId: request.id,
      revision: request.revision,
      source: { kind: "connection", connectionId: connection.id },
    });
    await h.service.deleteConnection(connection.id);
    expect(h.vault.size()).toBe(0);
    await expect(
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true" }),
    ).rejects.toThrow();
  });

  test("errors never repeat a value", async () => {
    const h = await harness();
    const tooShort = "abc";
    try {
      await h.service.createConnection({
        name: "x",
        value: tooShort,
        projectIds: null,
        httpHosts: [],
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).not.toContain(tooShort);
      expect(String(error)).toContain("INVALID_INPUT");
    }
  });
});

describe("lifecycle", () => {
  test("closing the tab cancels its requests and ends its grants", async () => {
    const h = await harness();
    const grant = await grantCommand(h);
    const pending = await h.service.requestAccess(h.caller, {
      label: "x",
      purpose: "x",
      use: "command",
      bindingName: "TOKEN",
    });
    h.service.tabClosed("env-1", "tab-1");
    const snapshot = h.service.tabSnapshot({ environmentId: "env-1" });
    expect(snapshot.grants).toHaveLength(0);
    expect(snapshot.requests.find((request) => request.id === pending.id)?.state).toBe("cancelled");
    await expect(
      h.service.runCommand(h.caller, { grantId: grant.id, command: "true" }),
    ).rejects.toThrow("ACCESS_REVOKED");
  });

  test("deleting the environment removes every record", async () => {
    const h = await harness();
    await grantCommand(h);
    h.service.environmentDeleted("env-1");
    const snapshot = h.service.tabSnapshot({ environmentId: "env-1" });
    expect(snapshot.requests).toHaveLength(0);
    expect(snapshot.grants).toHaveLength(0);
  });
});
