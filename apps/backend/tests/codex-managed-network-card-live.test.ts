/**
 * The Codex managed-network approval card, end to end on a managed host
 * (to-do 0723 task 7).
 *
 * Codex asks about a host only when the administrator's
 * `/etc/codex/requirements.toml` turns its network proxy on, a file no test
 * may write on a real machine. So this runs only on a disposable container
 * host that has one, and refuses to run anywhere it is missing:
 *
 *   mise run verify:codex:network-card
 *
 * That task writes `[network_proxy] enabled = true` plus
 * `allow_local_binding = true` (so an approved request may reach the
 * loopback probe server) and points `probe-host.example.test` at 127.0.0.1.
 *
 * Everything between Codex and the card is the real code: the pinned
 * `codex app-server` under the real codex-bridge process (spawned as the
 * backend spawns it, with its own `CODEX_HOME`), the backend's
 * `HttpBridgeInteractionAdapter` reading the bridge's approvals the way the
 * app does, and the permission-rule enforcer adding the card's "Approve and
 * remember…" offer from a real rule store. The session's policy is the one
 * `resolveNativeAgentExecutionPolicy` gives a local environment with the
 * execution-policy override named in each test. The projected card is
 * compared with `CODEX_MANAGED_NETWORK_CARD_PRESENTATION`, which
 * `NativeAgentInteractionCard.test.tsx` renders with the real card, so the
 * buttons asserted there are the ones this request gets.
 *
 * The Codex login is a made-up API key and the model is a loopback stand-in
 * (`codex-managed-network-probe-model.ts`), so no login and no credits are
 * involved.
 */
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import type { NativeAgentExecutionPolicyOverride } from "@orkestrator/protocol/native-agent";
import {
  CODEX_MANAGED_NETWORK_CARD_PRESENTATION,
  CODEX_MANAGED_NETWORK_PROBE_HOST,
} from "@orkestrator/protocol/testing/codex-managed-network-card";
import { HttpBridgeInteractionAdapter } from "../src/core/http-bridge/interactions";
import type { Environment, PersistedNativeAgentSession } from "../src/core/models";
import { resolveNativeAgentExecutionPolicy } from "../src/core/native-agent-execution-policy";
import { PermissionRuleEnforcer } from "../src/core/permission-rules/enforcer";
import { StorageService } from "../src/core/storage";

const LIVE = process.env.RUN_LIVE_CODEX_MANAGED_NETWORK_CARD === "1";
const describeLive = LIVE ? describe : describe.skip;

const REPOSITORY = path.resolve(import.meta.dir, "../../..");
const REQUIREMENTS = "/etc/codex/requirements.toml";
/** What the probe server answers; in the tool output only if the request got there. */
const PROBE_BODY = "orkestrator-network-probe-ok";

async function poll<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

interface Stack {
  rulesFiles: () => string[];
  probeHits: () => number;
  /** Each tool output Codex sent the model, as JSON text. */
  toolOutputs: () => string[];
  rawApprovals: () => Promise<Array<Record<string, unknown>>>;
  /** The card the tab would show: the adapter's snapshot after the enforcer. */
  pendingCard: () => Promise<AgentInteractionRequest | undefined>;
  prompt: () => Promise<void>;
  resolve: (
    card: AgentInteractionRequest,
    action: AgentInteractionResolution["action"],
  ) => Promise<string>;
}

/**
 * The real bridge, adapter and enforcer on a throwaway Codex home, under the
 * policy the backend resolves for a local environment with `override`.
 */
