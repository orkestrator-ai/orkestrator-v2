/**
 * Security report H4 on a real container: a process running as the agent's uid
 * cannot get the bridge-control credential, cannot answer an approval without
 * it, and the backend's own calls still work. OpenCode, which has no bridge of
 * ours, is held to the same on a permission a real tool call parked, raised by a
 * fake model inside the container.
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
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { bridgeTokenVerifier } from "@orkestrator/protocol/node/bridge-credential";
import {
  containerCredentialFile,
  CONTAINER_TOKEN_FILES,
  readContainerBridgeToken,
  type ContainerBridgeKind,
} from "../src/core/container-bridge-credential";
import { OPENCODE_SERVER_PORT } from "../src/core/constants";
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
    `127.0.0.1::${OPENCODE_SERVER_PORT}`,
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
  // No host login can reach the container, whatever this machine holds.
  process.env.HOME = home;
  homeDirectory = spyOn(os, "homedir").mockReturnValue(home);
  const fixture = await startFixture(IMAGE, "capable");
  containerId = fixture.id;
  invoke = fixture.invoke;
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
        fetch(`http://127.0.0.1:${bridge.hostPort}/session/create`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bridge.authToken}`,
            "content-type": "application/json",
          },
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

/** What a user's model would ask for, from a port inside the container. */
const FAKE_MODEL_PORT = 4599;
const FAKE_MODEL = `
const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
const stream = (delta, finish_reason) =>
  new Response(
    [
      { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason }] },
    ].map((value) => "data: " + JSON.stringify(value) + "\\n\\n").join("") + "data: [DONE]\\n\\n",
    { headers: { "content-type": "text/event-stream" } },
  );
Bun.serve({
  hostname: "127.0.0.1",
  port: ${FAKE_MODEL_PORT},
  async fetch(request) {
    const { messages } = await request.json();
    const last = messages.at(-1);
    if (last.role === "tool") return stream({ role: "assistant", content: "Done." }, "stop");
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    const command = text.match(/RUN<(.*)>RUN/s)?.[1] ?? "true";
    const args = JSON.stringify({ command, description: "Fixture command" });
    return stream(
      {
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "bash", arguments: args } }],
      },
      "tool_calls",
    );
  },
});
`;

describe("OpenCode's password on a real container", () => {
  let hostPort = 0;
  let authToken = "";
  const client = () =>
    createOpencodeClient({
      baseUrl: `http://127.0.0.1:${hostPort}`,
      directory: "/workspace",
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${authToken}`).toString("base64")}`,
      },
    });
  /** The status of a reply from inside the container, with `password` read from stdin. */
  const replyFromAgent = (requestId: string, password: string) =>
    asAgent(
      `IFS= read -r password
      printf 'user = "opencode:%s"\\n' "$password" | curl -s -o /dev/null -w '%{http_code}' -m 10 -K - -X POST \\
        -H 'content-type: application/json' -d '{"reply":"once"}' \\
        'http://127.0.0.1:${OPENCODE_SERVER_PORT}/permission/${requestId}/reply?directory=/workspace'`,
      `${password}\n`,
    );
  const pendingPermission = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { data } = await client().permission.list();
      if (data?.length) return data[0]!;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("OpenCode never parked a permission");
  };
  /** A prompt the fake model turns into a real bash call, which `ask` then parks. */
  const parkCommand = async (command: string) => {
    const session = await client().session.create({
      permission: [{ permission: "bash", pattern: "*", action: "ask" }],
    });
    expect(session.error).toBeUndefined();
    const prompted = await client().session.promptAsync({
      sessionID: session.data!.id,
      model: { providerID: "fixture", modelID: "fixture" },
      parts: [{ type: "text", text: `RUN<${command}>RUN` }],
    });
    expect(prompted.error).toBeUndefined();
    return pendingPermission();
  };

  live(
    "starts from the root-only file, and only root and the server hold the password",
    async () => {
      await asAgent(
        `mkdir -p ~/.config/opencode
        cat > ~/.config/opencode/opencode.json <<'CONFIG'
${JSON.stringify({
  provider: {
    fixture: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local fixture",
      options: { baseURL: `http://127.0.0.1:${FAKE_MODEL_PORT}/v1`, apiKey: "not-a-key" },
      models: { fixture: { name: "Fixture", limit: { context: 16000, output: 2000 } } },
    },
  },
})}
CONFIG
        cat > /tmp/fake-model.js <<'MODEL'
