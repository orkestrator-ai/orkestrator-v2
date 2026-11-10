import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  BRIDGE_AUTHORITY_HEADER,
  bridgeAuthorityFromPublicKey,
  mintBridgeAuthorityKeyPair,
} from "@orkestrator/protocol/node/bridge-authority";
import { bridgeTokenVerifier } from "@orkestrator/protocol/node/bridge-credential";
import {
  bridgeAuthorityHeaders,
  forgetBridgeAuthorityKey,
  hasBridgeAuthorityKey,
} from "../src/core/bridge-authority-keys";
import { compatibilityPathUsage } from "../src/core/compatibility-path-usage";
import {
  containerAuthorityKeyFile,
  containerBridgeLauncherInput,
  containerBridgeLaunch,
  containerCredentialFile,
  containerListenerRecordFile,
  CONTAINER_BRIDGE_LAUNCHER,
  parseContainerBridgeLauncherSession,
  CONTAINER_TOKEN_FILES,
  launchContainerScript,
  readContainerBridgeToken,
  removeContainerBridgeCredential,
} from "../src/core/container-bridge-credential";
import { OPENCODE_CREDENTIAL_PLUGIN_PATH } from "../src/core/agent-credential-files";
import {
  startContainerClaudeServer,
  startContainerOpenCodeServer,
  startContainerServer,
} from "../src/core/commands-containers";
import { createCommandFixtures } from "./command-fixtures";

const { fs, reserveFreePort, withFakeDocker } = await createCommandFixtures();

const TOKEN = `okb_${"t".repeat(43)}`;
const AGENT_TOOLS_TOKEN = `oka_${"a".repeat(43)}`;

/** Logs every argv and any stdin, and answers from the FAKE_* variables. */
const FAKE_DOCKER = `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
case " $* " in
  *" -i "*) printf 'STDIN:%s\\n' "$(cat)" >> "$FAKE_DOCKER_EXEC_LOG" ;;
esac
if [ -n "$FAKE_DOCKER_FAIL" ]; then
  case "$*" in *"$FAKE_DOCKER_FAIL"*) exit 9 ;; esac
fi
case "$*" in
  *"--user root"*"rm -f /run/orkestrator-bridge/"*) touch "$FAKE_DOCKER_EXEC_LOG.root-removed" ;;
  *"--user root"*"cat /run/orkestrator-bridge/"*) if [ ! -f "$FAKE_DOCKER_EXEC_LOG.root-removed" ]; then printf '%s' "$FAKE_ROOT_TOKEN" | { IFS= read -r t; IFS= read -r k; printf '%s\n%s\n' "$t" "$k"; }; printf '%s\n' "\${FAKE_LISTENER-listener-scan-complete}"; fi ;;
  *"--user root"*"ss -Hltne"*) printf '%s\n' "\${FAKE_LISTENER-listener-scan-complete}" ;;
  *"cat /tmp/"*) printf '%s' "$FAKE_NODE_TOKEN" ;;
  *"orkestrator-bridge-launch"*) if [ -n "$FAKE_LAUNCH_SESSION" ]; then printf 'orkestrator-bridge-session=%s\n' "$FAKE_LAUNCH_SESSION"; fi ;;
esac
exit 0
`;

/** The port's listening socket as the root scan prints it, and the scan's last line. */
function listenerScan(inode: string, cookie: string, record?: string): string {
  return [
    ...(record ? [`listener-record ${record}`] : []),
    `listener-socket LISTEN 0 512 0.0.0.0:4097 0.0.0.0:* uid:1000 ino:${inode} sk:${cookie} cgroup:/ <->`,
    "listener-scan-complete",
  ].join("\n");
}

