/**
 * A read-only turn where Codex's command sandbox cannot run (an environment's
 * container): it runs without the sandbox under `untrusted`, every approval it
 * asks for is declined at once, and `/session/:id/status` says so until the
 * next turn. `codex-read-only-sandbox.test.ts` covers the decision itself.
 */
import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import { harness, type Harness } from "./app-server-runtime-test-harness.js";
import { CODEX_READ_ONLY_APPROVAL_REFUSAL } from "./codex-read-only-sandbox.js";

const REASON = "Codex's command sandbox cannot run commands in this container.";

const containerPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

function sandboxOffInContainer() {
  return harness(
    {},
    {
      readOnlyCommandSandboxOff: (config) =>
        config.policy?.sandbox === "container" ? REASON : undefined,
    },
  );
}

function turnStarts(h: Harness) {
  return h.child().requests.filter((request) => request.method === "turn/start");
}

async function completeTurn(h: Harness, turnId: string) {
  h.child().notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: turnId, status: "completed" },
  });
  await h.drain();
}

describe("read-only turn without Codex's command sandbox", () => {
  test("runs unsandboxed under untrusted, with the read-only policy and no network", async () => {
    const h = await sandboxOffInContainer();
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });

    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "Review the package",
        requestId: "review-1",
        attachments: [],
        readOnly: true,
      }),
    ).toMatchObject({ ok: true });

    const thread = h.child().requests.find((request) => request.method === "thread/start")!;
    expect(thread.params.sandbox).toBe("danger-full-access");
    expect(thread.params.approvalPolicy).toBe("untrusted");
    const turn = turnStarts(h)[0]!;
    expect(turn.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turn.params.approvalPolicy).toBe("untrusted");
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toEqual({
      state: "off",
      reason: REASON,
    });
  });

  test("declines an approval at once instead of parking it for a person", async () => {
    const h = await sandboxOffInContainer();
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    await h.drain();

    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9101,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        command: "rm -rf build",
        cwd: "/tmp/ws",
      },
    });
    await h.drain();

    expect(h.child().stdin.lines.join("")).toContain('"decision":"decline"');
    expect(h.events.some((event) => event.type === "session.approval-requested")).toBe(false);
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
    expect(JSON.stringify(h.events)).toContain(CODEX_READ_ONLY_APPROVAL_REFUSAL);
  });

  test("the next ordinary turn restores the session's own settings and approvals", async () => {
    const h = await sandboxOffInContainer();
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    await completeTurn(h, "turn-1");

    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "Fix the findings",
        requestId: "fix-1",
        attachments: [],
      }),
    ).toMatchObject({ ok: true });

    const fix = turnStarts(h).at(-1)!;
    expect(fix.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(fix.params.approvalPolicy).toBe("never");
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toBeUndefined();

    // An approval in the ordinary turn is offered to the tab as usual.
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9102,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        itemId: "item-2",
        startedAtMs: 1,
        command: "touch allowed",
        cwd: "/tmp/ws",
      },
    });
    await h.drain();
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(1);
  });

  test("where the sandbox can run, a read-only turn keeps it", async () => {
    const h = await harness({}, { readOnlyCommandSandboxOff: () => undefined });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });

    const turn = turnStarts(h)[0]!;
    expect(turn.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(turn.params.approvalPolicy).toBe("never");
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toBeUndefined();
  });
});
