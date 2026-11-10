import { afterEach, describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "../src/core/agent-provider-contract";
import { OPENCODE2_SERVER_PORT } from "../src/core/constants";
import { containerCredentialFile } from "../src/core/container-bridge-credential";
import {
  containerRunsOpenCode2,
  ensureOpenCode2ContainerServer,
  openCode2EnvironmentServer,
  peekOpenCode2ContainerServer,
  startContainerOpenCode2Server,
} from "../src/core/opencode2-container-server";
import {
  OPENCODE2_CONTAINER_CLI_PATH,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE,
} from "../src/core/opencode2/container-server";
import { OPENCODE2_LAUNCH_FINGERPRINT } from "../src/core/opencode2-container-launch";
import { OPENCODE2_LAUNCH_ROOT } from "../src/core/agent-credential-files";
import { OPENCODE2_LISTENER_RECORD } from "../src/core/opencode-listener-identity";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createCommandFixtures } from "./command-fixtures";

const { createContext, createEnvironment, fs, withFakeDocker } = await createCommandFixtures();

const ROOT_TOKEN = `okb_${"r".repeat(43)}`;

/** Logs every argv and stdin; answers status, the port and root's credential file. */
const FAKE_DOCKER = `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
case " $* " in
  *" -i "*) printf 'STDIN:%s\\n' "$(cat)" >> "$FAKE_DOCKER_EXEC_LOG" ;;
esac
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) [ -n "$FAKE_DOCKER_PORT" ] && printf '127.0.0.1:%s\\n' "$FAKE_DOCKER_PORT"; exit 0 ;;
esac
case "$*" in
  *"--user root"*"cat /run/orkestrator-bridge/opencode2-token"*) printf '%s' "$FAKE_ROOT_TOKEN" ;;
  *"cat ${OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE}"*) printf '%s' "$FAKE_FINGERPRINT" ;;
esac
exit 0
`;

/** A stand-in 2.x server on port 0: `/api/info` for the expected password (any when unset). */
function serve(password?: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const auth = request.headers.get("authorization") ?? "";
      if (password && auth !== `Basic ${btoa(`opencode:${password}`)}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const url = new URL(request.url);
      if (url.pathname === "/api/info") return Response.json({ version: "2.2.6" });
      if (url.pathname === "/api/session/active") return Response.json({ data: {} });
      return new Response("not found", { status: 404 });
    },
  });
}

/**
 * Holds a port from the start (binding port 0, never releasing it for someone
 * else to take) but drops every connection until `ready()`: before the fake
 * container "starts" 2.x, nothing answers on the port, as with a real one.
 */
async function serveWhenReady(ready: () => boolean) {
  const server = createHttpServer((request, response) => {
    if (!ready()) {
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/info") return response.end(JSON.stringify({ version: "2.2.6" }));
    if (url.pathname === "/api/session/active") return response.end(JSON.stringify({ data: {} }));
    response.statusCode = 404;
    response.end("{}");
  });
  server.on("connection", (socket) => {
    if (!ready()) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const held: Array<{ stop: () => Promise<void> }> = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const savedEnv: Record<string, string | undefined> = {};
function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(held.splice(0).map((holder) => holder.stop()));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

async function readLog(file: string) {
  const lines = (await fs.readFile(file, "utf8").catch(() => "")).split(/^(?=ARGV:|STDIN:)/m);
  return {
    argv: lines.filter((line) => line.startsWith("ARGV:")).join("\n"),
    stdin: lines.filter((line) => line.startsWith("STDIN:")).join("\n"),
  };
}

function containerEnvironment() {
  return createEnvironment({
    id: "env-c",
    environmentType: "containerized",
    containerId: "container-1",
  });
}

describe("startContainerOpenCode2Server", () => {
  test("starts 2.x with its password in root's file and the server's environment only", async () => {
    let arrived = false;
    const holder = await serveWhenReady(() => arrived);
    held.push(holder);
    const port = holder.port;
    setEnv({ FAKE_DOCKER_PORT: String(port), FAKE_ROOT_TOKEN: "" });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER, async (logs) => {
      // The server answers once the detached start has run, as a real one does.
      const arrive = setInterval(async () => {
        if (!arrived && (await readLog(logs.exec)).argv.includes("exec -d ")) arrived = true;
      }, 25);
      try {
        const started = await startContainerOpenCode2Server(
          context,
          "container-1",
          async () => "launcher",
        );
        const { argv, stdin } = await readLog(logs.exec);
        const password = started.connection.password;
        expect(started.wasRunning).toBe(false);
        expect(started.connection).toMatchObject({
          baseUrl: `http://127.0.0.1:${port}`,
          directory: "/workspace",
        });
        expect(password).toMatch(/^okb_/);
        // Never on a command line; on stdin, to root's file and the start secrets.
        expect(argv).not.toContain(password);
        expect(argv).toContain(`mv "$credential_tmp" ${containerCredentialFile("opencode2")}`);
        expect(stdin).toContain(`STDIN:${password}`);
        expect(stdin).toContain(`export OPENCODE_PASSWORD='${password}'`);
        expect(argv).toContain(
          `setsid ${OPENCODE2_CONTAINER_CLI_PATH} serve --port ${OPENCODE2_SERVER_PORT}`,
        );
        expect(argv).not.toContain("/tmp/opencode-server-password");
      } finally {
        clearInterval(arrive);
      }
    });
  });

  test("reuses a server that answers with the persisted password and current plugins", async () => {
    const server = serve(ROOT_TOKEN);
    servers.push(server);
    const port = server.port;
    setEnv({
      FAKE_DOCKER_PORT: String(port),
      FAKE_ROOT_TOKEN: ROOT_TOKEN,
      FAKE_FINGERPRINT: OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT,
    });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER, async (logs) => {
      const started = await startContainerOpenCode2Server(context, "container-1", async () => {
        throw new Error("a running server needs no credential mode");
      });
      expect(started.wasRunning).toBe(true);
      expect(started.connection.password).toBe(ROOT_TOKEN);
      expect((await readLog(logs.exec)).argv).not.toContain("exec -d ");
    });
  });

  test("an image that would leave the password readable by node is refused", async () => {
    // Held but never answering: the start must be refused before anything listens.
    const holder = await serveWhenReady(() => false);
    held.push(holder);
    const port = holder.port;
    setEnv({ FAKE_DOCKER_PORT: String(port), FAKE_ROOT_TOKEN: "" });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER, async (logs) => {
      await expect(
        startContainerOpenCode2Server(context, "container-1", async () => "token-file"),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect((await readLog(logs.exec)).argv).not.toContain("exec -d ");
    });
  });

  test("a container without the 2.x port is told to rebuild", async () => {
    setEnv({ FAKE_DOCKER_PORT: "", FAKE_ROOT_TOKEN: "" });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER, async () => {
      await expect(
        startContainerOpenCode2Server(context, "container-1", async () => "launcher"),
      ).rejects.toThrow("rebuild it to use OpenCode 2");
    });
  });
});