async function withDocker(
  env: Record<string, string>,
  run: (read: () => Promise<{ argv: string[]; stdin: string[] }>) => Promise<void>,
): Promise<void> {
  Object.assign(process.env, env);
  try {
    await withFakeDocker(FAKE_DOCKER, async (logs) => {
      await run(async () => {
        const lines = (await fs.readFile(logs.exec, "utf8").catch(() => "")).split(
          /^(?=ARGV:|STDIN:)/m,
        );
        return {
          argv: lines.filter((line) => line.startsWith("ARGV:")).map((line) => line.slice(5)),
          stdin: lines.filter((line) => line.startsWith("STDIN:")).map((line) => line.slice(6)),
        };
      });
    });
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

afterEach(() => {
  delete process.env.FAKE_DOCKER_FAIL;
  delete process.env.FAKE_LISTENER;
  delete process.env.FAKE_LAUNCH_SESSION;
});

describe("containerBridgeLaunch", () => {
  test.each(["claude", "codex", "cursor", "grok", "pi"] as const)(
    "%s on a capable image gets a verifier, and the token goes to root",
    (kind) => {
      const launch = containerBridgeLaunch(kind, "verifier", TOKEN);

      expect(launch.script).toContain(`_SHA256=${bridgeTokenVerifier(TOKEN)}`);
      expect(launch.script).not.toContain(TOKEN);
      expect(launch.launch).toEqual({ rootCredential: { kind, token: TOKEN } });
      // A `bunfig.toml` in the checkout must not run inside the bridge.
      expect(launch.bun).toBe("bun --config=/dev/null");
    },
  );

  test("an older image still gets the token, on stdin and in its /tmp file", () => {
    const launch = containerBridgeLaunch("codex", "token-file", TOKEN);

    expect(launch.launch).toEqual({
      secrets: { CODEX_BRIDGE_TOKEN: TOKEN },
      removeRootCredential: "codex",
    });
    expect(launch.script).toBe(`printf '%s' "$CODEX_BRIDGE_TOKEN" > /tmp/codex-bridge-token`);
    expect(launch.bun).toBe("bun");
  });

  test.each([
    ["claude", "CLAUDE_BRIDGE_TOKEN", 4097],
    ["codex", "CODEX_BRIDGE_TOKEN", 4098],
    ["cursor", "CURSOR_BRIDGE_TOKEN", 4099],
    ["grok", "ACP_BRIDGE_TOKEN", 4100],
    ["pi", "PI_BRIDGE_TOKEN", 4101],
  ] as const)(
    "%s on a launcher image is started by root's script, and its shell sees no credential",
    (kind, tokenEnv, port) => {
      const launch = containerBridgeLaunch(kind, "launcher", TOKEN);
      const { rootCredential, launcher } = launch.launch;

      // The node shell only removes an old file and records its environment.
      expect(launch.script).toBe(`rm -f ${CONTAINER_TOKEN_FILES[kind]}`);
      expect(launch.start(`/opt/${kind}-bridge/dist/index.js`, "/tmp/x.log")).toBe(
        `env -0 > ${launcher!.snapshot}`,
      );
      expect(launcher!.snapshot).toMatch(
        new RegExp(`^/tmp/\\.orkestrator-bridge-env-${kind}-[0-9a-f]{32}$`),
      );
      // Root keeps the token and the private key; the launcher gives the bridge
      // the verifier, the public key and the port.
      expect(rootCredential).toMatchObject({ kind, token: TOKEN });
      expect(launcher!.kind).toBe(kind);
      expect(launcher!.env).toEqual({
        [`${tokenEnv}_SHA256`]: bridgeTokenVerifier(TOKEN),
        [`${tokenEnv}_AUTHORITY_KEY`]: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/),
        PORT: String(port),
        HOSTNAME: "0.0.0.0",
      });
      // The two halves belong together.
      const verifier = bridgeAuthorityFromPublicKey(launcher!.env[`${tokenEnv}_AUTHORITY_KEY`]);
      expect(verifier.enforced).toBe(true);
      expect(rootCredential!.authorityKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(JSON.stringify(launcher!.env)).not.toContain(rootCredential!.authorityKey!);
    },
  );

  test("the launcher's input is one checked NAME=VALUE per line", () => {
    expect(containerBridgeLauncherInput({ PORT: "4097", A_KEY: "x=y" })).toBe(
      "PORT=4097\nA_KEY=x=y\n",
    );
    expect(() => containerBridgeLauncherInput({ PORT: "1\nLD_PRELOAD=/tmp/x" })).toThrow();
    expect(() => containerBridgeLauncherInput({ "bad name": "1" })).toThrow();
  });

  test("mints a prefixed token when none is given", () => {
    expect(containerBridgeLaunch("pi", "verifier").token).toMatch(/^okb_[A-Za-z0-9_-]{43}$/);
  });
});

describe("launchContainerScript", () => {
  test("writes the credential as root on stdin, and keeps every token out of argv", async () => {
    await withDocker({}, async (read) => {
      await launchContainerScript("container", "echo start", {
        rootCredential: { kind: "claude", token: TOKEN },
        secrets: { ORKESTRATOR_AGENT_MCP_TOKEN: AGENT_TOOLS_TOKEN },
      });

      const { argv, stdin } = await read();
      expect(argv.join("\n")).not.toContain(TOKEN);
      expect(argv.join("\n")).not.toContain(AGENT_TOOLS_TOKEN);
      const [root, secrets, start] = argv;
      expect(root).toContain("--env PATH=/usr/sbin:/usr/bin:/sbin:/bin --user root");
      expect(root).toContain("umask 077");
      expect(root).toContain(containerCredentialFile("claude"));
      expect(stdin[0]!.trim()).toBe(TOKEN);
      expect(secrets).toStartWith(
        "exec -i container sh -c umask 077; cat > /tmp/.orkestrator-start-",
      );
      expect(stdin[1]!.trim()).toBe(`export ORKESTRATOR_AGENT_MCP_TOKEN='${AGENT_TOOLS_TOKEN}'`);
      // The script deletes the file before anything else runs.
      expect(start).toMatch(
        /^exec -d container bash -lc \. (\/tmp\/\.orkestrator-start-[0-9a-f]+)\nrm -f \1\necho start/,
      );
    });
  });

  test("omits a secret with no value, and the file when none remain", async () => {
    await withDocker({}, async (read) => {
      await launchContainerScript("container", "echo start", {
        secrets: { ORKESTRATOR_AGENT_MCP_TOKEN: undefined },
      });

      const { argv } = await read();
      expect(argv).toHaveLength(1);
      expect(argv[0]!.trim()).toBe("exec -d container bash -lc echo start");
    });
  });

  test("a failed launch removes the delivered file and its error carries no secret", async () => {
    await withDocker({ FAKE_DOCKER_FAIL: "exec -d" }, async (read) => {
      const failure = await launchContainerScript("container", "echo start", {
        secrets: { A_TOKEN: AGENT_TOOLS_TOKEN },
      }).catch((error: unknown) => error as Error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(AGENT_TOOLS_TOKEN);
      const { argv } = await read();
      const delivered = argv[0]!.match(/\/tmp\/\.orkestrator-start-[0-9a-f]+/)?.[0];
      expect(argv.at(-1)).toContain(`rm -f ${delivered}`);
    });
  });

  test("a failed root write starts nothing", async () => {
    await withDocker({ FAKE_DOCKER_FAIL: "--user root" }, async (read) => {
      await expect(
        launchContainerScript("container", "echo start", {
          rootCredential: { kind: "pi", token: TOKEN },
        }),
      ).rejects.toThrow();

      expect((await read()).argv).toHaveLength(1);
    });
  });
});

describe("launchContainerScript with the launcher", () => {
  test("prepares as node, then starts through root's script with nothing secret in argv", async () => {
    await withDocker({}, async (read) => {
      const launch = containerBridgeLaunch("pi", "launcher", TOKEN);
      const privateKey = launch.launch.rootCredential!.authorityKey!;
      await launchContainerScript("container", `echo prepare\n${launch.start("", "")}`, {
        ...launch.launch,
        secrets: { ORKESTRATOR_AGENT_MCP_TOKEN: AGENT_TOOLS_TOKEN },
      });

      const { argv, stdin } = await read();
      const all = argv.join("\n");
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(privateKey);
      expect(all).not.toContain(AGENT_TOOLS_TOKEN);
      const [root, secrets, prepare, start] = argv;
      // Root's file takes the token and the private key, on stdin.
      expect(root).toContain("--user root");
      expect(root).toContain(containerAuthorityKeyFile("pi"));
      expect(stdin[0]).toBe(`${TOKEN}\n${privateKey}\n`);
      expect(secrets).toContain("cat > /tmp/.orkestrator-start-");
      // Preparation runs to completion, not detached, and never sees a verifier.
      expect(prepare).toMatch(/^exec container bash -lc /);
      expect(prepare).toContain(`env -0 > ${launch.launch.launcher!.snapshot}`);
      expect(all).not.toContain(bridgeTokenVerifier(TOKEN));
      // The bridge itself: no login shell, a fixed PATH, the backend's values on stdin.
      expect(start!.trim()).toBe(
        `exec -i --user node --workdir / --env PATH=/usr/sbin:/usr/bin:/sbin:/bin container ${CONTAINER_BRIDGE_LAUNCHER} pi ${launch.launch.launcher!.snapshot}`,
      );
      expect(stdin.at(-1)).toContain(`PI_BRIDGE_TOKEN_SHA256=${bridgeTokenVerifier(TOKEN)}\n`);
      expect(stdin.at(-1)).toContain("PORT=4101\n");
      expect(stdin.at(-1)).not.toContain(privateKey);
      // The backend can now sign for that bridge.
      expect(hasBridgeAuthorityKey(TOKEN)).toBe(true);
      forgetBridgeAuthorityKey(TOKEN);
    });
  });

  test("a failed launcher start removes the snapshot it would have handed over", async () => {
    await withDocker({ FAKE_DOCKER_FAIL: CONTAINER_BRIDGE_LAUNCHER }, async (read) => {
      const launch = containerBridgeLaunch("codex", "launcher", TOKEN);
      await expect(
        launchContainerScript("container", launch.start("", ""), launch.launch),
      ).rejects.toThrow();
      const { argv } = await read();
      expect(argv.at(-1)).toContain(`rm -f ${launch.launch.launcher!.snapshot}`);
      forgetBridgeAuthorityKey(TOKEN);
    });
  });
});

describe("readContainerBridgeToken", () => {
  test("reads the authority key with the token, and signs with it", async () => {
    const keys = mintBridgeAuthorityKeyPair();
    await withDocker({ FAKE_ROOT_TOKEN: `${TOKEN}\n${keys.privateKey}` }, async () => {
      expect(await readContainerBridgeToken("container", "claude")).toBe(TOKEN);
    });
    try {
      expect(hasBridgeAuthorityKey(TOKEN)).toBe(true);
      const url = "http://127.0.0.1:1/session/s/permissions/r";
      const body = JSON.stringify({ allow: true });
      const header = bridgeAuthorityHeaders(TOKEN, "POST", url, body)[BRIDGE_AUTHORITY_HEADER];
      expect(
        bridgeAuthorityFromPublicKey(keys.publicKey).check({
          method: "POST",
          url,
          header,
          body: Buffer.from(body),
        }),
      ).toEqual({ ok: true });
      // Reads and close are not signed.
      expect(bridgeAuthorityHeaders(TOKEN, "GET", url, undefined)).toEqual({});
      expect(bridgeAuthorityHeaders(TOKEN, "POST", "http://h/session/s/close", "{}")).toEqual({});
      // A token read back without a key, from a bridge an older image started, signs nothing.
      await withDocker({ FAKE_ROOT_TOKEN: `${TOKEN}\n` }, async () => {
        expect(await readContainerBridgeToken("container", "claude")).toBe(TOKEN);
      });
      expect(hasBridgeAuthorityKey(TOKEN)).toBe(false);
      expect(bridgeAuthorityHeaders(TOKEN, "POST", url, body)).toEqual({});
    } finally {
      forgetBridgeAuthorityKey(TOKEN);
    }
  });

  test("prefers the root file, and root never touches the node-writable /tmp file", async () => {
    await withDocker({ FAKE_ROOT_TOKEN: `${TOKEN}\n` }, async (read) => {
      expect(await readContainerBridgeToken("container", "claude")).toBe(TOKEN);

      const { argv } = await read();
      expect(argv).toHaveLength(1);
      expect(argv[0]).toContain(containerCredentialFile("claude"));
      expect(argv[0]).not.toContain("/tmp/");
    });
  });

  test("falls back, as node, to a running bridge's unprefixed token and counts it", async () => {
    const unprefixed = "U".repeat(43);
    const record = spyOn(compatibilityPathUsage, "record");
    try {
      await withDocker({ FAKE_NODE_TOKEN: `${unprefixed}\n` }, async (read) => {
        expect(await readContainerBridgeToken("container", "codex")).toBe(unprefixed);

        const { argv } = await read();
        expect(argv[1]).not.toContain("--user root");
        expect(argv[1]).toContain("cat /tmp/codex-bridge-token");
      });
      expect(record).toHaveBeenCalledWith("bridge-credential.token-file");
    } finally {
      record.mockRestore();
    }
  });

  test("a malformed value is no token", async () => {
    await withDocker({ FAKE_NODE_TOKEN: "not a token" }, async () => {
      expect(await readContainerBridgeToken("container", "pi")).toBeNull();
    });
  });

  test("OpenCode's password follows the same order as a bridge's token", async () => {
    await withDocker({ FAKE_ROOT_TOKEN: "r".repeat(43) }, async (read) => {
      expect(await readContainerBridgeToken("container", "opencode")).toBe("r".repeat(43));

      const { argv } = await read();
      expect(argv).toHaveLength(1);
      expect(argv[0]).toContain("--user root");
      expect(argv[0]).toContain("/run/orkestrator-bridge/opencode-token");
    });
    // A server an older backend or an older image started.
    await withDocker({ FAKE_NODE_TOKEN: "o".repeat(43) }, async (read) => {
      expect(await readContainerBridgeToken("container", "opencode")).toBe("o".repeat(43));

      const { argv } = await read();
      expect(argv).toHaveLength(2);
      expect(argv[1]).not.toContain("--user root");
      expect(argv[1]).toContain("/tmp/opencode-server-password");
    });
  });

  test("a docker failure is not an absent token", async () => {
    await withDocker({ FAKE_DOCKER_FAIL: "exec" }, async () => {
      await expect(readContainerBridgeToken("container", "claude")).rejects.toThrow();
    });
  });
});

test("removing a credential runs as root and names only that bridge's file", async () => {
  await withDocker({}, async (read) => {
    await removeContainerBridgeCredential("container", "grok");

    const { argv } = await read();
    expect(argv[0]).toContain("--user root");
    expect(argv[0]!.trim()).toEndWith(
      `rm -f ${containerCredentialFile("grok")} ${containerAuthorityKeyFile("grok")} ${containerListenerRecordFile("grok")}`,
    );
  });
});

/**
 * A start command end to end, on a capable image: nothing the agent or a local
 * `ps` can read carries a token, and the agent-tools token reaches the script.
 */
test("a Claude start on a capable image puts no token in any argv", async () => {
  const hostPort = await reserveFreePort();
  let bridge: ReturnType<typeof Bun.serve> | undefined;
  const script = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' ${hostPort}; exit 0 ;;
  exec)
    printf 'ARGV:%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case " $* " in
      *" -i "*) printf 'STDIN:%s\\n' "$(cat)" >> "$FAKE_DOCKER_EXEC_LOG" ;;
    esac
    case "$*" in
      *"ss -Hltne"*) printf '%s\\n' "$FAKE_LISTENER" ;;
    esac
    exit 0 ;;
esac
exit 0
`;
  process.env.FAKE_LISTENER = listenerScan("31", "4f");
  await withFakeDocker(script, async (logs) => {
    // The bridge answers once the launch has run, as a real one does.
    const arrive = setInterval(async () => {
      const log = await fs.readFile(logs.exec, "utf8").catch(() => "");
      if (!bridge && log.includes("exec -d ")) {
        bridge = Bun.serve({
          port: hostPort,
          hostname: "127.0.0.1",
          fetch: () => new Response("{}"),
        });
      }
    }, 50);
    try {
      const started = await startContainerClaudeServer(
        "container",
        { url: "http://host.docker.internal:1/mcp", token: AGENT_TOOLS_TOKEN },
        false,
        undefined,
        "verifier",
      );
      expect(started.authToken).toMatch(/^okb_/);
      const log = await fs.readFile(logs.exec, "utf8");
      const argv = log
        .split(/^(?=ARGV:|STDIN:)/m)
        .filter((line) => line.startsWith("ARGV:"))
        .join("\n");
      expect(argv).not.toContain(started.authToken);
      expect(argv).not.toContain(AGENT_TOOLS_TOKEN);
      expect(argv).toContain(
        `CLAUDE_BRIDGE_TOKEN_SHA256=${bridgeTokenVerifier(started.authToken)}`,
      );
      expect(argv).toContain("bun --config=/dev/null /opt/claude-bridge/dist/index.js");
      expect(argv).toContain("rm -f /tmp/claude-bridge-token");
      expect(log).toContain(`STDIN:${started.authToken}`);
      expect(log).toContain(`export ORKESTRATOR_AGENT_MCP_TOKEN='${AGENT_TOOLS_TOKEN}'`);
      // No listener is trusted from the token's write until the bridge answers,
      // and then the socket on its port is recorded, by root.
      const execs = log.split(/^(?=ARGV:|STDIN:)/m).filter((entry) => entry.startsWith("ARGV:"));
      const write = execs.findIndex((entry) => entry.includes('mv "$credential_tmp"'));
      expect(execs[write]).toContain(`'pending' > "$record_tmp"`);
      const recorded = execs.findIndex((entry) => entry.includes("'31:4f'"));
      expect(recorded).toBeGreaterThan(write);
      expect(execs[recorded]).toContain("--user root");
      expect(execs[recorded]).toContain(containerListenerRecordFile("claude"));
    } finally {
      clearInterval(arrive);
      bridge?.stop(true);
    }
  });
});

test("token-file launch removes the stale root token before starting", async () => {
  await withDocker({ FAKE_ROOT_TOKEN: "o".repeat(43), FAKE_NODE_TOKEN: TOKEN }, async (read) => {
    expect(await readContainerBridgeToken("container", "codex")).toBe("o".repeat(43));
    const launch = containerBridgeLaunch("codex", "token-file", TOKEN);
    await launchContainerScript("container", launch.script, launch.launch);
    const { argv } = await read();
    const removal = argv.findIndex((line) =>
      line.includes("rm -f /run/orkestrator-bridge/codex-token"),
    );
    const start = argv.findIndex((line) => line.includes("exec -d"));
    expect(removal).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(removal);
    expect(await readContainerBridgeToken("container", "codex")).toBe(TOKEN);
  });
});

describe("startContainerOpenCodeServer", () => {
  /** A fake server that answers health only for the password the script was given. */
  async function withOpenCode(
    mode: "launcher" | "verifier" | "token-file",
    check: (started: { authToken: string }, log: string, argv: string) => void,
  ): Promise<void> {
    const port = await reserveFreePort();
    const previousPort = process.env.FAKE_DOCKER_PORT;
    process.env.FAKE_DOCKER_PORT = String(port);
    const script = `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
case " $* " in
  *" -i "*) printf 'STDIN:%s\\n' "$(cat)" >> "$FAKE_DOCKER_EXEC_LOG" ;;
esac
case "$1" in
  inspect) printf 'running\\n' ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_DOCKER_PORT" ;;
