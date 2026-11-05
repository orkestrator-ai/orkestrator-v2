import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { bridgeTokenVerifier } from "@orkestrator/protocol/node/bridge-credential";
import { compatibilityPathUsage } from "../src/core/compatibility-path-usage";
import {
  containerBridgeLaunch,
  containerCredentialFile,
  launchContainerScript,
  readContainerBridgeToken,
  removeContainerBridgeCredential,
} from "../src/core/container-bridge-credential";
import { OPENCODE_CREDENTIAL_PLUGIN_PATH } from "../src/core/agent-credential-files";
import {
  startContainerClaudeServer,
  startContainerOpenCodeServer,
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
  *"--user root"*"cat /run/orkestrator-bridge/"*) if [ ! -f "$FAKE_DOCKER_EXEC_LOG.root-removed" ]; then printf '%s' "$FAKE_ROOT_TOKEN"; fi ;;
  *"cat /tmp/"*) printf '%s' "$FAKE_NODE_TOKEN" ;;
esac
exit 0
`;

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

describe("readContainerBridgeToken", () => {
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
    expect(argv[0]!.trim()).toEndWith(`rm -f ${containerCredentialFile("grok")}`);
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
    exit 0 ;;
esac
exit 0
`;
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
    mode: "verifier" | "token-file",
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

  test("verifier mode keeps the password from everything but the server and root", async () => {
    await withOpenCode("verifier", (started, log, argv) => {
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
  });

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