/**
 * The fake Docker of an `opencode2-launch=1` image: root's read also prints
 * the listener lines in \`FAKE_LISTENER\`, and the record script answers
 * \`recorded\`.
 */
const FAKE_DOCKER_LAUNCHER = FAKE_DOCKER.replace(
  `  *"--user root"*"cat /run/orkestrator-bridge/opencode2-token"*) printf '%s' "$FAKE_ROOT_TOKEN" ;;`,
  `  *"--user root"*"echo recorded"*) printf 'recorded\\n' ;;
  *"--user root"*"cat /run/orkestrator-bridge/opencode2-token"*) printf '%s\\n\\n%b\\n' "$FAKE_ROOT_TOKEN" "$FAKE_LISTENER" ;;`,
);

/** A 2.x stand-in that appends each request path to the exec log, after the launcher ran. */
async function serveAfterLaunch(log: () => string) {
  let launched = false;
  const server = createHttpServer(async (request, response) => {
    if (!launched)
      launched = (await fs.readFile(log(), "utf8").catch(() => "")).includes(
        "orkestrator-bridge-launch opencode2",
      );
    if (!launched) {
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    await fs.appendFile(log(), `HTTP:${url.pathname}\n`);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/info") return response.end(JSON.stringify({ version: "2.2.6" }));
    if (url.pathname === "/api/agent") return response.end(JSON.stringify({ data: [] }));
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("startContainerOpenCode2Server on an opencode2-launch image", () => {
  test("starts 2.x through the launcher, warms it, then records its socket", async () => {
    let logFile = "";
    const holder = await serveAfterLaunch(() => logFile);
    held.push(holder);
    setEnv({ FAKE_DOCKER_PORT: String(holder.port), FAKE_ROOT_TOKEN: "", FAKE_LISTENER: "" });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER_LAUNCHER, async (logs) => {
      logFile = logs.exec;
      const started = await startContainerOpenCode2Server(
        context,
        "container-1",
        async () => "opencode2-launcher",
      );
      const password = started.connection.password;
      const raw = await fs.readFile(logs.exec, "utf8");
      const { argv, stdin } = await readLog(logs.exec);
      expect(started.wasRunning).toBe(false);
      expect(password).toMatch(/^okb_/);
      // Root's configuration, then the launcher, never the login-shell start.
      expect(argv).toContain(`root=${OPENCODE2_LAUNCH_ROOT}`);
      expect(argv).toMatch(
        /orkestrator-bridge-launch opencode2 \/tmp\/\.orkestrator-bridge-env-opencode2-[0-9a-f]{32}/,
      );
      expect(argv).not.toContain("exec -d ");
      expect(argv).not.toContain(OPENCODE2_CONTAINER_CLI_PATH);
      // The password: root's file and the launcher's stdin, never a command line.
      expect(argv).not.toContain(password);
      expect(stdin).toContain(`STDIN:${password}`);
      expect(stdin).toContain(`OPENCODE_PASSWORD=${password}`);
      // Warmed (plugins loaded, non-dumpable) before the socket is recorded.
      const warmed = raw.indexOf("HTTP:/api/agent");
      const recorded = raw.indexOf(`mv "$tmp" ${OPENCODE2_LISTENER_RECORD}`);
      expect(warmed).toBeGreaterThan(-1);
      expect(recorded).toBeGreaterThan(warmed);
    });
  });

  test("reuses a launched server only while its recorded socket is the listener", async () => {
    const server = serve(ROOT_TOKEN);
    servers.push(server);
    setEnv({
      FAKE_DOCKER_PORT: String(server.port),
      FAKE_ROOT_TOKEN: ROOT_TOKEN,
      FAKE_FINGERPRINT: OPENCODE2_LAUNCH_FINGERPRINT,
      FAKE_LISTENER: "record 4242\\nsocket 4242\\nlaunch-required",
    });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER_LAUNCHER, async (logs) => {
      const started = await startContainerOpenCode2Server(context, "container-1", async () => {
        throw new Error("a recorded server needs no credential mode");
      });
      expect(started.wasRunning).toBe(true);
      expect(started.connection.password).toBe(ROOT_TOKEN);
      const { argv } = await readLog(logs.exec);
      expect(argv).not.toContain("orkestrator-bridge-launch opencode2 ");
      expect(argv).not.toContain("find /proc/[0-9]*/fd");
    });
  });

  test("a replaced listener is stopped by its socket and a new server launched", async () => {
    let logFile = "";
    const holder = await serveAfterLaunch(() => logFile);
    held.push(holder);
    setEnv({
      FAKE_DOCKER_PORT: String(holder.port),
      FAKE_ROOT_TOKEN: ROOT_TOKEN,
      FAKE_FINGERPRINT: OPENCODE2_LAUNCH_FINGERPRINT,
      FAKE_LISTENER: "record 4242\\nsocket 9999\\nlaunch-required",
    });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER_LAUNCHER, async (logs) => {
      logFile = logs.exec;
      const started = await startContainerOpenCode2Server(
        context,
        "container-1",
        async () => "opencode2-launcher",
      );
      expect(started.wasRunning).toBe(false);
      expect(started.connection.password).not.toBe(ROOT_TOKEN);
      const { argv } = await readLog(logs.exec);
      const stopped = argv.indexOf("find /proc/[0-9]*/fd");
      expect(stopped).toBeGreaterThan(-1);
      expect(argv.indexOf("orkestrator-bridge-launch opencode2")).toBeGreaterThan(stopped);
    });
  });

  test("a login-shell server is replaced once the image can launch one", async () => {
    let logFile = "";
    const holder = await serveAfterLaunch(() => logFile);
    held.push(holder);
    setEnv({
      FAKE_DOCKER_PORT: String(holder.port),
      FAKE_ROOT_TOKEN: ROOT_TOKEN,
      FAKE_FINGERPRINT: OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT,
      FAKE_LISTENER: "",
    });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER_LAUNCHER, async (logs) => {
      logFile = logs.exec;
      const started = await startContainerOpenCode2Server(
        context,
        "container-1",
        async () => "opencode2-launcher",
      );
      expect(started.wasRunning).toBe(false);
      expect((await readLog(logs.exec)).argv).toContain("orkestrator-bridge-launch opencode2");
    });
  });
});