async function withStack(
  override: NativeAgentExecutionPolicyOverride,
  body: (stack: Stack) => Promise<void>,
): Promise<void> {
  const codexPath = process.env.CODEX_PROTOCOL_BINARY;
  if (!codexPath) throw new Error("CODEX_PROTOCOL_BINARY must name the pinned codex binary");
  const root = mkdtempSync(path.join(tmpdir(), "ork-network-card-"));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  const rulesDir = path.join(codexHome, "rules");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(workspace, ".git"), { recursive: true });
  writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  // Never a real key: the only server it can reach is the loopback model.
  writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    { mode: 0o600 },
  );
  const children: ChildProcess[] = [];
  const storage = new StorageService(path.join(root, "data"));
  try {
    const model = spawn(
      "bun",
      [
        path.join(import.meta.dir, "codex-managed-network-probe-model.ts"),
        CODEX_MANAGED_NETWORK_PROBE_HOST,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    children.push(model);
    const toolOutputs: unknown[] = [];
    let probeHits = 0;
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: model.stdout! });
      lines.on("line", (line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.baseUrl === "string") resolve(parsed.baseUrl);
        if ("toolOutput" in parsed) toolOutputs.push(parsed.toolOutput);
        if ("probeHit" in parsed) probeHits += 1;
      });
      model.once("exit", () => reject(new Error("the loopback model exited")));
    });
    writeFileSync(
      path.join(codexHome, "config.toml"),
      `openai_base_url = ${JSON.stringify(baseUrl)}\n`,
    );

    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const token = randomBytes(24).toString("base64url");
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      CODEX_PATH: codexPath,
      CODEX_HOME: codexHome,
      CODEX_BRIDGE_STATE_DIR: path.join(root, "bridge-state"),
      CWD: workspace,
      CODEX_BRIDGE_TOKEN: token,
    };
    // The test preload keeps in-process bridges from listening; this one must.
    delete env.CODEX_BRIDGE_NO_SERVER;
    delete env.NODE_ENV;
    children.push(
      spawn("bun", [path.join(REPOSITORY, "bridges/codex-bridge/src/index.ts")], {
        cwd: workspace,
        env,
        stdio: ["ignore", "inherit", "inherit"],
      }),
    );
    const bridgeUrl = `http://127.0.0.1:${port}`;
    const call = async (method: string, route: string, payload?: unknown) => {
      const response = await fetch(bridgeUrl + route, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      return {
        status: response.status,
        json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
      };
    };
    await poll(
      async () =>
        (await call("GET", "/session/list").catch(() => null))?.status === 200 ? true : undefined,
      "the bridge to listen",
    );

    const environment = {
      id: "env-network-card",
      projectId: "project-network-card",
      name: "network-card",
      environmentType: "local",
      worktreePath: workspace,
      networkAccessMode: "full",
    } as unknown as Environment;
    const policy = resolveNativeAgentExecutionPolicy(environment, "interactive-native", override);
    const created = await call("POST", "/session/create", { mode: "build", policy });
    expect(created.status).toBe(201);
    const sessionId = String(created.json?.sessionId);

    const adapter = new HttpBridgeInteractionAdapter(
      "codex",
      { agent: "codex", baseUrl: bridgeUrl, authToken: token },
      fetch,
    );
    await storage.init();
    const enforcer = new PermissionRuleEnforcer({
      store: () => storage.permissionRuleStore(),
      getEnvironment: async () => environment,
      now: () => Date.now(),
    });
    const session = {
      version: 1,
      key: "network-card-session",
      environmentId: environment.id,
      agent: "codex",
      logicalSessionKey: "network-card-tab",
      providerSessionId: sessionId,
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      policy,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as PersistedNativeAgentSession;

    await body({
      rulesFiles: () => (existsSync(rulesDir) ? readdirSync(rulesDir) : []),
      probeHits: () => probeHits,
      toolOutputs: () => toolOutputs.map((output) => JSON.stringify(output)),
      rawApprovals: async () =>
        ((await call("GET", `/session/${sessionId}/approvals`)).json?.approvals ?? []) as Array<
          Record<string, unknown>
        >,
      pendingCard: async () => {
        const snapshot = await adapter.listPendingInteractions(sessionId);
        const applied = await enforcer.apply(session, { interactions: adapter }, snapshot);
        return applied.snapshot.requests[0];
      },
      prompt: async () => {
        const sent = await call("POST", `/session/${sessionId}/prompt`, {
          prompt: "Run the probe.",
          requestId: randomUUID(),
          policy,
        });
        expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300);
      },
      resolve: async (card, action) =>
        (
          await adapter.resolveInteraction(sessionId, card.id, {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            interactionId: card.id,
            sessionId: card.sessionId,
            action,
            // What the card's Approve sends for a request with no questions.
            ...(action === "answer"
              ? {
                  answer: {
                    version: AGENT_INTERACTION_CONTRACT_VERSION,
                    interactionId: card.id,
                    sessionId: card.sessionId,
                    answers: [],
                  },
                }
              : {}),
            resolvedAt: Date.now(),
          } as AgentInteractionResolution)
        ).result,
    });
  } finally {
    for (const child of children) child.kill();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describeLive("Codex managed-network approval card on a managed host", () => {
  test("the host is managed: requirements turn the proxy on and let it reach the probe", () => {
    const requirements = existsSync(REQUIREMENTS) ? readFileSync(REQUIREMENTS, "utf8") : "";
    expect(requirements).toMatch(/\[network_proxy\][^[]*enabled\s*=\s*true/);
    expect(requirements).toMatch(/\[network_proxy\][^[]*allow_local_binding\s*=\s*true/);
  });

  test("with Codex's sandbox on, the card offers plain approval only and saves no Codex rule", async () => {
    // Settings -> Execution policy: provider sandbox, approvals Ask.
    await withStack({ sandbox: "provider", approvals: "ask" }, async (stack) => {
      await stack.prompt();
      const card = await poll(stack.pendingCard, "the network approval card");

      // The bridge forwards the host and no command, and never an amendment.
      const [raw] = await stack.rawApprovals();
      expect(raw?.networkHost).toBe(CODEX_MANAGED_NETWORK_PROBE_HOST);
      expect(raw?.command).toBeUndefined();
      expect(raw).not.toHaveProperty("amendments");
      expect(raw).not.toHaveProperty("proposedNetworkPolicyAmendments");
      // The card the app shows: "Approve network access", enabled, with Approve
      // for session and an Orkestrator rule for the exact host as the only
      // ways to approve beyond once.
      expect(card.kind).toBe("command-approval");
      expect(card.presentation).toEqual(CODEX_MANAGED_NETWORK_CARD_PRESENTATION);

      // Approve: the request goes through and Codex saves nothing.
      expect(await stack.resolve(card, "answer")).toBe("applied");
      await poll(
        async () => (stack.toolOutputs()[0]?.includes(PROBE_BODY) ? true : undefined),
        "the approved request's output",
      );
      expect(stack.probeHits()).toBe(1);
      expect(stack.rulesFiles()).toEqual([]);

      // Nothing was remembered: the same request asks again, and Deny blocks it.
      await stack.prompt();
      const again = await poll(async () => {
        const pending = await stack.pendingCard();
        return pending && pending.id !== card.id ? pending : undefined;
      }, "the second network approval card");
      expect(again.presentation).toEqual(CODEX_MANAGED_NETWORK_CARD_PRESENTATION);
      expect(await stack.resolve(again, "deny")).toBe("applied");
      await poll(
        async () => (stack.toolOutputs().length === 2 ? true : undefined),
        "the denied turn's output",
      );
      expect(stack.toolOutputs()[1]).not.toContain(PROBE_BODY);
      expect(stack.probeHits()).toBe(1);
      expect(stack.rulesFiles()).toEqual([]);
    });
  }, 300_000);

  test("under the host default (no sandbox) Codex skips the managed proxy and asks nothing", async () => {
    // The default host policy plus approvals Ask: Codex runs with full access,
    // where its network proxy does not apply, so the request goes straight out.
    await withStack({ approvals: "ask" }, async (stack) => {
      await stack.prompt();
      await poll(
        async () => (stack.toolOutputs()[0]?.includes(PROBE_BODY) ? true : undefined),
        "the unasked request's output",
      );
      expect(stack.probeHits()).toBe(1);
      expect(await stack.rawApprovals()).toEqual([]);
      expect(stack.rulesFiles()).toEqual([]);
    });
  }, 300_000);
});
