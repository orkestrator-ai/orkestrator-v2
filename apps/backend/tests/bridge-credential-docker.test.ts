/**
 * Security report H4 on a real container: a process running as the agent's uid
 * cannot get the bridge-control credential, cannot answer an approval without
 * it, and the backend's own calls still work.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * with `bridge-credential=1`. No credential is delivered (an agent-test context
 * with no sources) and no agent turn runs, so nothing is billed. Tokens reach
 * the container only on stdin, so this suite adds none to any argv.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bridgeTokenVerifier } from "@orkestrator/protocol/node/bridge-credential";
import {
  containerCredentialFile,
  CONTAINER_TOKEN_FILES,
  readContainerBridgeToken,
  type ContainerBridgeKind,
} from "../src/core/container-bridge-credential";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { runCommand } from "../src/core/shell";
import { removeLabelledResources } from "./container-live-cleanup";
import { createCommandFixtures } from "./command-fixtures";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
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
}> = [
  {
    kind: "claude",
    port: 4097,
    process: "claude-bridge/dist/index.js",
    answer: "/session/none/permissions/request",
  },
  {
    kind: "codex",
    port: 4098,
    process: "codex-bridge/dist/index.js",
    answer: "/session/none/approvals/request",
  },
  {
    kind: "cursor",
    port: 4099,
    process: "cursor-bridge/dist/index.js",
    answer: "/session/none/approvals/request",
  },
  {
    kind: "grok",
    port: 4100,
    process: "acp-bridge/dist/index.js",
    answer: "/session/none/approvals/request",
  },
  {
    kind: "pi",
    port: 4101,
    process: "pi-bridge/dist/index.js",
    answer: "/session/none/approvals/request",
  },
];

let dataDir = "";
let home = "";
let containerId = "";
let homeDirectory: ReturnType<typeof spyOn> | undefined;
let invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>;
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

beforeAll(async () => {
  if (!ENABLED) return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-bridge-credential-"));
  dataDir = path.join(root, "data");
  home = path.join(root, "home");
  await fs.mkdir(dataDir);
  await fs.mkdir(home);
  // No host login can reach the container, whatever this machine holds.
  process.env.HOME = home;
  homeDirectory = spyOn(os, "homedir").mockReturnValue(home);
  const owner = dockerOwnerNamespace(dataDir);
  containerId = await docker([
    "run",
    "-d",
    "--name",
    `ork-${RUN}`,
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
    IMAGE,
  ]);
  await waitForContainerBoot(containerId, { timeoutMs: 120_000 });
  const imageId = await docker(["inspect", "--format", "{{.Image}}", containerId]);
  const { createCommandRegistry, createContext, createEnvironment } = await createCommandFixtures();
  const environment = createEnvironment({
    id: `env-${RUN}`,
    environmentType: "containerized",
    containerId,
    status: "running",
    containerLifecycle: {
      schemaVersion: 1,
      revision: 1,
      lastRuntimeGeneration: 1,
      runtime: { containerId, runtimeGeneration: 1, owner, imageId },
      storage: { format: "legacy-layer", workspaceGeneration: 1 },
      outcomes: [],
    },
  });
  const { context } = createContext(environment, { dataDir });
  context.runtimeFlavor = "agent-test";
  context.credentialSources = new Set();
  const commands = createCommandRegistry();
  invoke = async (name, args) => commands.get(name)?.(args, context);
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
        // The token is where the backend reads it back.
        expect(await readContainerBridgeToken(containerId, bridge.kind)).toBe(result.authToken);
      }
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a process as the agent's uid cannot read the credential anywhere",
    async () => {
      for (const bridge of BRIDGES) {
        const { authToken } = started.get(bridge.kind)!;
        // The bridge, not the wrapper shell that pipes its log.
        const pid = await asAgent(`pgrep -f '^bun .*${bridge.process}' | head -n 1`);
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
        // The same scan does find what the agent can read: the wrapper's verifier.
        const control = await asAgent(scan, `${bridgeTokenVerifier(authToken)}\n`);
        expect(Number(control.split("\n").at(-1))).toBeGreaterThan(0);
      }
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "an approval can't be answered with what the agent can read, and can with the token",
    async () => {
      for (const bridge of BRIDGES) {
        const { hostPort, authToken } = started.get(bridge.kind)!;
        const verifier = bridgeTokenVerifier(authToken);
        expect(await statusFromAgent(bridge.port, bridge.answer, verifier)).toBe("401");
        expect(await statusFromAgent(bridge.port, bridge.answer, "")).toBe("401");
        // The backend's call reaches the route: no such request, but not refused.
        const response = await fetch(`http://127.0.0.1:${hostPort}${bridge.answer}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${authToken}`,
            "x-orkestrator-claude-token": authToken,
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(response.status).not.toBe(401);
        await response.body?.cancel();
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
