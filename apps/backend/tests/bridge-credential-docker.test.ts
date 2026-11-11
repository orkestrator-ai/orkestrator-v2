/**
 * Security report H4 on a real container: a process running as the agent's uid
 * cannot get the bridge-control credential, cannot answer an approval without
 * it, and the backend's own calls still work. On a `bridge-launch=1` image
 * (docs/architecture/agent-approvals.md) a token it catches in flight still answers nothing, and what it
 * plants in its login shell does not run inside the next bridge. A bridge it starts in place of the
 * backend's is noticed and replaced (#2030).
 *
 * On an `opencode2-launch=1` image the OpenCode (2.x) server runs root's binary
 * with only root's configuration, so plugins the agent plants never load, a
 * process the agent puts on its port gets no password and is replaced, its
 * package cache is root's, and the checkout's configuration reaches it only as
 * root's filtered copy (#2091). (The OpenCode 1.x cases left with 1.x.)
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * with `bridge-credential=1`, `bridge-launch=1` and `opencode2-launch=1`. No credential is delivered (an agent-test context
 * with no sources) and no agent turn runs, so nothing is billed. Tokens reach
 * the container only on stdin, so this suite adds none to any argv.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BRIDGE_AUTHORITY_REFUSED_CODE,
  bridgeAuthorityKeyEnv,
} from "@orkestrator/protocol/node/bridge-authority";
import { bridgeTokenVerifier } from "@orkestrator/protocol/node/bridge-credential";
import { bridgeAuthorityHeaders } from "../src/core/bridge-authority-keys";
import { bridgeFetch } from "../src/core/http-bridge/transport";
import {
  containerAuthorityKeyFile,
  containerCredentialFile,
  containerListenerRecordFile,
  CONTAINER_TOKEN_FILES,
  readContainerBridgeToken,
  type ContainerBridgeKind,
} from "../src/core/container-bridge-credential";
import { CODEX_MAX_CONCURRENT_THREADS_ENV, OPENCODE2_SERVER_PORT } from "../src/core/constants";
import type { CommandContext } from "../src/core/commands-context";
import { startContainerOpenCode2Server } from "../src/core/opencode2-container-server";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { runCommand } from "../src/core/shell";
import { removeLabelledResources } from "./container-live-cleanup";
import { createCommandFixtures } from "./command-fixtures";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
/** A model the fixture configuration names, on a port inside the container; never asked. */
const FAKE_MODEL_PORT = 4599;
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `credential-${Date.now().toString(36)}`;
const RUN_LABEL = `orkestrator-qualification=${RUN}`;
const LIVE_TIMEOUT_MS = 240_000;

/** Each bridge, its container port, its process, and a route that answers an approval. */
const BRIDGES: ReadonlyArray<{
  kind: ContainerBridgeKind;
  port: number;
  process: string;
  answer: string;
  tokenEnv: string;
}> = [
  {
    kind: "claude",
    port: 4097,
    process: "claude-bridge/dist/index.js",
    tokenEnv: "CLAUDE_BRIDGE_TOKEN",
    answer: "/session/none/permissions/request",
  },
  {
    kind: "codex",
    port: 4098,
    process: "codex-bridge/dist/index.js",
    tokenEnv: "CODEX_BRIDGE_TOKEN",
    answer: "/session/none/approvals/request",
  },
  {
    kind: "cursor",
    port: 4099,
    process: "cursor-bridge/dist/index.js",
    tokenEnv: "CURSOR_BRIDGE_TOKEN",
    answer: "/session/none/approvals/request",
  },
  {
    kind: "grok",
    port: 4100,
    process: "acp-bridge/dist/index.js",
    tokenEnv: "ACP_BRIDGE_TOKEN",
    answer: "/session/none/approvals/request",
  },
  {
    kind: "pi",
    port: 4101,
    process: "pi-bridge/dist/index.js",
    tokenEnv: "PI_BRIDGE_TOKEN",
    answer: "/session/none/approvals/request",
  },
];

let dataDir = "";
let home = "";
/** The user's host `~/.config/opencode`, mounted read-only as the staged input. */
let openCodeHostConfig = "";
let containerId = "";
let homeDirectory: ReturnType<typeof spyOn> | undefined;
let invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>;
let fixtureContext: CommandContext;
const started = new Map<ContainerBridgeKind, { hostPort: number; authToken: string }>();

async function docker(args: string[], stdin?: string): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs: 120_000, stdin })).stdout.trim();
}