esac
exit 0
`;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let arrive: ReturnType<typeof setInterval> | undefined;
    try {
      await withFakeDocker(script, async (logs) => {
        // The server answers once the launch has run, as a real one does.
        arrive = setInterval(async () => {
          const log = await fs.readFile(logs.exec, "utf8").catch(() => "");
          if (!server && log.includes("exec -d ")) {
            server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json({}) });
          }
        }, 50);
        const started = await startContainerOpenCodeServer("container", mode);
        const log = await fs.readFile(logs.exec, "utf8");
        const argv = log
          .split(/^(?=ARGV:|STDIN:)/m)
          .filter((line) => line.startsWith("ARGV:"))
          .join("\n");
        check(started, log, argv);
      });
    } finally {
      clearInterval(arrive);
      server?.stop(true);
      if (previousPort === undefined) delete process.env.FAKE_DOCKER_PORT;
      else process.env.FAKE_DOCKER_PORT = previousPort;
    }
  }

  test.each(["verifier", "launcher"] as const)(
    "%s mode keeps the password from everything but the server and root",
    async (mode) => {
      await withOpenCode(mode, (started, log, argv) => {
        expect(started.authToken).toMatch(/^okb_/);
        expect(argv).not.toContain(started.authToken);
        // Root's file, on stdin.
        expect(argv).toContain("--user root");
        expect(argv).toContain('mv "$credential_tmp" /run/orkestrator-bridge/opencode-token');
        expect(log).toContain(`STDIN:${started.authToken}`);
        // Not left where `node` reads it, and a stale one goes.
        expect(argv).not.toContain("> /tmp/opencode-server-password");
        expect(argv).toContain("rm -f /tmp/opencode-server-password");
        // Handed to the server alone, with the plugin that takes it back in place.
        expect(argv).toContain("export -n OPENCODE_SERVER_PASSWORD");
        expect(argv).toContain(`> ${OPENCODE_CREDENTIAL_PLUGIN_PATH}`);
        expect(argv).toContain(
          `OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" setsid opencode serve`,
        );
        expect(argv).not.toContain("setsid sh -c");
      });
    },
  );

  test("token-file mode keeps an older image's layout and clears a stale root file", async () => {
    await withOpenCode("token-file", (started, log, argv) => {
      expect(started.authToken).toMatch(/^okb_/);
      expect(argv).not.toContain(started.authToken);
      expect(argv).toContain("rm -f /run/orkestrator-bridge/opencode-token");
      expect(argv).toContain("> /tmp/opencode-server-password");
      expect(argv).not.toContain(OPENCODE_CREDENTIAL_PLUGIN_PATH);
      expect(argv).not.toContain("export -n");
      expect(log).toContain(`export OPENCODE_SERVER_PASSWORD='${started.authToken}'`);
    });
  });
});

