import { afterEach, describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "../src/core/agent-provider-contract";
import { OPENCODE2_SERVER_PORT } from "../src/core/constants";
import { containerCredentialFile } from "../src/core/container-bridge-credential";
import {
  containerRunsOpenCode2,
  openCode2EnvironmentServer,
  peekOpenCode2ContainerServer,
  startContainerOpenCode2Server,
} from "../src/core/opencode2-container-server";
import {
  OPENCODE2_CONTAINER_CLI_PATH,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE,
} from "../src/core/opencode2/container-server";
import { createCommandFixtures } from "./command-fixtures";

const { createContext, createEnvironment, fs, reserveFreePort, withFakeDocker } =
  await createCommandFixtures();

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

/** A stand-in 2.x server: `/api/info` for the expected password (any when unset). */
function serve(port: number, password?: string) {
  return Bun.serve({
    port,
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

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const savedEnv: Record<string, string | undefined> = {};
function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
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
    const port = await reserveFreePort();
    setEnv({ FAKE_DOCKER_PORT: String(port), FAKE_ROOT_TOKEN: "" });
    const { context } = createContext(containerEnvironment());
    await withFakeDocker(FAKE_DOCKER, async (logs) => {
      // The server answers once the detached start has run, as a real one does.
      const arrive = setInterval(async () => {
        if (servers.length === 0 && (await readLog(logs.exec)).argv.includes("exec -d ")) {
          servers.push(serve(port));
        }
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
    const port = await reserveFreePort();
    servers.push(serve(port, ROOT_TOKEN));
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
    const port = await reserveFreePort();
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

describe("peekOpenCode2ContainerServer", () => {
  test("adopts a server started before this backend, then trusts it briefly", async () => {
    const port = await reserveFreePort();
    servers.push(serve(port, ROOT_TOKEN));
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