describe("peekOpenCode2ContainerServer", () => {
  test("adopts a server started before this backend, then trusts it briefly", async () => {
    const server = serve(ROOT_TOKEN);
    servers.push(server);
    const port = server.port;
    setEnv({ FAKE_DOCKER_PORT: String(port), FAKE_ROOT_TOKEN: ROOT_TOKEN });
    const { context } = createContext(containerEnvironment());
    let clock = 1_000_000;
    await withFakeDocker(FAKE_DOCKER, async (logs) => {
      const adopted = await peekOpenCode2ContainerServer(context, "env-c", () => clock);
      expect(adopted).toMatchObject({ password: ROOT_TOKEN, directory: "/workspace" });
      const execs = (await readLog(logs.exec)).argv.split("\n").length;
      clock += 1_000;
      expect(await peekOpenCode2ContainerServer(context, "env-c", () => clock)).toEqual(adopted);
      // Within its validity a known server costs no Docker call.
      expect((await readLog(logs.exec)).argv.split("\n").length).toBe(execs);
      // Gone: dropped, and read as no server (no turn in flight).
      servers.splice(0).forEach((server) => server.stop(true));
      clock += 60_000;
      expect(await peekOpenCode2ContainerServer(context, "env-c", () => clock)).toBeUndefined();
    });
  });

  test("never starts one, and does not ask Docker again until the retry interval", async () => {
    setEnv({ FAKE_DOCKER_PORT: "", FAKE_ROOT_TOKEN: "" });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER, async (logs) => {
      expect(await peekOpenCode2ContainerServer(context, "env-c", () => 5_000)).toBeUndefined();
      const calls = (await readLog(logs.exec)).argv;
      expect(calls).not.toContain("exec -d ");
      expect(await peekOpenCode2ContainerServer(context, "env-c", () => 6_000)).toBeUndefined();
      expect((await readLog(logs.exec)).argv).toBe(calls);
    });
  });

  test("a local environment goes to the host server, which is not running", async () => {
    const { context } = createContext(createEnvironment({ id: "env-l" }));
    expect(await openCode2EnvironmentServer(context, "env-l", { start: false })).toBeUndefined();
  });
});