/**
 * To-do 7250: the token goes only to the socket the bridge the backend
 * launched opened, never to whatever listens on its port now.
 */
describe("the listener on a bridge's port", () => {
  test("the recorded socket gets its token, in the same root exec", async () => {
    await withDocker(
      { FAKE_ROOT_TOKEN: `${TOKEN}\n`, FAKE_LISTENER: listenerScan("7", "a1", "7:a1") },
      async (read) => {
        expect(await readContainerBridgeToken("container", "claude")).toBe(TOKEN);
        const { argv } = await read();
        expect(argv).toHaveLength(1);
        expect(argv[0]).toContain("--user root");
        expect(argv[0]).toContain("ss -Hltne 'sport = :4097'");
        expect(argv[0]).toContain(containerListenerRecordFile("claude"));
      },
    );
  });

  test.each([
    ["a different socket", listenerScan("8", "b2", "7:a1")],
    [
      "a socket beside the bridge's",
      `${listenerScan("7", "a1", "7:a1")}\n${listenerScan("9", "c3")}`,
    ],
    ["a start that has not recorded its bridge", listenerScan("7", "a1", "pending")],
    ["a scan that did not finish", ""],
  ])("%s gets no token, and nothing falls back to /tmp", async (_name, listener) => {
    await withDocker(
      { FAKE_ROOT_TOKEN: `${TOKEN}\n`, FAKE_NODE_TOKEN: TOKEN, FAKE_LISTENER: listener },
      async (read) => {
        expect(await readContainerBridgeToken("container", "pi")).toBeNull();
        expect((await read()).argv).toHaveLength(1);
      },
    );
  });

  test("an empty port still has its token: no process can receive it there", async () => {
    await withDocker({ FAKE_ROOT_TOKEN: `${TOKEN}\n` }, async () => {
      expect(await readContainerBridgeToken("container", "codex")).toBe(TOKEN);
    });
  });

  test("a bridge an older backend started is recorded as it stands", async () => {
    await withDocker(
      { FAKE_ROOT_TOKEN: `${TOKEN}\n`, FAKE_LISTENER: listenerScan("7", "a1") },
      async (read) => {
        expect(await readContainerBridgeToken("container", "grok")).toBe(TOKEN);
        const { argv } = await read();
        expect(argv).toHaveLength(2);
        expect(argv[1]).toContain("--user root");
        expect(argv[1]).toContain(`'7:a1' > "$record_tmp"`);
        expect(argv[1]).toContain(containerListenerRecordFile("grok"));
      },
    );
  });

  test("failed adoption refuses the token without falling back for status, reuse and peek readers", async () => {
    await withDocker(
      {
        FAKE_ROOT_TOKEN: `${TOKEN}\n`,
        FAKE_NODE_TOKEN: TOKEN,
        FAKE_LISTENER: listenerScan("7", "a1"),
        FAKE_DOCKER_FAIL: "record_tmp=",
      },
      async (read) => {
        expect(await readContainerBridgeToken("container", "grok")).toBeNull();
        expect((await read()).argv.some((line) => line.includes("cat /tmp/"))).toBe(false);
      },
    );
  });

  test("OpenCode, which has no bridge of ours, is read as before", async () => {
    await withDocker({ FAKE_ROOT_TOKEN: "r".repeat(43), FAKE_LISTENER: "" }, async (read) => {
      expect(await readContainerBridgeToken("container", "opencode")).toBe("r".repeat(43));
      expect((await read()).argv[0]).not.toContain("ss -Hltne");
    });
  });

  test("a new token marks the record pending; OpenCode's has none", async () => {
    await withDocker({}, async (read) => {
      await launchContainerScript("container", "echo start", {
        rootCredential: { kind: "pi", token: TOKEN },
      });
      await launchContainerScript("container", "echo start", {
        rootCredential: { kind: "opencode", token: TOKEN },
      });
      const roots = (await read()).argv.filter((line) => line.includes("--user root"));
      expect(roots[0]).toContain(`'pending' > "$record_tmp"`);
      expect(roots[0]).toContain(containerListenerRecordFile("pi"));
      expect(roots[1]).not.toContain("listener");
    });
  });

  test("the launcher's session report", () => {
    expect(parseContainerBridgeLauncherSession("orkestrator-bridge-session=4242\n")).toBe(4242);
    expect(parseContainerBridgeLauncherSession("noise\norkestrator-bridge-session=17\n")).toBe(17);
    // An older launcher says nothing; pid 1 and garbage are not a launch.
    expect(parseContainerBridgeLauncherSession("")).toBeUndefined();
    expect(parseContainerBridgeLauncherSession("orkestrator-bridge-session=1")).toBeUndefined();
    expect(parseContainerBridgeLauncherSession("orkestrator-bridge-session=1x")).toBeUndefined();
  });

  test("a launch through the launcher returns the session it reported", async () => {
    await withDocker({ FAKE_LAUNCH_SESSION: "4242" }, async () => {
      const launch = containerBridgeLaunch("pi", "launcher", TOKEN);
      try {
        expect(
          await launchContainerScript("container", launch.start("", ""), launch.launch),
        ).toEqual({ session: 4242 });
      } finally {
        forgetBridgeAuthorityKey(TOKEN);
      }
    });
  });

  /** A container whose bridge answers once the launcher ran, with `listener` as root's scan. */
  async function startPi(listener: string) {
    let ready = false;
    const bridge = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("{}", { status: ready ? 200 : 503 }),
    });
    const hostPort = bridge.port;
    const script = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' ${hostPort}; exit 0 ;;
  exec)
    printf 'ARGV:%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case " $* " in *" -i "*) cat > /dev/null ;; esac
    case "$*" in
      *"orkestrator-bridge-launch"*) printf 'orkestrator-bridge-session=4242\\n' ;;
      *"--user root"*"ss -Hltne"*) printf '%s\\n' "$FAKE_LISTENER" ;;
    esac
    exit 0 ;;