${FAKE_MODEL}
MODEL
        setsid bun /tmp/fake-model.js > /tmp/fake-model.log 2>&1 < /dev/null &`,
      );
      const result = (await invoke("start_opencode_server", { containerId })) as {
        hostPort: number;
        wasRunning: boolean;
        authToken: string;
      };
      expect(result.wasRunning).toBe(false);
      expect(result.authToken).toMatch(/^okb_[A-Za-z0-9_-]{43}$/);
      hostPort = result.hostPort;
      authToken = result.authToken;
      expect(await readContainerBridgeToken(containerId, "opencode")).toBe(authToken);
      expect(await invoke("get_opencode_server_status", { containerId })).toMatchObject({
        running: true,
        authToken,
      });
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a process as the agent's uid can't read it anywhere",
    async () => {
      // One process: no wrapper shell or log writer outlives the launch holding a copy.
      const pids = (await asAgent(`pgrep -f '[o]pencode serve'`)).split("\n").filter(Boolean);
      expect(pids).toHaveLength(1);
      const pid = pids[0]!;
      expect(
        await asAgent(
          `cat ${containerCredentialFile("opencode")} 2>&1 || true; ls /run/orkestrator-bridge 2>&1 || true`,
        ),
      ).toContain("Permission denied");
      expect(
        await asAgent(`test -e ${CONTAINER_TOKEN_FILES.opencode} && echo present || true`),
      ).toBe("");
      for (const file of ["environ", "mem"]) {
        expect(await asAgent(`head -c 16 /proc/${pid}/${file} 2>&1 || true`)).toContain(
          "Permission denied",
        );
      }
      expect(await asAgent(`ls /proc/${pid}/fd 2>&1 || true`)).toContain("Permission denied");
      const scan = `IFS= read -r pattern
      grep -rlFf <(printf '%s\\n' "$pattern") /tmp /home/node /workspace /run/orkestrator /opt 2>/dev/null
      for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do tr '\\0' ' ' < "$f" 2>/dev/null; echo; done | grep -cFf <(printf '%s\\n' "$pattern") || true`;
      const found = (await asAgent(scan, `${authToken}\n`)).split("\n");
      expect(found.filter((line) => line && line !== "0")).toEqual([]);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a parked permission can't be answered by the agent, and a user's answer runs the tool",
    async () => {
      // A script, because OpenCode asks about outside paths it sees in a command first.
      await asAgent(`cat > /workspace/tool-probe.sh <<'PROBE'
env > /tmp/tool-env
cat /proc/$(pgrep -f '[o]pencode serve' | head -n 1)/environ > /tmp/tool-parent-env 2> /tmp/tool-parent-error
touch /tmp/tool-ran
PROBE`);
      const permission = await parkCommand("sh ./tool-probe.sh");
      expect(permission.permission).toBe("bash");
      // Nothing the agent's uid holds answers it, and the request stays parked.
      expect(await replyFromAgent(permission.id, "")).toBe("401");
      expect(await replyFromAgent(permission.id, bridgeTokenVerifier(authToken))).toBe("401");
      expect(await asAgent("test -e /tmp/tool-ran && echo ran || true")).toBe("");
      expect((await client().permission.list()).data?.map((entry) => entry.id)).toEqual([
        permission.id,
      ]);
      // The call a user's approval makes, through the SDK the backend uses.
      const replied = await client().permission.reply({ requestID: permission.id, reply: "once" });
      expect(replied.error).toBeUndefined();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if ((await asAgent("test -e /tmp/tool-ran && echo ran || true")) === "ran") break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      expect(await asAgent("cat /tmp/tool-ran >/dev/null && echo ran")).toBe("ran");
      // What a tool actually sees: no password, and no way into its parent.
      expect(
        await asAgent("cut -d= -f1 /tmp/tool-env | grep -c '^OPENCODE_SERVER_PASSWORD$' || true"),
      ).toBe("0");
      expect(await asAgent("cat /tmp/tool-parent-error")).toContain("Permission denied");
      expect(await asAgent("wc -c < /tmp/tool-parent-env")).toBe("0");
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a user's denial stops the tool",
    async () => {
      const permission = await parkCommand("touch ./tool-denied");
      const replied = await client().permission.reply({
        requestID: permission.id,
        reply: "reject",
      });
      expect(replied.error).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await asAgent("test -e /workspace/tool-denied && echo ran || true")).toBe("");
      expect((await client().permission.list()).data).toEqual([]);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "stopping forgets the password, and a restart mints one the old one can't open",
    async () => {
      await invoke("stop_opencode_server", { containerId });
      expect(await readContainerBridgeToken(containerId, "opencode")).toBeNull();
      const restarted = (await invoke("start_opencode_server", { containerId })) as {
        wasRunning: boolean;
        authToken: string;
      };
      expect(restarted.wasRunning).toBe(false);
      expect(restarted.authToken).not.toBe(authToken);
      const refused = await client().permission.list();
      expect(refused.response.status).toBe(401);
      await invoke("stop_opencode_server", { containerId });
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

    // OpenCode there keeps the layout it always had.
    const openCode = (await invokeOlder("start_opencode_server", { containerId: id })) as {
      hostPort: number;
      wasRunning: boolean;
      authToken: string;
    };
    expect(openCode.wasRunning).toBe(false);
    expect(await readContainerBridgeToken(id, "opencode")).toBe(openCode.authToken);
    const health = await fetch(`http://127.0.0.1:${openCode.hostPort}/global/health`, {
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${openCode.authToken}`).toString("base64")}`,
      },
    });
    expect(health.status).toBe(200);
    expect(await invokeOlder("start_opencode_server", { containerId: id })).toMatchObject({
      wasRunning: true,
      authToken: openCode.authToken,
    });
    await invokeOlder("stop_opencode_server", { containerId: id });
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