describe("containerRunsOpenCode2", () => {
  const environment = {
    environmentType: "containerized" as const,
    containerId: "container-1",
    containerLifecycle: undefined,
  };
  const bindings = (ports: number[]) =>
    JSON.stringify(Object.fromEntries(ports.map((port) => [`${port}/tcp`, [{ HostPort: "" }]])));
  function deps(agents: Record<string, string> | null, ports: number[]) {
    return {
      readManifest: async () =>
        agents
          ? ({ kind: "manifest", manifest: { agents } } as never)
          : ({ kind: "legacy" } as const),
      networkOwner: async (id: string) => id,
      run: (async (_command: string, args: string[]) => ({
        stdout: args.includes("{{.Image}}") ? "sha256:image" : bindings(ports),
        stderr: "",
      })) as never,
    };
  }
  const { context } = createContext(containerEnvironment());

  test("an image with opencode2 and the published port runs 2.x", async () => {
    expect(
      await containerRunsOpenCode2(
        context,
        environment,
        deps({ opencode: "1.19.5", opencode2: "2.2.6" }, [4096, OPENCODE2_SERVER_PORT]),
      ),
    ).toBe(true);
  });

  test("an older image, a container without the port, or a local environment stays on 1.x", async () => {
    expect(
      await containerRunsOpenCode2(
        context,
        environment,
        deps({ opencode: "1.19.5" }, [4096, OPENCODE2_SERVER_PORT]),
      ),
    ).toBe(false);
    expect(
      await containerRunsOpenCode2(context, environment, deps(null, [OPENCODE2_SERVER_PORT])),
    ).toBe(false);
    expect(
      await containerRunsOpenCode2(context, environment, deps({ opencode2: "2.2.6" }, [4096])),
    ).toBe(false);
    expect(
      await containerRunsOpenCode2(
        context,
        { ...environment, environmentType: "local" },
        deps({ opencode2: "2.2.6" }, [OPENCODE2_SERVER_PORT]),
      ),
    ).toBe(false);
  });
});

test("revoked OpenCode credentials fence reuse and adoption before any Docker operation", async () => {
  const { context } = createContext({
    ...containerEnvironment(),
    revokedInputProviders: ["opencode"],
  });
  await expect(ensureOpenCode2ContainerServer(context, "env-c")).rejects.toThrow("revoked");
  expect(await peekOpenCode2ContainerServer(context, "env-c")).toBeUndefined();
});