esac
exit 0
`;
    process.env.FAKE_LISTENER = listener;
    let outcome: unknown;
    let argv: string[] = [];
    await withFakeDocker(script, async (logs) => {
      const arrive = setInterval(async () => {
        const log = await fs.readFile(logs.exec, "utf8").catch(() => "");
        if (log.includes(CONTAINER_BRIDGE_LAUNCHER)) ready = true;
      }, 50);
      const launch = containerBridgeLaunch("pi", "launcher", TOKEN);
      try {
        outcome = await startContainerServer(
          "container",
          4101,
          "pi",
          launch.start("", ""),
          launch.launch,
        ).catch((error: unknown) => error);
        argv = (await fs.readFile(logs.exec, "utf8"))
          .split(/^(?=ARGV:)/m)
          .filter((entry) => entry.startsWith("ARGV:"));
      } finally {
        clearInterval(arrive);
        bridge?.stop(true);
        forgetBridgeAuthorityKey(TOKEN);
      }
    });
    return { outcome, argv };
  }

  test("a launched bridge's socket is recorded while a bridge lives in its launch session", async () => {
    const { outcome, argv } = await startPi(`${listenerScan("31", "4f")}\nlistener-launch-alive`);
    expect(outcome).toMatchObject({ wasRunning: false });
    const scan = argv.find((entry) => entry.includes("ss -Hltne") && entry.includes("--user root"));
    expect(scan).toContain("-v session=4242");
    expect(scan).toContain("--privileged");
    expect(argv.some((entry) => entry.includes(`'31:4f' > "$record_tmp"`))).toBe(true);
  });

  test("a socket held after the launched bridge died is stopped, and the start fails", async () => {
    const { outcome, argv } = await startPi(listenerScan("31", "4f"));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("held by a process the backend did not start");
    expect((outcome as Error).message).not.toContain(TOKEN);
    expect((outcome as Error).message).toContain("cleanup was attempted");
    expect((outcome as Error).message).not.toContain("it was stopped");
    expect(argv.some((entry) => entry.includes("'31:4f'"))).toBe(false);
    // The stop runs as node, without a login shell, against the port.
    const stop = argv.find(
      (entry) => entry.includes("--user node") && entry.includes("kill -TERM"),
    );
    expect(stop).toContain("ss -Hltne 'sport = :4101'");
    expect(stop).toContain("--env PATH=/usr/sbin:/usr/bin:/sbin:/bin");
  });
});
