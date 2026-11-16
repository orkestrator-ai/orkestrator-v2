/**
 * A host Codex session on an administrator-managed host (8085 (retired)), through
 * the runtime, the engine and a scripted app-server. Where
 * `/etc/codex/requirements.toml` leaves `danger-full-access` out of
 * `allowed_sandbox_modes`, the host default runs in Codex's workspace-write
 * sandbox instead of being refused every turn, and reports so; where the
 * administrator's network proxy is on, an unsandboxed host session says the
 * proxy does not apply. The decisions themselves are covered by
 * `codex-managed-requirements.test.ts`; the real Codex is proved by
 * `apps/backend/tests/codex-managed-network-card-live.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import { harness, type Harness } from "./app-server-runtime-test-harness.js";
import {
  CODEX_MANAGED_NETWORK_PROXY_NOTE,
  CODEX_MANAGED_WORKSPACE_SANDBOX_NOTE,
} from "./codex-managed-requirements.js";

/** Orkestrator's host default (`resolveNativeAgentExecutionPolicy`). */
const hostDefault: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

/** Shaped as Codex 0.167.0 answered in a disposable container. */
function requirements(fields: Record<string, unknown>) {
  return () => ({
    supportsIndependentSpeedModes: true,
    requirements: { allowedSandboxModes: null, network: null, ...fields },
  });
}

const forbidsFullAccess = requirements({ allowedSandboxModes: ["read-only", "workspace-write"] });
const proxyOn = requirements({ network: { enabled: true, allowLocalBinding: null } });

function requestsOf(h: Harness, method: string) {
  return h.child().requests.filter((request) => request.method === method);
}

async function promptAndComplete(h: Harness, sessionId: string, requestId: string, turn: string) {
  expect(
    await h.runtime.prompt(sessionId, { prompt: "Fix it", requestId, attachments: [] }),
  ).toMatchObject({ ok: true });
  h.child().notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: turn, status: "completed" },
  });
  await h.drain();
}

describe("Codex host session on a managed host", () => {
  test("runs the host default in the workspace-write sandbox where full access is forbidden", async () => {
    const h = await harness({ "configRequirements/read": forbidsFullAccess });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: hostDefault });

    await promptAndComplete(h, sessionId, "turn-a", "turn-1");

    const thread = requestsOf(h, "thread/start")[0]!;
    expect(thread.params.sandbox).toBe("workspace-write");
    const turn = requestsOf(h, "turn/start")[0]!;
    expect(turn.params.sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      networkAccess: true,
    });

    const reported = {
      ...hostDefault,
      sandbox: "provider",
      note: CODEX_MANAGED_WORKSPACE_SANDBOX_NOTE,
    };
    expect(h.runtime.getStatus(sessionId)?.policy).toEqual(reported);
    expect((await h.runtime.getConfig(sessionId))?.policy).toEqual(reported);

    // One read per app-server generation, not per turn.
    await promptAndComplete(h, sessionId, "turn-b", "turn-1");
    expect(requestsOf(h, "turn/start")[1]!.params.sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
    });
    expect(requestsOf(h, "configRequirements/read")).toHaveLength(1);
  });

  test("the policy the backend sent still applies: re-sending it is not a widening", async () => {
    const h = await harness({ "configRequirements/read": forbidsFullAccess });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: hostDefault });
    await promptAndComplete(h, sessionId, "turn-a", "turn-1");
    expect(h.runtime.getStatus(sessionId)?.policy?.sandbox).toBe("provider");

    expect(await h.runtime.updateConfig(sessionId, { policy: hostDefault })).toBe("updated");
  });

  test("a sandbox the administrator allows is left alone and reports no note", async () => {
    const h = await harness({ "configRequirements/read": forbidsFullAccess });
    const provider: NativeAgentExecutionPolicy = { ...hostDefault, sandbox: "provider" };
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: provider });

    await promptAndComplete(h, sessionId, "turn-a", "turn-1");

    expect(requestsOf(h, "thread/start")[0]!.params.sandbox).toBe("workspace-write");
    expect(h.runtime.getStatus(sessionId)?.policy).toEqual(provider);
  });

  test("an unsandboxed host session says the administrator's network proxy does not apply", async () => {
    const h = await harness({ "configRequirements/read": proxyOn });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: hostDefault });

    await promptAndComplete(h, sessionId, "turn-a", "turn-1");

    expect(requestsOf(h, "thread/start")[0]!.params.sandbox).toBe("danger-full-access");
    expect(requestsOf(h, "turn/start")[0]!.params.sandboxPolicy).toEqual({
      type: "dangerFullAccess",
    });
    expect(h.runtime.getStatus(sessionId)?.policy).toEqual({
      ...hostDefault,
      note: CODEX_MANAGED_NETWORK_PROXY_NOTE,
    });
  });

  for (const [name, handlers] of [
    ["a host without requirements", { "configRequirements/read": () => ({ requirements: null }) }],
    // The scripted child answers -32601, as a Codex without the method would.
    ["a Codex that cannot report its requirements", {}],
  ] as const) {
    test(`${name} keeps full access`, async () => {
      const h = await harness(handlers);
      const { sessionId } = h.runtime.createSession({ mode: "build", policy: hostDefault });
      await promptAndComplete(h, sessionId, "turn-a", "turn-1");
      expect(requestsOf(h, "thread/start")[0]!.params.sandbox).toBe("danger-full-access");
      expect(h.runtime.getStatus(sessionId)?.policy).toEqual(hostDefault);
    });
  }

  test("a container session is left to Codex, and asks nothing", async () => {
    const h = await harness({ "configRequirements/read": forbidsFullAccess });
    const container: NativeAgentExecutionPolicy = {
      ...hostDefault,
      id: "interactive-container",
      sandbox: "container",
      projectResources: true,
    };
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: container });

    await promptAndComplete(h, sessionId, "turn-a", "turn-1");

    expect(requestsOf(h, "thread/start")[0]!.params.sandbox).toBe("danger-full-access");
    expect(requestsOf(h, "configRequirements/read")).toHaveLength(0);
    expect(h.runtime.getStatus(sessionId)?.policy).toEqual(container);
  });
});
