import { afterEach, describe, expect, mock, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../../apps/backend/src/core/storage";
import {
  BackendHttpClient,
  BackendProcess,
  agentTestDockerConfigDir,
  agentTestKeychainDir,
  createBackendProcessEnvironment,
  getBrowserGatewayStatus,
  hostDockerConfigDir,
  linkAgentTestHostKeychains,
  seedAgentTestDockerConfig,
} from "../../../apps/desktop/electron/backend-process";

const directories: string[] = [];
const processes: BackendProcess[] = [];
const browserFetch = globalThis.fetch;

async function waitForWebClientStatus(
  client: BackendHttpClient,
  predicate: (status: Awaited<ReturnType<BackendHttpClient["getWebClientStatus"]>>) => boolean,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  let status = await client.getWebClientStatus();
  while (!predicate(status) && Date.now() < deadline) {
    await Bun.sleep(25);
    status = await client.getWebClientStatus();
  }
  return status;
}

async function waitForPath(target: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await access(target).then(() => true, () => false)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${target}`);
}

afterEach(async () => {
  globalThis.fetch = browserFetch;
  await Promise.all(processes.splice(0).map(async (backend) => {
    const child = (backend as unknown as {
      child: { once(event: "exit", listener: () => void): void } | null;
    }).child;
    const exited = child
      ? new Promise<void>((resolve) => {
          child.once("exit", resolve);
          setTimeout(resolve, 2_000);
        })
      : Promise.resolve();
    backend.stop();
    await exited;
  }));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// These tests spawn a real backend child process and wait for it to boot.
// Bun's 5s default is not enough when the suite runs files in parallel on a
// loaded machine, which showed up as an intermittent timeout here.
const SPAWN_TIMEOUT_MS = 30_000;

describe("Electron backend process supervisor", () => {
  test("isolates the child from remote gateway and Tailscale Serve shell settings", () => {
    const parent = {
      PATH: "/bin",
      NODE_PATH: "/existing",
      ORKESTRATOR_GATEWAY_HOST: "100.64.0.1",
      ORKESTRATOR_GATEWAY_PORT: "9999",
      ORKESTRATOR_GATEWAY_TOKEN: "not-forwarded",
      ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS: "https://untrusted.example",
      ORKESTRATOR_TAILSCALE_SERVE: "1",
      ORKESTRATOR_TAILSCALE_SERVE_PORT: "8443",
      ORKESTRATOR_TAILSCALE_BIN: "/tmp/tailscale",
      ORKESTRATOR_TOOLCHAIN_BIN: "/tmp/untrusted-tools",
      ORKESTRATOR_VERSION: "untrusted-shell-version",
    };

    const development = createBackendProcessEnvironment(parent, true, "/resources");
    expect(development).toEqual({
      PATH: "/bin",
      NODE_PATH: "/existing",
      ORKESTRATOR_GATEWAY_DISABLED: "0",
    });
    expect(parent.ORKESTRATOR_GATEWAY_TOKEN).toBe("not-forwarded");
    expect(development.ORKESTRATOR_VERSION).toBeUndefined();

    const production = createBackendProcessEnvironment(
      parent,
      false,
      "/resources",
      "2.4.9",
    );
    expect(production.NODE_PATH).toBe(
      [path.join("/resources", "backend", "vendor"), "/existing"].join(path.delimiter),
    );
    expect(production.ORKESTRATOR_VERSION).toBe("2.4.9");
  });

  test("treats a blank application version as absent rather than exporting an empty one", () => {
    // `"" !== undefined`, so the naive check exported ORKESTRATOR_VERSION="",
    // which the backend and both bridges read as a defined value and therefore
    // do not replace with their own fallback.
    const parent = { ORKESTRATOR_VERSION: "untrusted-shell-version" };
    for (const blank of ["", "   ", "\t"]) {
      expect(createBackendProcessEnvironment(parent, true, "/resources", blank))
        .not.toHaveProperty("ORKESTRATOR_VERSION");
    }
    expect(createBackendProcessEnvironment(parent, true, "/resources", " 2.5.0 "))
      .toMatchObject({ ORKESTRATOR_VERSION: "2.5.0" });
  });

  test("development mode still receives Electron's application version", () => {
    // The combination main.ts actually ships: isDev with a real app version.
    // NODE_PATH stays untouched in development, but the version must not.
    const development = createBackendProcessEnvironment(
      { NODE_PATH: "/existing" },
      true,
      "/resources",
      "2.4.9",
    );

    expect(development).toEqual({
      NODE_PATH: "/existing",
      ORKESTRATOR_GATEWAY_DISABLED: "0",
      ORKESTRATOR_VERSION: "2.4.9",
    });
  });

  test("agent-test child environments suppress ambient credentials by default", () => {
    const isolated = createBackendProcessEnvironment({
      HOME: "/Users/tester",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      OPENCODE_API_KEY: "opencode-secret",
      GH_TOKEN: "github-secret",
      CURSOR_API_KEY: "cursor-secret",
      AWS_ACCESS_KEY_ID: "aws-secret",
      NPM_TOKEN: "npm-secret",
      DATABASE_URL: "postgres://secret",
      SSH_AUTH_SOCK: "/tmp/private-agent.sock",
      CUSTOM_SERVICE_LOGIN: "unexpected-credential-name",
    }, true, "/resources", "2.8.2", {
      flavor: "agent-test",
      credentialSources: [],
      isolatedCredentialRoot: "/profiles/qa/credentials",
    });

    expect(isolated.ANTHROPIC_API_KEY).toBeUndefined();
    expect(isolated.OPENAI_API_KEY).toBeUndefined();
    expect(isolated.OPENCODE_API_KEY).toBeUndefined();
    expect(isolated.GH_TOKEN).toBeUndefined();
    expect(isolated.CURSOR_API_KEY).toBeUndefined();
    expect(isolated.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(isolated.NPM_TOKEN).toBeUndefined();
    expect(isolated.DATABASE_URL).toBeUndefined();
    expect(isolated.SSH_AUTH_SOCK).toBeUndefined();
    expect(isolated.CUSTOM_SERVICE_LOGIN).toBeUndefined();
    expect(isolated.HOME).toBe("/profiles/qa/credentials/home");
    expect(isolated.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBe("/Users/tester");
    expect(isolated.CODEX_HOME).toBe("/profiles/qa/credentials/codex");
    expect(isolated.CLAUDE_CONFIG_DIR).toBe("/profiles/qa/credentials/claude");
    expect(isolated.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
  });

  test("agent-test environments restore only explicitly allowed provider credentials", () => {
    const isolated = createBackendProcessEnvironment({
      HOME: "/Users/tester",
      OPENAI_API_KEY: "allowed-openai",
      CURSOR_API_KEY: "allowed-cursor",
      ANTHROPIC_API_KEY: "blocked-anthropic",
      NPM_TOKEN: "blocked-npm",
    }, true, "/resources", "2.8.2", {
      flavor: "agent-test",
      credentialSources: ["codex", "cursor"],
      isolatedCredentialRoot: "/profiles/qa/credentials",
    });

    expect(isolated.OPENAI_API_KEY).toBe("allowed-openai");
    expect(isolated.CURSOR_API_KEY).toBe("allowed-cursor");
    expect(isolated.CODEX_HOME).toBe("/Users/tester/.codex");
    expect(isolated.ANTHROPIC_API_KEY).toBeUndefined();
    expect(isolated.NPM_TOKEN).toBeUndefined();
    expect(isolated.CLAUDE_CONFIG_DIR).toBe("/profiles/qa/credentials/claude");
  });

  test("an authorized Claude source keeps the unsuffixed Keychain service", () => {
    // Claude Code derives its Keychain service from the config directory as soon
    // as CLAUDE_CONFIG_DIR is set, so pointing at the host configuration without
    // this override looks for a service the host login was never written under
    // and reports the profile as signed out.
    const isolated = createBackendProcessEnvironment({
      HOME: "/Users/tester",
    }, true, "/resources", "2.8.2", {
      flavor: "agent-test",
      credentialSources: ["claude"],
      isolatedCredentialRoot: "/profiles/qa/credentials",
    });

    expect(isolated.CLAUDE_CONFIG_DIR).toBe("/Users/tester/.claude");
    expect(isolated.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
  });

  test("a profile without a Claude source keeps its own Keychain namespace", () => {
    const isolated = createBackendProcessEnvironment({
      HOME: "/Users/tester",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    }, true, "/resources", "2.8.2", {
      flavor: "agent-test",
      credentialSources: ["codex"],
      isolatedCredentialRoot: "/profiles/qa/credentials",
    });

    // Inheriting the override here would hand the host login to a profile that
    // was explicitly denied it.
    expect(isolated.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(isolated.CLAUDE_CONFIG_DIR).toBe("/profiles/qa/credentials/claude");
  });

  test("agent-test environments keep the Docker daemon endpoint while isolating its credentials", () => {
    // Where the daemon is, is topology, not a credential. Stripping it sends
    // every backend `docker` call to the built-in default socket, which is not
    // where Colima, Rancher Desktop, or a remote daemon listen.
    const isolated = createBackendProcessEnvironment({
      HOME: "/Users/tester",
      DOCKER_HOST: "unix:///Users/tester/.colima/default/docker.sock",
      DOCKER_CONTEXT: "colima",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: "/Users/tester/.docker/certs",
      DOCKER_AUTH_CONFIG: "{\"auths\":{}}",
    }, true, "/resources", "2.8.2", {
      flavor: "agent-test",
      credentialSources: [],
      isolatedCredentialRoot: "/profiles/qa/credentials",
    });

    expect(isolated.DOCKER_HOST).toBe("unix:///Users/tester/.colima/default/docker.sock");
    expect(isolated.DOCKER_CONTEXT).toBe("colima");
    expect(isolated.DOCKER_TLS_VERIFY).toBe("1");
    expect(isolated.DOCKER_CERT_PATH).toBe("/Users/tester/.docker/certs");
    // Registry credentials are not topology and stay behind.
    expect(isolated.DOCKER_AUTH_CONFIG).toBeUndefined();
    expect(isolated.DOCKER_CONFIG).toBe(agentTestDockerConfigDir("/profiles/qa/credentials"));
  });

  test("seeds the isolated Docker config with the host context and none of its credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-docker-config-"));
    directories.push(root);
    const source = path.join(root, "host-docker");
    await mkdir(path.join(source, "contexts", "meta", "abc123"), { recursive: true });
    await writeFile(path.join(source, "contexts", "meta", "abc123", "meta.json"), "{\"Name\":\"desktop-linux\"}");
    await writeFile(path.join(source, "config.json"), JSON.stringify({
      currentContext: "desktop-linux",
      credsStore: "desktop",
      auths: { "registry.example.com": { auth: "c2VjcmV0OnRva2Vu" } },
    }));

    const isolatedCredentialRoot = path.join(root, "credentials");
    await seedAgentTestDockerConfig({ isolatedCredentialRoot, sourceDir: source });

    const target = agentTestDockerConfigDir(isolatedCredentialRoot);
    // The context metadata is what makes `docker` reach the same daemon.
    await expect(readFile(path.join(target, "contexts", "meta", "abc123", "meta.json"), "utf8"))
      .resolves.toBe("{\"Name\":\"desktop-linux\"}");
    const seeded = JSON.parse(await readFile(path.join(target, "config.json"), "utf8")) as Record<string, unknown>;
    expect(seeded).toEqual({ currentContext: "desktop-linux" });
    expect(Object.keys(seeded)).not.toContain("auths");
    expect(Object.keys(seeded)).not.toContain("credsStore");
  });

  test("links the host login Keychain into an isolated HOME for Keychain-backed sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-keychain-"));
    directories.push(root);
    const hostHome = path.join(root, "host-home");
    await mkdir(path.join(hostHome, "Library", "Keychains"), { recursive: true });
    await writeFile(path.join(hostHome, "Library", "Keychains", "login.keychain-db"), "keychain");
    const isolatedCredentialRoot = path.join(root, "credentials");

    await expect(linkAgentTestHostKeychains({
      isolatedCredentialRoot,
      hostHome,
      credentialSources: ["claude"],
      platform: "darwin",
    })).resolves.toBe(true);

    // Reading through the isolated HOME is what `security` — and therefore every
    // Keychain-backed agent login — actually does.
    await expect(readFile(
      path.join(agentTestKeychainDir(isolatedCredentialRoot), "login.keychain-db"),
      "utf8",
    )).resolves.toBe("keychain");
  });

  test("repeating the Keychain link is idempotent and repairs a stale target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-keychain-relink-"));
    directories.push(root);
    const hostHome = path.join(root, "host-home");
    await mkdir(path.join(hostHome, "Library", "Keychains"), { recursive: true });
    const isolatedCredentialRoot = path.join(root, "credentials");
    const target = agentTestKeychainDir(isolatedCredentialRoot);
    // A profile that moved between host accounts must not keep the old link.
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.join(root, "previous-host", "Library", "Keychains"), target);

    const link = () => linkAgentTestHostKeychains({
      isolatedCredentialRoot,
      hostHome,
      credentialSources: ["cursor"],
      platform: "darwin",
    });
    await expect(link()).resolves.toBe(true);
    await expect(link()).resolves.toBe(true);

    expect(await readlink(target)).toBe(path.join(hostHome, "Library", "Keychains"));
  });

  test("does not link the host Keychain without an authorized Keychain-backed source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-keychain-denied-"));
    directories.push(root);
    const hostHome = path.join(root, "host-home");
    await mkdir(path.join(hostHome, "Library", "Keychains"), { recursive: true });
    const isolatedCredentialRoot = path.join(root, "credentials");

    // Codex keeps its login on disk, so it is no reason to expose the Keychain.
    await expect(linkAgentTestHostKeychains({
      isolatedCredentialRoot,
      hostHome,
      credentialSources: ["codex"],
      platform: "darwin",
    })).resolves.toBe(false);
    await expect(linkAgentTestHostKeychains({
      isolatedCredentialRoot,
      hostHome,
      credentialSources: [],
      platform: "darwin",
    })).resolves.toBe(false);

    expect(await access(agentTestKeychainDir(isolatedCredentialRoot)).then(() => true, () => false))
      .toBe(false);
  });

  test("leaves real Keychain state in the isolated HOME untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-keychain-existing-"));
    directories.push(root);
    const hostHome = path.join(root, "host-home");
    await mkdir(path.join(hostHome, "Library", "Keychains"), { recursive: true });
    const isolatedCredentialRoot = path.join(root, "credentials");
    const target = agentTestKeychainDir(isolatedCredentialRoot);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "login.keychain-db"), "profile-owned");

    await expect(linkAgentTestHostKeychains({
      isolatedCredentialRoot,
      hostHome,
      credentialSources: ["claude"],
      platform: "darwin",
    })).resolves.toBe(false);

    await expect(readFile(path.join(target, "login.keychain-db"), "utf8"))
      .resolves.toBe("profile-owned");
  });

  test("profile teardown unlinks the host Keychain instead of deleting through it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-keychain-reset-"));
    directories.push(root);
    const hostHome = path.join(root, "host-home");
    const hostKeychains = path.join(hostHome, "Library", "Keychains");
    await mkdir(hostKeychains, { recursive: true });
    await writeFile(path.join(hostKeychains, "login.keychain-db"), "host-login");
    const profileRoot = path.join(root, "profile");
    const isolatedCredentialRoot = path.join(profileRoot, "data", "agent-credentials");
    await linkAgentTestHostKeychains({
      isolatedCredentialRoot,
      hostHome,
      credentialSources: ["claude"],
      platform: "darwin",
    });

    // `dev:reset` removes the profile tree this link lives in. Descending
    // through it would destroy the user's real login Keychain.
    await rm(profileRoot, { recursive: true, force: true });

    expect(await access(profileRoot).then(() => true, () => false)).toBe(false);
    await expect(readFile(path.join(hostKeychains, "login.keychain-db"), "utf8"))
      .resolves.toBe("host-login");
  });

  test("skips the Keychain link on platforms that have no login Keychain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-keychain-linux-"));
    directories.push(root);
    const hostHome = path.join(root, "host-home");
    await mkdir(path.join(hostHome, "Library", "Keychains"), { recursive: true });

    await expect(linkAgentTestHostKeychains({
      isolatedCredentialRoot: path.join(root, "credentials"),
      hostHome,
      credentialSources: ["claude"],
      platform: "linux",
    })).resolves.toBe(false);
  });

  test("still produces a usable isolated Docker config when the host has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-docker-config-missing-"));
    directories.push(root);
    const isolatedCredentialRoot = path.join(root, "credentials");

    // A machine that has never run Docker must not fail profile startup.
    await seedAgentTestDockerConfig({
      isolatedCredentialRoot,
      sourceDir: path.join(root, "absent"),
    });

    const seeded = await readFile(
      path.join(agentTestDockerConfigDir(isolatedCredentialRoot), "config.json"),
      "utf8",
    );
    expect(JSON.parse(seeded)).toEqual({});
  });

  test("resolves the host Docker configuration directory from DOCKER_CONFIG or the home directory", () => {
    expect(hostDockerConfigDir({ DOCKER_CONFIG: "/custom/docker" }, "/Users/tester"))
      .toBe("/custom/docker");
    expect(hostDockerConfigDir({ DOCKER_CONFIG: "   " }, "/Users/tester"))
      .toBe(path.join("/Users/tester", ".docker"));
    expect(hostDockerConfigDir({}, "/Users/tester"))
      .toBe(path.join("/Users/tester", ".docker"));
  });

  test("start threads the Electron application version into the spawned child", async () => {
    // start -> launch -> createBackendProcessEnvironment is the only path that
    // gives the backend and both bridges their version; deleting the argument
    // from the call site broke nothing that any test could see.
    globalThis.fetch = Bun.fetch;
    const resourceRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-fake-backend-"));
    directories.push(resourceRoot);
    const marker = path.join(resourceRoot, "version-marker");
    const authFile = path.join(resourceRoot, "auth.json");
    await writeFile(authFile, JSON.stringify({ token: "fake-backend-token-1234567890" }));
    await mkdir(path.join(resourceRoot, "bin"), { recursive: true });
    // A stand-in for the packaged Bun runtime: records what it was handed and
    // then speaks just enough of the readiness protocol to complete startup.
    const fakeBun = path.join(resourceRoot, "bin", "bun");
    await writeFile(fakeBun, `#!/bin/sh
printf '%s' "\${ORKESTRATOR_VERSION-<unset>}" > ${JSON.stringify(marker)}
printf '{"type":"orkestrator-backend-ready","url":"http://127.0.0.1:1/","authFile":"%s","bindAddress":"127.0.0.1","port":1}\\n' ${JSON.stringify(authFile)}
sleep 5
`);
    await chmod(fakeBun, 0o755);

    const errors = mock(() => undefined);
    const realError = console.error;
    console.error = errors as unknown as typeof console.error;
    try {
      const backendProcess = new BackendProcess();
      processes.push(backendProcess);
      await backendProcess.start({
        isDev: false,
        appVersion: "9.9.9-threaded",
        appRoot: resourceRoot,
        resourceRoot,
        dataDir: resourceRoot,
        gatewayPort: 0,
        onEvent: () => undefined,
      });

      expect(await readFile(marker, "utf8")).toBe("9.9.9-threaded");
    } finally {
      console.error = realError;
    }
  }, SPAWN_TIMEOUT_MS);

  test("reports browser availability independently from the desktop control listener", () => {
    expect(getBrowserGatewayStatus(null)).toEqual({
      enabled: true,
      running: false,
      url: null,
      error: null,
    });
    expect(getBrowserGatewayStatus({
      bindAddress: "127.0.0.1",
      port: 1234,
      url: "http://127.0.0.1:1234/",
      authFile: "/tmp/auth.json",
      browserError: "address unavailable",
    })).toMatchObject({ running: false, url: null, error: "address unavailable" });
    expect(getBrowserGatewayStatus({
      bindAddress: "127.0.0.1",
      port: 1234,
      url: "http://127.0.0.1:1234/",
      authFile: "/tmp/auth.json",
      browserUrl: "http://100.80.1.2:34121/",
    })).toMatchObject({ running: true, url: "http://100.80.1.2:34121/", error: null });
  });

  test("HTTP client covers commands, settings, errors, and event delivery", async () => {
    globalThis.fetch = Bun.fetch;
    const server = createServer(async (request, response) => {
      if (request.url === "/__orkestrator/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(': connected\n\ndata: {"event":"changed","payload":{"ok":true}}\n\n');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      response.setHeader("content-type", "application/json");
      if (request.url === "/__orkestrator/invoke" && body.command === "fail") {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "command failed" }));
      } else if (request.url === "/__orkestrator/invoke") {
        response.end(JSON.stringify({ result: body.args }));
      } else if (request.url === "/__orkestrator/gateway-settings") {
        const token = request.method === "PUT"
          ? (body.token as string)
          : "initial-client-token-123456";
        response.end(JSON.stringify({ token, editable: true, source: "file" }));
      } else if (request.url === "/__orkestrator/web-client-access") {
        const enabled = request.method === "DELETE" || (request.method === "PUT" && body.enabled === true);
        response.end(JSON.stringify({
          enabled,
          running: enabled,
          url: enabled ? "https://workstation.example.ts.net/" : null,
          error: null,
        }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = new BackendHttpClient(`http://127.0.0.1:${address.port}/`, "initial-client-token-123456");

    await expect(client.invoke("echo", { value: 1 })).resolves.toEqual({ value: 1 });
    await expect(client.invoke("fail")).rejects.toThrow("command failed");
    await expect(client.getTokenSettings()).resolves.toMatchObject({ token: "initial-client-token-123456" });
    await expect(client.setToken("changed-client-token-123456")).resolves.toMatchObject({
      token: "changed-client-token-123456",
    });
    await expect(client.getWebClientStatus()).resolves.toMatchObject({ enabled: false, running: false });
    await expect(client.setWebClientEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
    });
    await expect(client.resetWebClientServe()).resolves.toMatchObject({
      enabled: true,
      running: true,
    });
    const received: Array<{ event: string; payload: unknown }> = [];
    const delivered = new Promise<void>((resolve) => client.listen((event, payload) => {
      received.push({ event, payload });
      if (received.length === 2) resolve();
    }));
    await delivered;
    expect(received).toEqual([
      { event: "native-event-stream-connected", payload: undefined },
      { event: "changed", payload: { ok: true } },
    ]);
    client.stopListening();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    }));
  });

  test("HTTP client surfaces web access HTTP and malformed-response failures", async () => {
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "test-token-123456");
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: "lifecycle unavailable" }),
      { status: 503, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    await expect(client.getWebClientStatus()).rejects.toThrow("lifecycle unavailable");

    globalThis.fetch = mock(async () => new Response("not json", { status: 200 })) as typeof fetch;
    await expect(client.setWebClientEnabled(true)).rejects.toThrow();
  });

  test("announces each successful event-stream reconnection", async () => {
    let attempts = 0;
    globalThis.fetch = mock(async () => {
      attempts += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.close();
        },
      }), { status: 200 });
    }) as typeof fetch;
    const client = new BackendHttpClient(
      "http://127.0.0.1:34121/",
      "test-token-123456",
    );
    const connected = new Promise<void>((resolve) => {
      let connectionCount = 0;
      client.listen((event) => {
        if (event !== "native-event-stream-connected") return;
        connectionCount += 1;
        if (connectionCount === 2) {
          client.stopListening();
          resolve();
        }
      });
    });

    await connected;
    expect(attempts).toBe(2);
  });

  test("launches one service for both the Electron bridge and browser clients", async () => {
    // The shared DOM test setup installs a browser fetch with CORS enforcement;
    // Electron's main process uses the native server-side fetch implementation.
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);

    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayHost: "127.0.0.1",
      gatewayPort: 0,
      allowNonTailscaleBind: true,
      onEvent: () => undefined,
    });

    const info = backendProcess.getInfo();
    expect(info?.bindAddress).toBe("127.0.0.1");
    expect(info?.browserUrl).toBeTruthy();
    expect(info?.url).not.toBe(info?.browserUrl);
    await expect(client.invoke("greet", { name: "Electron" })).resolves.toBe(
      "Hello, Electron! You've been greeted from the Orkestrator backend!",
    );

    if (!info) throw new Error("Expected shared backend start information");
    const auth = JSON.parse(await readFile(info.authFile, "utf8")) as { token: string };
    const browserResponse = await Bun.fetch(new URL("/__orkestrator/invoke", info.browserUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "greet", args: { name: "Browser" } }),
    });
    expect(browserResponse.status).toBe(200);
    expect(await browserResponse.json()).toEqual({
      result: "Hello, Browser! You've been greeted from the Orkestrator backend!",
    });
  }, SPAWN_TIMEOUT_MS);

  test("forwards the explicit managed toolchain directory through backend startup", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolchainBinDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-toolchain-"));
    directories.push(dataDir, toolchainBinDir);
    await writeFile(path.join(toolchainBinDir, "codex"), "managed codex");
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);

    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      toolchainBinDir,
      gatewayHost: "127.0.0.1",
      gatewayPort: 0,
      allowNonTailscaleBind: true,
      onEvent: () => undefined,
    });

    const child = (backendProcess as unknown as { child: { spawnargs: string[] } }).child;
    const optionIndex = child.spawnargs.indexOf("--toolchain-bin-dir");
    expect(optionIndex).toBeGreaterThan(0);
    expect(child.spawnargs[optionIndex + 1]).toBe(toolchainBinDir);
    await expect(client.invoke("check_codex_cli")).resolves.toBe(true);
  }, SPAWN_TIMEOUT_MS);

  test("manages hosted web access without stopping the Electron backend", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
    directories.push(dataDir, toolsDir);
    const executable = path.join(toolsDir, "tailscale");
    await writeFile(executable, `#!/bin/sh
if [ "$*" = "serve status --json" ]; then
  printf '{}\\n'
  exit 0
fi
case " $* " in
  *" off "*) exit 0 ;;
esac
printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
`);
    await chmod(executable, 0o755);

    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort: 0,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });

    expect(backendProcess.getInfo()?.browserUrl).toBeUndefined();
    await expect(waitForWebClientStatus(client, (status) => status.running)).resolves.toMatchObject({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
    });
    await expect(client.resetWebClientServe()).resolves.toMatchObject({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
    });
    await expect(client.setWebClientEnabled(false)).resolves.toMatchObject({
      enabled: false,
      running: false,
      url: null,
    });
    await expect(client.invoke("greet", { name: "Electron" })).resolves.toContain("Hello, Electron!");
  }, SPAWN_TIMEOUT_MS);

  test("reports backend readiness before slow managed Serve initialization finishes", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
    directories.push(dataDir, toolsDir);
    const executable = path.join(toolsDir, "tailscale");
    const statusStarted = path.join(toolsDir, "status-started");
    const releaseStatus = path.join(toolsDir, "release-status");
    await writeFile(executable, `#!/bin/sh
if [ "$*" = "serve status --json" ]; then
  : > ${JSON.stringify(statusStarted)}
  while [ ! -f ${JSON.stringify(releaseStatus)} ]; do sleep 0.01; done
  printf '{}\\n'
  exit 0
fi
case " $* " in
  *" off "*) exit 0 ;;
esac
printf 'Available within your tailnet:\\nhttps://slow.example.ts.net\\n'
`);
    await chmod(executable, 0o755);

    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort: 0,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });

    await waitForPath(statusStarted);
    await expect(client.invoke("greet", { name: "ready" })).resolves.toContain("Hello, ready!");
    await writeFile(releaseStatus, "release\n");
    await expect(waitForWebClientStatus(client, (status) => status.running)).resolves.toMatchObject({
      running: true,
      url: "https://slow.example.ts.net/",
    });
  }, 12_000);

  test("honors a persisted disabled setting without invoking Tailscale", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
    directories.push(dataDir, toolsDir);
    const config = defaultConfig();
    config.global.webClientEnabled = false;
    await writeFile(path.join(dataDir, "config.json"), JSON.stringify(config));
    const executable = path.join(toolsDir, "tailscale");
    const callsPath = path.join(toolsDir, "calls");
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
exit 1
`);
    await chmod(executable, 0o755);

    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort: 0,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });

    await expect(client.setWebClientEnabled(false)).resolves.toMatchObject({
      enabled: false,
      running: false,
      error: null,
    });
    await expect(readFile(callsPath, "utf8")).rejects.toThrow();
  }, SPAWN_TIMEOUT_MS);

  test("keeps backend commands available when managed Serve initialization fails", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort: 0,
      desktopWebClient: true,
      tailscaleExecutable: path.join(dataDir, "missing-tailscale"),
      onEvent: () => undefined,
    });

    await expect(waitForWebClientStatus(client, (status) => Boolean(status.error))).resolves.toMatchObject({
      enabled: true,
      running: false,
    });
    await expect(client.invoke("greet", { name: "still-ready" })).resolves.toContain("Hello, still-ready!");
  }, SPAWN_TIMEOUT_MS);

  test("adopts and removes an owned Serve route after an ungraceful backend restart", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
    directories.push(dataDir, toolsDir);
    const executable = path.join(toolsDir, "tailscale");
    const serveState = path.join(toolsDir, "serve-target");
    await writeFile(executable, `#!/bin/sh
STATE="$(dirname "$0")/serve-target"
if [ "$*" = "serve status --json" ]; then
  if [ -f "$STATE" ]; then
    target="$(cat "$STATE")"
    printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"workstation.example.ts.net:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}\\n' "$target"
  else
    printf '{}\\n'
  fi
  exit 0
fi
case " $* " in
  *" off "*) rm -f "$STATE"; exit 0 ;;