/** A shell as the agent's user, with `stdin` for anything secret. */
async function asAgent(script: string, stdin?: string): Promise<string> {
  return docker(["exec", "-i", "--user", "node", containerId, "bash", "-c", script], stdin);
}

/** The status of an authenticated-looking call made from inside the container. */
async function statusFromAgent(port: number, route: string, bearer: string): Promise<string> {
  // curl reads its header from stdin, so the value is not in its argv either.
  return asAgent(
    `curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H @- http://127.0.0.1:${port}${route} -d '{}'`,
    `Authorization: Bearer ${bearer}\nX-Orkestrator-Claude-Token: ${bearer}\n`,
  );
}

/** Root's own read of a file the agent cannot open, for the test to scan for. */
async function asRoot(script: string): Promise<string> {
  return docker(["exec", "--user", "root", containerId, "sh", "-c", script]);
}

/** What the backend's transport sends, signature included, to a bridge on the host port. */
function backendFetch(
  kind: ContainerBridgeKind,
  bridge: { hostPort: number; authToken: string },
  route: string,
  init: RequestInit = {},
): Promise<Response> {
  return bridgeFetch(
    { agent: kind, baseUrl: `http://127.0.0.1:${bridge.hostPort}`, authToken: bridge.authToken },
    route,
    init,
  );
}

/** A labelled container on `image`'s real entrypoint, with its bridge commands. */
async function startFixture(image: string, name: string) {
  const owner = dockerOwnerNamespace(dataDir);
  const id = await docker([
    "run",
    "-d",
    "--name",
    `ork-${RUN}-${name}`,
    "--label",
    RUN_LABEL,
    "--label",
    "app=orkestrator-v2",
    "--label",
    `orkestrator-owner=${owner}`,
    "--cap-add",
    "NET_ADMIN",
    "-e",
    "NETWORK_MODE=full",
    "-e",
    "GIT_URL=https://example.invalid/none.git",
    ...BRIDGES.flatMap((bridge) => ["-p", `127.0.0.1::${bridge.port}`]),
    "-p",
    `127.0.0.1::${OPENCODE2_SERVER_PORT}`,
    "-v",
    `${openCodeHostConfig}:/opencode-config:ro`,
    image,
  ]);
  await waitForContainerBoot(id, { timeoutMs: 120_000 });
  const imageId = await docker(["inspect", "--format", "{{.Image}}", id]);
  const { createCommandRegistry, createContext, createEnvironment } = await createCommandFixtures();
  const environment = createEnvironment({
    id: `env-${RUN}-${name}`,
    environmentType: "containerized",
    containerId: id,
    status: "running",
    containerLifecycle: {
      schemaVersion: 1,
      revision: 1,
      lastRuntimeGeneration: 1,
      runtime: { containerId: id, runtimeGeneration: 1, owner, imageId },
      storage: { format: "legacy-layer", workspaceGeneration: 1 },
      outcomes: [],
    },
  });
  const { context } = createContext(environment, { dataDir });
  context.runtimeFlavor = "agent-test";
  context.credentialSources = new Set();
  const commands = createCommandRegistry();
  return {
    id,
    context,
    invoke: async (command: string, args: Record<string, unknown>) =>
      commands.get(command)?.(args, context),
  };
}