esac
for last do :; done
printf '%s' "$last" > "$STATE"
printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
`);
    await chmod(executable, 0o755);

    const portReservation = createServer();
    await new Promise<void>((resolve) => portReservation.listen(0, "127.0.0.1", resolve));
    const reservedAddress = portReservation.address();
    if (!reservedAddress || typeof reservedAddress === "string") throw new Error("Expected TCP address");
    const gatewayPort = reservedAddress.port;
    await new Promise<void>((resolve) => portReservation.close(() => resolve()));

    const firstProcess = new BackendProcess();
    processes.push(firstProcess);
    const firstClient = await firstProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });
    await expect(waitForWebClientStatus(firstClient, (status) => status.running)).resolves.toMatchObject({
      running: true,
    });
    expect(await readFile(serveState, "utf8")).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const child = (firstProcess as unknown as { child: { kill(signal: string): boolean } }).child;
    child.kill("SIGKILL");
    const stoppedDeadline = Date.now() + 5_000;
    while (firstProcess.getInfo() !== null && Date.now() < stoppedDeadline) await Bun.sleep(10);
    expect(firstProcess.getInfo()).toBeNull();

    const secondProcess = new BackendProcess();
    processes.push(secondProcess);
    const secondClient = await secondProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });
    await expect(waitForWebClientStatus(secondClient, (status) => status.running)).resolves.toMatchObject({
      running: true,
      url: "https://workstation.example.ts.net/",
    });
    await expect(secondClient.setWebClientEnabled(false)).resolves.toMatchObject({
      enabled: false,
      running: false,
      error: null,
    });
    await expect(readFile(serveState, "utf8")).rejects.toThrow();
    await expect(readFile(path.join(dataDir, "managed-web-client.json"), "utf8")).rejects.toThrow();
  }, SPAWN_TIMEOUT_MS);

  test("shares concurrent startup and clears stale state when the child exits", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const onUnexpectedExit = mock(() => undefined);
    const options = {
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayHost: "127.0.0.1",
      gatewayPort: 0,
      allowNonTailscaleBind: true,
      onEvent: () => undefined,
      onUnexpectedExit,
    };

    const [first, second] = await Promise.all([
      backendProcess.start(options),
      backendProcess.start(options),
    ]);
    expect(first).toBe(second);

    const child = (backendProcess as unknown as { child: { kill(signal: string): boolean } }).child;
    child.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (backendProcess.getInfo() !== null && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(backendProcess.getInfo()).toBeNull();
    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  }, SPAWN_TIMEOUT_MS);

  test("rotates the shared HTTP credential without losing command access", async () => {
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayHost: "127.0.0.1",
      gatewayPort: 0,
      allowNonTailscaleBind: true,
      onEvent: () => undefined,
    });

    await expect(client.setToken("replacement-backend-token-123456")).resolves.toMatchObject({
      token: "replacement-backend-token-123456",
    });
    await expect(client.invoke("greet", { name: "rotated" })).resolves.toContain("Hello, rotated!");
  }, SPAWN_TIMEOUT_MS);

  test("cleans up state when the child exits before readiness", async () => {
    globalThis.fetch = Bun.fetch;
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-missing-backend-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(missingRoot, dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);

    await expect(backendProcess.start({
      isDev: true,
      appRoot: missingRoot,
      resourceRoot: missingRoot,
      dataDir,
      gatewayHost: "127.0.0.1",
      gatewayPort: 0,
      allowNonTailscaleBind: true,
      onEvent: () => undefined,
    })).rejects.toThrow("Backend service exited");
    expect(backendProcess.getInfo()).toBeNull();
    expect((backendProcess as unknown as { child: unknown }).child).toBeNull();
  }, SPAWN_TIMEOUT_MS);
});