beforeAll(async () => {
  if (!ENABLED) return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-bridge-credential-"));
  dataDir = path.join(root, "data");
  home = path.join(root, "home");
  await fs.mkdir(dataDir);
  await fs.mkdir(home);
  // The user's own OpenCode configuration: a fixture model (no model is
  // reached here), and a plugin of theirs that 2.x leaves out.
  openCodeHostConfig = path.join(root, "opencode-config");
  await fs.mkdir(path.join(openCodeHostConfig, "plugins"), { recursive: true });
  await fs.writeFile(
    path.join(openCodeHostConfig, "opencode.json"),
    JSON.stringify({
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local fixture",
          options: { baseURL: `http://127.0.0.1:${FAKE_MODEL_PORT}/v1`, apiKey: "not-a-key" },
          models: { fixture: { name: "Fixture", limit: { context: 16000, output: 2000 } } },
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(openCodeHostConfig, "plugins", "user-plugin.js"),
    `import { writeFileSync } from "node:fs";
export const UserPlugin = async () => { writeFileSync("/tmp/user-host-plugin-loaded", "1"); return {}; };
`,
  );
  // No host login can reach the container, whatever this machine holds.
  process.env.HOME = home;
  homeDirectory = spyOn(os, "homedir").mockReturnValue(home);
  const fixture = await startFixture(IMAGE, "capable");
  containerId = fixture.id;
  invoke = fixture.invoke;
  fixtureContext = fixture.context;
}, LIVE_TIMEOUT_MS);

afterAll(async () => {
  homeDirectory?.mockRestore();
  if (!ENABLED) return;
  const leftovers = await removeLabelledResources(
    (args: string[]) => docker(args),
    [`label=${RUN_LABEL}`],
  );
  if (dataDir) await fs.rm(path.dirname(dataDir), { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 180_000);

describe("bridge credential on a real container", () => {
  live(
    "every bridge starts from the root-only credential with only a verifier",
    async () => {
      for (const bridge of BRIDGES) {
        const result = (await invoke(`start_${bridge.kind}_server`, { containerId })) as {
          hostPort: number;
          wasRunning: boolean;
          authToken: string;
        };
        expect(result.wasRunning).toBe(false);
        expect(result.authToken).toMatch(/^okb_[A-Za-z0-9_-]{43}$/);
        started.set(bridge.kind, result);
        // The token is where the backend reads it back, with its authority key beside it.
        expect(await readContainerBridgeToken(containerId, bridge.kind)).toBe(result.authToken);
        // And the socket the bridge listens on is recorded as its own (#2030).
        expect(await asRoot(`cat ${containerListenerRecordFile(bridge.kind)}`)).toMatch(
          /^\d+:[0-9a-f]+$/,
        );
        expect(
          await asRoot(`test -s ${containerAuthorityKeyFile(bridge.kind)} && echo present`),
        ).toBe("present");
      }
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a process as the agent's uid cannot read the credential anywhere",
    async () => {
      for (const bridge of BRIDGES) {
        const { authToken } = started.get(bridge.kind)!;
        // The bridge, not the wrapper shell that pipes its log: the launcher
        // runs bun by its root-owned path, never through the agent's PATH.
        const pid = await asAgent(
          `pgrep -f '^/usr/local/bin/bun --config=/dev/null --no-env-file /opt/${bridge.process}' | head -n 1`,
        );
        expect(pid).toMatch(/^\d+$/);
        // The file, its directory, and the old location.
        expect(
          await asAgent(
            `cat ${containerCredentialFile(bridge.kind)} 2>&1 || true; ls /run/orkestrator-bridge 2>&1 || true`,
          ),
        ).toContain("Permission denied");
        expect(
          await asAgent(`test -e ${CONTAINER_TOKEN_FILES[bridge.kind]} && echo present || true`),
        ).toBe("");
        // The bridge process itself: its environment, its memory and its descriptors.
        for (const file of ["environ", "mem"]) {
          expect(await asAgent(`head -c 16 /proc/${pid}/${file} 2>&1 || true`)).toContain(
            "Permission denied",
          );
        }
        expect(await asAgent(`ls /proc/${pid}/fd 2>&1 || true`)).toContain("Permission denied");
        // Everything the agent's uid can reach. The pattern comes from stdin and a
        // shell builtin, so it is in no process's argv while this looks.
        const scan = `IFS= read -r pattern
        grep -rlFf <(printf '%s\\n' "$pattern") /tmp /home/node /workspace /run/orkestrator /opt 2>/dev/null
        for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do tr '\\0' ' ' < "$f" 2>/dev/null; echo; done | grep -cFf <(printf '%s\\n' "$pattern") || true`;
        const found = (await asAgent(scan, `${authToken}\n`)).split("\n");
        expect(found.filter((line) => line && line !== "0")).toEqual([]);
        // Nor the private half of the authority key, which only root and the backend hold.
        const privateKey = await asRoot(`cat ${containerAuthorityKeyFile(bridge.kind)}`);
        expect(privateKey.length).toBeGreaterThan(40);
        const keyFound = (await asAgent(scan, `${privateKey}\n`)).split("\n");
        expect(keyFound.filter((line) => line && line !== "0")).toEqual([]);
        // The same scan does find what the agent can read: the wrapper's verifier.
        const control = await asAgent(scan, `${bridgeTokenVerifier(authToken)}\n`);
        expect(Number(control.split("\n").at(-1))).toBeGreaterThan(0);
      }
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "an approval can't be answered with what the agent can read, nor with the token alone",
    async () => {
      for (const bridge of BRIDGES) {
        const { hostPort, authToken } = started.get(bridge.kind)!;
        const verifier = bridgeTokenVerifier(authToken);
        expect(await statusFromAgent(bridge.port, bridge.answer, verifier)).toBe("401");
        expect(await statusFromAgent(bridge.port, bridge.answer, "")).toBe("401");
        // The token without the backend's signature: what an imposter catches.
        const unsigned = await fetch(`http://127.0.0.1:${hostPort}${bridge.answer}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${authToken}`,
            "x-orkestrator-claude-token": authToken,
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(unsigned.status).toBe(403);
        expect(await unsigned.json()).toMatchObject({ code: BRIDGE_AUTHORITY_REFUSED_CODE });
        // The backend's call reaches the route: no such request, but not refused.
        const response = await backendFetch(bridge.kind, started.get(bridge.kind)!, bridge.answer, {
          method: "POST",
          body: "{}",
        });
        expect([401, 403]).not.toContain(response.status);
        await response.body?.cancel();
        // A read needs no signature.
        const read = await backendFetch(
          bridge.kind,
          started.get(bridge.kind)!,
          "/global/auth-check",
        );
        expect(read.status).toBe(200);
        await read.body?.cancel();
      }
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "the agents a launched bridge spawns get the start script's environment, and no credential",
    async () => {
      // Codex's bridge starts app-server at once; the child is the agent's, so readable.
      const pid = await asAgent(`pgrep -f '[c]odex app-server' | head -n 1`);
      expect(pid).toMatch(/^\d+$/);
      const environ = (await asAgent(`tr '\\0' '\\n' < /proc/${pid}/environ`)).split("\n");
      const names = environ.map((line) => line.split("=", 1)[0]);
      // Values the node start script exported reach the agent.
      expect(names).toContain(CODEX_MAX_CONCURRENT_THREADS_ENV);
      expect(names).toContain("ORKESTRATOR_VERSION");
      expect(environ.find((line) => line.startsWith("PATH="))).toContain("/home/node");
      // What only the launcher gave the bridge does not.
      for (const name of [
        "CODEX_BRIDGE_TOKEN",
        "CODEX_BRIDGE_TOKEN_SHA256",
        bridgeAuthorityKeyEnv("CODEX_BRIDGE_TOKEN"),
        "ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT",
        "ORKESTRATOR_BRIDGE_LAUNCH_KEYS",
      ]) {
        expect(names).not.toContain(name);
      }
      // The snapshot was read once and removed.
      expect(await asAgent("ls /tmp/.orkestrator-bridge-env-* 2>/dev/null | wc -l")).toBe("0");
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a token an imposter on the bridge's port catches answers nothing",
    async () => {
      const bridge = BRIDGES.find((entry) => entry.kind === "pi")!;
      const real = started.get("pi")!;
      // What the agent can read before it strikes: the wrapper's arguments
      // carry the verifier and the public key, neither of them secret.
      const wrapper = await asAgent(`pgrep -af '[o]rkestrator-bridge /tmp/pi-bridge.log'`);
      const verifierLine = `PI_BRIDGE_TOKEN_SHA256=${bridgeTokenVerifier(real.authToken)}`;
      expect(wrapper).toContain(verifierLine);
      const publicKeyLine = wrapper
        .split(" ")
        .find((word) => word.startsWith(`${bridgeAuthorityKeyEnv(bridge.tokenEnv)}=`))!;
      expect(publicKeyLine).toBeTruthy();

      // Kill the bridge (same uid) and listen on its port.
      await asAgent(`cat > /tmp/imposter.js <<'IMPOSTER'
Bun.serve({ hostname: "0.0.0.0", port: ${bridge.port}, fetch(request) {
  require("node:fs").appendFileSync("/tmp/caught", (request.headers.get("authorization") ?? "") + "\\n");
  return Response.json({ activity: "idle", sessions: [] });
} });
IMPOSTER
      pkill -f '[p]i-bridge/dist/index.js' || true
      for i in $(seq 1 50); do curl -s -m 1 -o /dev/null http://127.0.0.1:${bridge.port}/ || break; sleep 0.1; done
      setsid bun /tmp/imposter.js > /tmp/imposter.log 2>&1 < /dev/null &`);
      // The backend's next request, as the activity sweep makes it, gives up the token.
      let caught = "";
      for (let attempt = 0; attempt < 50 && !caught; attempt += 1) {
        await backendFetch("pi", real, "/session/none/activity").then(
          (response) => response.body?.cancel(),
          () => undefined,
        );
        caught = await asAgent("tail -n 1 /tmp/caught 2>/dev/null || true");
        if (!caught) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(caught).toBe(`Bearer ${real.authToken}`);
      // The backend no longer hands the token out: the port's socket is not
      // the one it recorded for the bridge it started.
      expect(await readContainerBridgeToken(containerId, "pi")).toBeNull();

      // The strongest next move: a real bridge from the same verifier and key,
      // started through the launcher itself, which the backend still trusts.
      await asAgent(`pkill -f '[i]mposter.js' || true
      for i in $(seq 1 50); do curl -s -m 1 -o /dev/null http://127.0.0.1:${bridge.port}/ || break; sleep 0.1; done
      snapshot=/tmp/.orkestrator-bridge-env-pi-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n')
      CWD=/workspace PI_AGENT_DIR=/home/node/.pi/agent PI_SESSION_DIR=/home/node/.pi/agent/sessions \\
        PI_BRIDGE_STATE_DIR=/tmp/orkestrator-pi-state env -0 > "$snapshot"
      printf '%s\\n%s\\nPORT=${bridge.port}\\nHOSTNAME=0.0.0.0\\n' '${verifierLine}' '${publicKeyLine}' |
        /usr/local/bin/orkestrator-bridge-launch pi "$snapshot"`);
      let healthy = false;
      for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        healthy = await backendFetch("pi", real, "/global/auth-check").then(
          (response) => response.ok,
          () => false,
        );
      }
      expect(healthy).toBe(true);

      // The caught token opens it, and changes nothing that needs authority.
      const ask = {
        id: "interactive-container",
        sandbox: "provider",
        approvals: "ask",
        projectResources: false,
        networkAccess: "restricted",
      };
      for (const route of [bridge.answer, "/session/create"]) {
        const refused = await fetch(`http://127.0.0.1:${real.hostPort}${route}`, {
          method: "POST",
          headers: { authorization: caught, "content-type": "application/json" },
          body: JSON.stringify({ clientSessionKey: "imposter", policy: ask }),
        });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ code: BRIDGE_AUTHORITY_REFUSED_CODE });
      }
      // A signature the backend made is good once, even replayed by the agent.
      const body = JSON.stringify({ clientSessionKey: "backend", policy: ask });
      const url = `http://127.0.0.1:${real.hostPort}/session/create`;
      const signed = bridgeAuthorityHeaders(real.authToken, "POST", url, body);
      const send = () =>
        fetch(url, {
          method: "POST",
          headers: { authorization: caught, "content-type": "application/json", ...signed },
          body,
        });
      expect((await send()).status).toBe(201);
      const replayed = await send();
      expect(replayed.status).toBe(403);
      expect(await replayed.json()).toMatchObject({ reason: "replayed" });

      // The backend tells the two apart (#2030): this bridge's socket is
      // not the one recorded for the bridge it started, so its token is not
      // handed out, and the next start replaces the agent's bridge with a new
      // token the agent never saw.
      expect(await readContainerBridgeToken(containerId, "pi")).toBeNull();
      const replaced = (await invoke("start_pi_server", { containerId })) as {
        hostPort: number;
        wasRunning: boolean;
        authToken: string;
      };
      expect(replaced.wasRunning).toBe(false);
      expect(replaced.authToken).not.toBe(real.authToken);
      expect(await readContainerBridgeToken(containerId, "pi")).toBe(replaced.authToken);
      // The caught token opens nothing now.
      const stale = await fetch(`http://127.0.0.1:${replaced.hostPort}/global/auth-check`, {
        headers: { authorization: caught },
      });
      expect(stale.status).toBe(401);
      await stale.body?.cancel();
      await invoke("stop_pi_server", { containerId });
      await asAgent("rm -f /tmp/caught /tmp/imposter.js /tmp/imposter.log");
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "what the agent plants in its login shell does not run inside the next bridge",
    async () => {
      // A login profile is read by every \`bash -lc\` exec, the start script's included.
      await asAgent(`cp ~/.bash_profile /tmp/bash_profile.saved 2>/dev/null || touch /tmp/bash_profile.none
      printf 'require("node:fs").appendFileSync("/tmp/planted-login", process.argv.join(" ") + "\\\\n");\\n' > /tmp/planted-login.js
      cat >> ~/.bash_profile <<'PLANT'
export BUN_OPTIONS="--preload /tmp/planted-login.js"
bun() { printf 'fn:%s\\n' "$*" >> /tmp/planted-login; command bun "$@"; }
PLANT`);
      try {
        // The plant works: a bun the agent's login shell starts runs it.
        await asAgent(`bash -lc 'bun -e 0'`);
        expect(await asAgent("cat /tmp/planted-login")).toContain("fn:-e 0");
        await asAgent("rm -f /tmp/planted-login");

        await invoke("stop_pi_server", { containerId });
        const restarted = (await invoke("start_pi_server", { containerId })) as {
          wasRunning: boolean;
          authToken: string;
        };
        expect(restarted.wasRunning).toBe(false);
        const planted = await asAgent("cat /tmp/planted-login 2>/dev/null || true");
        expect(planted).not.toContain("pi-bridge/dist/index.js");
        // And the bridge is the backend's: signed requests work, the token alone does not.
        const bridge = { hostPort: started.get("pi")!.hostPort, authToken: restarted.authToken };
        const body = JSON.stringify({ clientSessionKey: "after-plant" });
        const signed = await backendFetch("pi", bridge, "/session/create", {
          method: "POST",
          body,
        });
        expect(signed.status).toBe(201);
        await signed.body?.cancel();
        const unsigned = await fetch(`http://127.0.0.1:${bridge.hostPort}/session/create`, {
          method: "POST",
          headers: { authorization: `Bearer ${bridge.authToken}` },
          body,
        });
        expect(unsigned.status).toBe(403);
        await unsigned.body?.cancel();
      } finally {
        await asAgent(`if [ -f /tmp/bash_profile.saved ]; then mv /tmp/bash_profile.saved ~/.bash_profile; else rm -f ~/.bash_profile /tmp/bash_profile.none; fi
        rm -f /tmp/planted-login /tmp/planted-login.js`);
        await invoke("stop_pi_server", { containerId });
      }
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "the agent can't plant code for the next bridge through the checkout or /opt",
    async () => {
      expect(await asAgent("touch /opt/pi-bridge/dist/index.js 2>&1 || true")).toContain(
        "Permission denied",
      );
      await asAgent(
        `printf 'require("node:fs").writeFileSync("/tmp/planted", "ran");\\n' > /workspace/planted.js
       printf 'preload = ["./planted.js"]\\n' > /workspace/bunfig.toml`,
      );
      await invoke("stop_pi_server", { containerId });
      expect(
        await docker([
          "exec",
          "--user",
          "root",
          containerId,
          "sh",
          "-c",
          `test -e ${containerCredentialFile("pi")} && echo present || true`,
        ]),
      ).toBe("");
      const restarted = (await invoke("start_pi_server", { containerId })) as {
        wasRunning: boolean;
        authToken: string;
      };
      expect(restarted.wasRunning).toBe(false);
      expect(restarted.authToken).not.toBe(started.get("pi")!.authToken);
      expect(await asAgent("test -e /tmp/planted && echo ran || true")).toBe("");
      await asAgent("rm -f /workspace/planted.js /workspace/bunfig.toml");
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a user's wider policy is refused on a live session, and taken after a backend restart",
    async () => {
      const ask = {
        id: "interactive-container",
        sandbox: "provider",
        approvals: "ask",
        projectResources: false,
        networkAccess: "restricted",
      };
      const wider = { ...ask, approvals: "auto-approve", sandbox: "none" };
      const create = (bridge: { hostPort: number; authToken: string }, policy: unknown) =>
        backendFetch("pi", bridge, "/session/create", {
          method: "POST",
          body: JSON.stringify({ clientSessionKey: "widening", policy }),
        });
      const before = (await invoke("start_pi_server", { containerId })) as {
        hostPort: number;
        authToken: string;
      };
      expect((await create(before, ask)).status).toBe(201);

      const refused = await create(before, wider);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "policy-widening-refused" });

      // What the backend does on that refusal, on the real bridge and token store.
      await invoke("stop_pi_server", { containerId });
      const after = (await invoke("start_pi_server", { containerId })) as {
        hostPort: number;
        authToken: string;
      };
      expect(after.authToken).not.toBe(before.authToken);
      expect((await create(after, wider)).status).toBe(201);
      await invoke("stop_pi_server", { containerId });
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a bridge an older backend started, with an unprefixed token, keeps working",
    async () => {
      await invoke("stop_pi_server", { containerId });
      // What an older backend leaves: a plain token in the environment and in /tmp.
      const unprefixed = "L".repeat(43);
      await asAgent(
        `read -r token; printf '%s' "$token" > ${CONTAINER_TOKEN_FILES.pi}
       cd /workspace
       PI_BRIDGE_TOKEN="$token" PORT=4101 HOSTNAME=0.0.0.0 CWD=/workspace \\
         PI_AGENT_DIR=/home/node/.pi/agent PI_SESSION_DIR=/home/node/.pi/agent/sessions \\
         PI_BRIDGE_STATE_DIR=/tmp/orkestrator-pi-state \\
         setsid bun /opt/pi-bridge/dist/index.js > /tmp/pi-bridge.log 2>&1 < /dev/null &`,
        `${unprefixed}\n`,
      );
      let result: { wasRunning: boolean; authToken: string } | undefined;
      for (let attempt = 0; attempt < 60 && !result?.wasRunning; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const hostPort = started.get("pi")!.hostPort;
        const health = await fetch(`http://127.0.0.1:${hostPort}/global/health`, {
          headers: { authorization: `Bearer ${unprefixed}` },
        }).catch(() => null);
        if (health?.ok) {
          result = (await invoke("start_pi_server", { containerId })) as {
            wasRunning: boolean;
            authToken: string;
          };
        }
      }
      expect(result).toMatchObject({ wasRunning: true, authToken: unprefixed });
      await invoke("stop_pi_server", { containerId });
    },
    LIVE_TIMEOUT_MS,
  );
});

/**
 * The image a container is already on may predate all of this. Opt in with
 * ORKESTRATOR_QUALIFICATION_OLDER_IMAGE naming one without `bridge-credential`.
 */
const OLDER_IMAGE = process.env.ORKESTRATOR_QUALIFICATION_OLDER_IMAGE?.trim() ?? "";
const liveOnOlderImage = ENABLED && OLDER_IMAGE ? test : test.skip;

liveOnOlderImage(
  "an older image's bridge still starts, authenticates and is found again",
  async () => {
    const { id, invoke: invokeOlder } = await startFixture(OLDER_IMAGE, "older");
    const result = (await invokeOlder("start_pi_server", { containerId: id })) as {
      hostPort: number;
      wasRunning: boolean;
      authToken: string;
    };
    expect(result.wasRunning).toBe(false);
    // Its bridge takes any token, so a prefixed one works; the file holds it.
    expect(result.authToken).toMatch(/^okb_/);
    const auth = await fetch(`http://127.0.0.1:${result.hostPort}/global/auth-check`, {
      headers: { authorization: `Bearer ${result.authToken}` },
    });
    expect(auth.status).toBe(200);
    expect(await readContainerBridgeToken(id, "pi")).toBe(result.authToken);
    const again = (await invokeOlder("start_pi_server", { containerId: id })) as {
      wasRunning: boolean;
      authToken: string;
    };
    expect(again).toMatchObject({ wasRunning: true, authToken: result.authToken });
    await invokeOlder("stop_pi_server", { containerId: id });
  },
  LIVE_TIMEOUT_MS,
);

live(
  "Claude catalogue discovery alone starts a verifier bridge on capable images",
  async () => {
    await invoke("stop_claude_server", { containerId });
    await invoke("get_claude_model_catalog", {
      environmentId: `env-${RUN}-capable`,
      forceRefresh: true,
    });
    const token = await readContainerBridgeToken(containerId, "claude");
    expect(token).toMatch(/^okb_[A-Za-z0-9_-]{43}$/);
    expect(await asAgent(`test ! -e ${CONTAINER_TOKEN_FILES.claude} && printf absent`)).toBe(
      "absent",
    );
    expect(
      await asAgent(`test ! -r ${containerCredentialFile("claude")} && printf unreadable`),
    ).toBe("unreadable");
  },
  LIVE_TIMEOUT_MS,
);

/** Plugins in every place node can write that a 2.x server would read. */
const PLANT_OPENCODE2_PLUGINS = `set -e
plugin() { mkdir -p "$1"; printf 'import { writeFileSync } from "node:fs";\\nexport default { id: "%s", async setup() { writeFileSync("/tmp/planted2-marker-%s", "1"); } };\\n' "$2" "$2" > "$1/index.ts"; }
plugin ~/.config/opencode/plugins/p-global global-dir
plugin ~/.config/orkestrator-opencode2/plugins/p-old-config old-config-dir
plugin ~/.opencode/plugins/p-home home-dir
plugin /workspace/.opencode/plugins/p-project project-dir
printf '{"plugins":["file:///tmp/p.ts"],"plugin":["opencode-planted"],"agent":{"probe":{"description":"kept","prompt":"{file:./AGENTS.md}"}}}' > /workspace/opencode.json
rm -f /workspace/AGENTS.md
ln -s /proc/self/environ /workspace/AGENTS.md
# node's own path to OpenCode 2, which the server no longer starts from.
rm -f ~/.opencode/bin/opencode2
printf '#!/bin/sh\\ntouch /tmp/planted2-marker-binary\\nexec /opt/opencode/bin/opencode2 "$@"\\n' > ~/.opencode/bin/opencode2
chmod 755 ~/.opencode/bin/opencode2
rm -f /tmp/planted2-marker-*`;

describe("OpenCode 2 and the package caches on an opencode2-launch image", () => {
  /** The inode of the socket listening on the 2.x port, from /proc/net/tcp. */
  const listeningInode = () =>
    asAgent(
      `awk 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == ":1006" { print $10 }' /proc/net/tcp /proc/net/tcp6`,
    );

  live(
    "the 2.x server runs root's binary and configuration, and its socket is recorded",
    async () => {
      await asAgent(PLANT_OPENCODE2_PLUGINS);
      const first = await startContainerOpenCode2Server(fixtureContext, containerId);
      expect(first.wasRunning).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await asAgent("ls /tmp | grep '^planted2-marker-' || true")).toBe("");
      const pids = (await asAgent("pgrep -f '[o]pencode2 serve' || true"))
        .split("\n")
        .filter(Boolean);
      expect(pids).toHaveLength(1);
      expect(await asAgent(`tr '\\0' ' ' < /proc/${pids[0]}/cmdline`)).toBe(
        `/opt/opencode/bin/opencode2 serve --port ${OPENCODE2_SERVER_PORT} --hostname 0.0.0.0`,
      );
      // Non-dumpable once warmed: its environment is closed to the agent's uid.
      expect(await asAgent(`head -c 16 /proc/${pids[0]}/environ 2>&1 || true`)).toContain(
        "Permission denied",
      );
      expect(await asRoot("stat -c '%u %a' /opt/opencode/bin/opencode2")).toBe("0 755");
      expect(
        await asAgent(
          `for path in /opt/opencode/bin/opencode2 /run/orkestrator-opencode2/opencode /run/orkestrator-opencode2/opencode/plugins /run/orkestrator-opencode2/home /run/orkestrator-opencode2/cache /run/orkestrator-opencode2/project; do
            if [ -w "$path" ]; then echo "writable $path"; fi
          done`,
        ),
      ).toBe("");
      expect(await asRoot("ls /run/orkestrator-opencode2/opencode/plugins | sort")).toBe(
        "orkestrator-credential\norkestrator-github-env",
      );
      // The checkout's configuration as root filtered it: no plugin keys, the
      // reference to a link out of the checkout inlined as the agent's own read.
      const project = await asRoot("cat /run/orkestrator-opencode2/project/opencode.json");
      expect(project).not.toContain("plugin");
      expect(project).toContain('"description": "kept"');
      expect(project).not.toContain(first.connection.password);
      expect(await asRoot("cat /run/orkestrator-bridge/opencode2-listener")).toBe(
        await listeningInode(),
      );
      expect(await readContainerBridgeToken(containerId, "opencode2")).toBe(
        first.connection.password,
      );
      const again = await startContainerOpenCode2Server(fixtureContext, containerId);
      expect(again).toMatchObject({ wasRunning: true });
      expect(again.connection.password).toBe(first.connection.password);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a listener the agent puts on the 2.x port gets no password and is replaced",
    async () => {
      const current = await startContainerOpenCode2Server(fixtureContext, containerId);
      await asAgent(`cat > /tmp/imposter2.js <<'IMPOSTER'
import { appendFileSync } from "node:fs";
Bun.serve({
  hostname: "0.0.0.0",
  port: ${OPENCODE2_SERVER_PORT},
  fetch(request) {
    appendFileSync("/tmp/imposter2-seen", (request.headers.get("authorization") ?? "none") + "\\n");
    return Response.json({ version: "2.2.6" });
  },
});
IMPOSTER
      rm -f /tmp/imposter2-seen
      pkill -f '[o]pencode2 serve' || true
      for i in $(seq 1 50); do curl -s -o /dev/null -m 1 http://127.0.0.1:${OPENCODE2_SERVER_PORT}/ || break; sleep 0.2; done
      setsid bun --config=/dev/null /tmp/imposter2.js > /tmp/imposter2.log 2>&1 < /dev/null &
      for i in $(seq 1 100); do curl -s -o /dev/null -m 1 http://127.0.0.1:${OPENCODE2_SERVER_PORT}/ && break; sleep 0.2; done`);
      expect(await readContainerBridgeToken(containerId, "opencode2")).toBeNull();
      const replaced = await startContainerOpenCode2Server(fixtureContext, containerId);
      expect(replaced.wasRunning).toBe(false);
      expect(replaced.connection.password).not.toBe(current.connection.password);
      expect(await asAgent("pgrep -f '[i]mposter2.js' || true")).toBe("");
      expect(await asAgent("grep -c Basic /tmp/imposter2-seen 2>/dev/null || true")).toBe("0");
    },
    LIVE_TIMEOUT_MS,
  );
});
