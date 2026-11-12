/**
 * A read-only turn where Codex's command sandbox cannot run (an environment's
 * container): it runs without the sandbox under `untrusted`, the bridge's
 * exec-policy rules are in place before its thread starts, every approval it
 * asks for is declined at once, and `/session/:id/status` says so until the
 * next turn. `codex-read-only-sandbox.test.ts` covers the decision itself and
 * `codex-read-only-exec-rules.test.ts` the rules file.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import {
  codexHome,
  deferredSignal,
  harness,
  type Harness,
  threadPayload,
} from "./app-server-runtime-test-harness.js";
import {
  CODEX_READ_ONLY_RULES_FILENAME,
  codexReadOnlyExecRules,
  ensureCodexReadOnlyExecRules,
} from "./codex-read-only-exec-rules.js";
import {
  CODEX_READ_ONLY_APPROVAL_REFUSAL,
  CODEX_READ_ONLY_MCP_APPROVAL_REFUSAL,
} from "./codex-read-only-sandbox.js";

const REASON = "Codex's command sandbox cannot run commands in this container.";

const containerPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

const sandboxOffFor = (config: { policy?: NativeAgentExecutionPolicy }) =>
  config.policy?.sandbox === "container" ? REASON : undefined;

function sandboxOffInContainer(
  handlers: Parameters<typeof harness>[0] = {},
  options: Parameters<typeof harness>[1] = {},
) {
  return harness(handlers, { readOnlyCommandSandboxOff: sandboxOffFor, ...options });
}

function overloaded(): Error {
  const error = new Error("ingress queue full");
  (error as { rpcCode?: number }).rpcCode = -32001;
  return error;
}

/** Asks for approval of a command the way app-server does; the request id is unique per call. */
function requestCommandApproval(h: Harness, id: number, turnId: string) {
  h.child().stdout.pushMessage({
    jsonrpc: "2.0",
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId,
      itemId: `item-${id}`,
      startedAtMs: 1,
      command: "rm -rf build",
      cwd: "/tmp/ws",
    },
  });
}

function answerTo(h: Harness, id: number): string | undefined {
  return h
    .child()
    .stdin.lines.join("")
    .split("\n")
    .find((line) => line.includes(`"id":${id}`) && !line.includes('"method"'));
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

  // The pinned Codex asks under `untrusted` for every command no exec-policy
  // rule allows, so without the rules every read was declined and a reviewer
  // read nothing. Codex reads the rules when a thread starts or resumes.
  test("puts the read-only exec-policy rules in place before its thread starts", async () => {
    const rulesPath = () => join(codexHome, "rules", CODEX_READ_ONLY_RULES_FILENAME);
    const threadStartsAtWrite: number[] = [];
    let h: Harness | undefined;
    h = await sandboxOffInContainer(
      {},
      {
        ensureReadOnlyExecRules: async () => {
          threadStartsAtWrite.push(
            h!.child().requests.filter((request) => request.method === "thread/start").length,
          );
          await ensureCodexReadOnlyExecRules(codexHome);
        },
      },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });

    expect(threadStartsAtWrite).toEqual([0]);
    expect(readFileSync(rulesPath(), "utf8")).toBe(codexReadOnlyExecRules());
    expect(turnStarts(h)).toHaveLength(1);
  });

  test("by default writes the rules into its CODEX_HOME, and never for other turns", async () => {
    const rulesPath = join(codexHome, "rules", CODEX_READ_ONLY_RULES_FILENAME);
    const sandboxed = await harness({}, { readOnlyCommandSandboxOff: () => undefined });
    const ordinary = sandboxed.runtime.createSession({ mode: "build", policy: containerPolicy });
    await sandboxed.runtime.prompt(ordinary.sessionId, {
      prompt: "Build it",
      requestId: "build-1",
      attachments: [],
    });
    await sandboxed.runtime.prompt(ordinary.sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    expect(existsSync(rulesPath)).toBe(false);

    const h = await sandboxOffInContainer();
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    expect(readFileSync(rulesPath, "utf8")).toBe(codexReadOnlyExecRules());
  });

  test("a rules file it cannot write costs the reads, not the boundary", async () => {
    const outputs: LogOutput[] = [];
    configureLogger({ sink: (output) => void outputs.push(output) });
    try {
      const h = await sandboxOffInContainer(
        {},
        {
          ensureReadOnlyExecRules: () => Promise.reject(new Error("read-only file system")),
        },
      );
      const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
      expect(
        await h.runtime.prompt(sessionId, {
          prompt: "Review the package",
          requestId: "review-1",
          attachments: [],
          readOnly: true,
        }),
      ).toMatchObject({ ok: true });
      await h.drain();
      expect(outputs.map((output) => output.record?.event)).toContain(
        "read-only-rules.write-failed",
      );
      expect(turnStarts(h)[0]!.params.approvalPolicy).toBe("untrusted");

      requestCommandApproval(h, 9050, "turn-1");
      await h.drain();
      expect(answerTo(h, 9050)).toContain('"decision":"decline"');
      expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
    } finally {
      resetLogger();
    }
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

  // Under `untrusted` Codex runs without asking only what an exec-policy rule
  // allows (the bridge's `orkestrator-read-only.rules`), so an approval is a
  // command outside those rules, read or not (`git diff`, `sed -n`, a `cat`
  // behind a redirection): the bridge declines it whatever it looks like, and
  // never approves one itself.
  test("declines every command approval, whatever the command, without offering it", async () => {
    const h = await sandboxOffInContainer();
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    await h.drain();

    const reads = [
      "/bin/bash -lc 'cat review-package.json'",
      "/bin/bash -lc 'git diff origin/main...HEAD | head -200'",
      "/bin/bash -lc \"sed -n '1,80p' src/app.ts\"",
    ];
    reads.forEach((command, index) =>
      h.child().stdout.pushMessage({
        jsonrpc: "2.0",
        id: 9200 + index,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: `item-${index}`,
          startedAtMs: 1,
          command,
          cwd: "/tmp/ws",
        },
      }),
    );
    await h.drain();

    for (const index of reads.keys()) {
      expect(answerTo(h, 9200 + index)).toContain('"decision":"decline"');
      expect(answerTo(h, 9200 + index)).not.toContain('"accept');
    }
    expect(h.events.some((event) => event.type === "session.approval-requested")).toBe(false);
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
    expect(JSON.stringify(h.events)).toContain(CODEX_READ_ONLY_APPROVAL_REFUSAL);
  });

  test("declines a command that also asks for network access, and input to a running process", async () => {
    const h = await sandboxOffInContainer();
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    await h.drain();

    const base = { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1, cwd: "/tmp/ws" };
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9210,
      method: "item/commandExecution/requestApproval",
      params: {
        ...base,
        itemId: "item-net",
        command: "cat a",
        networkApprovalContext: { host: "example.com", protocol: "https" },
      },
    });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9211,
      method: "item/commandExecution/requestApproval",
      params: { ...base, itemId: "item-stdin", kind: "writeStdin", command: "cat a" },
    });
    await h.drain();

    expect(answerTo(h, 9210)).toContain('"decision":"decline"');
    expect(answerTo(h, 9211)).toContain('"decision":"decline"');
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
  });

  test("declines file-change and permission requests through the thread's own marker", async () => {
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
      id: 9220,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-patch", startedAtMs: 1 },
    });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9221,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-perm",
        startedAtMs: 1,
        permissions: { network: { enabled: true }, fileSystem: { write: ["/tmp/ws"] } },
      },
    });
    await h.drain();

    expect(answerTo(h, 9220)).toContain('"decision":"decline"');
    const permissions = answerTo(h, 9221)!;
    expect(permissions).toContain('"permissions":{}');
    expect(permissions).not.toContain('"network"');
    expect(h.events.some((event) => event.type === "session.approval-requested")).toBe(false);
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
    expect(JSON.stringify(h.events)).toContain(CODEX_READ_ONLY_APPROVAL_REFUSAL);
  });

  test("declines an MCP tool approval at once instead of parking it on a tab", async () => {
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
      id: 9230,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "docs",
        mode: "form",
        message: "Allow docs.search?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "search" },
      },
    });
    await h.drain();

    expect(answerTo(h, 9230)).toContain('"action":"decline"');
    expect(h.events.some((event) => event.type === "session.interaction-requested")).toBe(false);
    expect(JSON.stringify(h.events)).toContain(CODEX_READ_ONLY_MCP_APPROVAL_REFUSAL);
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

  test("declines a legacy approval that names its thread by conversationId", async () => {
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
      id: 9103,
      method: "execCommandApproval",
      params: {
        conversationId: "thread-1",
        callId: "call-1",
        approvalId: null,
        command: ["rm", "-rf", "build"],
        cwd: "/tmp/ws",
        reason: null,
        parsedCmd: [],
      },
    });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9104,
      method: "applyPatchApproval",
      params: {
        conversationId: "thread-1",
        callId: "call-2",
        fileChanges: {},
        reason: null,
        grantRoot: null,
      },
    });
    await h.drain();

    expect(answerTo(h, 9103)).toContain('"denied"');
    expect(answerTo(h, 9104)).toContain('"denied"');
    expect(h.events.some((event) => event.type === "session.approval-requested")).toBe(false);
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
    expect(JSON.stringify(h.events)).toContain(CODEX_READ_ONLY_APPROVAL_REFUSAL);
  });

  test("a retry on a replacement thread still declines approvals", async () => {
    let attempts = 0;
    const h = await sandboxOffInContainer(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) throw overloaded();
          return { turn: { id: "turn-after-restart" } };
        },
      },
      { initialPromptRetryDelayMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    const requestId = "initial-prompt:env-1:tab-read-only-retry";
    const retryableWriteStarted = deferredSignal();
    const allowRetryableWrite = deferredSignal();
    const journal = h.runtime.getJournal();
    const markRetryable = journal.markRetryable.bind(journal);
    journal.markRetryable = async (candidateRequestId) => {
      retryableWriteStarted.resolve();
      await allowRetryableWrite.promise;
      await markRetryable(candidateRequestId);
    };

    const pending = h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId,
      attachments: [],
      readOnly: true,
    });
    await retryableWriteStarted.promise;
    try {
      // The child restarts during the retry delay, so the retry dispatches on
      // a context generation recovery or the retry itself created.
      await h.engine.getSupervisor().restartNow("restart during read-only retry");
    } finally {
      allowRetryableWrite.resolve();
    }
    expect(await pending).toMatchObject({ ok: true, result: { turnId: "turn-after-restart" } });
    expect(h.children).toHaveLength(2);

    const retried = turnStarts(h).at(-1)!;
    expect(retried.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(retried.params.approvalPolicy).toBe("untrusted");

    requestCommandApproval(h, 9105, "turn-after-restart");
    await h.drain();
    expect(answerTo(h, 9105)).toContain('"decision":"decline"');
    expect(h.events.some((event) => event.type === "session.approval-requested")).toBe(false);
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toEqual({
      state: "off",
      reason: REASON,
    });
  });

  test("a dispatch the app-server rejected leaves no sandbox-off status or refusal behind", async () => {
    let reject = true;
    const h = await sandboxOffInContainer({
      "turn/start": () => {
        if (reject) throw overloaded();
        return { turn: { id: "turn-2" } };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });

    // Not an initial-prompt id, so the overload is not retried: a definite
    // non-dispatch.
    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "Review the package",
        requestId: "review-1",
        attachments: [],
        readOnly: true,
      }),
    ).toMatchObject({ ok: false });
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toBeUndefined();

    // A later ordinary turn on the same thread offers its approvals as usual.
    reject = false;
    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "Fix the findings",
        requestId: "fix-1",
        attachments: [],
      }),
    ).toMatchObject({ ok: true });
    requestCommandApproval(h, 9106, "turn-2");
    await h.drain();
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(1);
  });

  test("an ambiguous dispatch that proved never to have run leaves no sandbox-off status", async () => {
    const h = await sandboxOffInContainer({
      "turn/start": () => {
        throw new Error("write failed mid-request");
      },
      // `thread/read` is the authority: no turn carries the request.
      "thread/read": () => ({ thread: threadPayload("thread-1") }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toBeUndefined();
  });

  // A lost turn/start response that `thread/read` proves ran to its end: that
  // turn ran under its own sandbox decision, so the status follows it.
  test("a lost dispatch reconciled as completed reports the read-only turn that ran", async () => {
    const h = await sandboxOffInContainer({
      "turn/start": () => {
        throw new Error("write failed mid-request");
      },
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-review",
              status: "completed",
              items: [{ type: "userMessage", clientId: "review-1" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });

    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toEqual({
      state: "off",
      reason: REASON,
    });
  });

  test("a lost ordinary dispatch reconciled as completed clears the earlier warning", async () => {
    let loseDispatch = false;
    const h = await sandboxOffInContainer({
      "turn/start": () => {
        if (loseDispatch) throw new Error("write failed mid-request");
        return { turn: { id: "turn-1" } };
      },
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-fix",
              status: "completed",
              items: [{ type: "userMessage", clientId: "fix-1" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    await completeTurn(h, "turn-1");
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toBeDefined();

    loseDispatch = true;
    await h.runtime.prompt(sessionId, {
      prompt: "Fix the findings",
      requestId: "fix-1",
      attachments: [],
    });
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toBeUndefined();
  });

  // The thread is started (or reloaded) and the turn dispatched from separate
  // configuration reads; the sandbox decision must not change between them.
  test("decides the sandbox once per dispatch, so thread and turn agree", async () => {
    let decisions = 0;
    const h = await harness(
      {},
      {
        // The first answer only: a policy change that lands while
        // thread/start is in flight would answer differently afterwards.
        readOnlyCommandSandboxOff: () => (++decisions === 1 ? REASON : undefined),
      },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });

    expect(decisions).toBe(1);
    const thread = h.child().requests.find((request) => request.method === "thread/start")!;
    expect(thread.params.sandbox).toBe("danger-full-access");
    expect(thread.params.approvalPolicy).toBe("untrusted");
    const turn = turnStarts(h)[0]!;
    expect(turn.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turn.params.approvalPolicy).toBe("untrusted");
  });

  test("an attached thread started for an ordinary turn is reloaded for a sandbox-off one", async () => {
    const h = await sandboxOffInContainer();
    // Network already denied, so a read-only turn changes nothing else about
    // the thread: only the sandbox decision can force the reload.
    const policy: NativeAgentExecutionPolicy = {
      ...containerPolicy,
      capabilityPolicy: { deny: ["network"] },
    };
    const { sessionId } = h.runtime.createSession({ mode: "build", policy });
    await h.runtime.prompt(sessionId, { prompt: "Prepare", requestId: "prepare", attachments: [] });
    await completeTurn(h, "turn-1");
    const resumes = () =>
      h.child().requests.filter((request) => request.method === "thread/resume");
    const before = resumes().length;

    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });

    expect(resumes().length).toBe(before + 1);
    expect(resumes().at(-1)!.params.sandbox).toBe("danger-full-access");
    expect(resumes().at(-1)!.params.approvalPolicy).toBe("untrusted");
  });

  test("a failed ordinary turn keeps reporting the last read-only turn that ran", async () => {
    let reject = false;
    const h = await sandboxOffInContainer({
      "turn/start": () => {
        if (reject) throw overloaded();
        return { turn: { id: "turn-1" } };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, {
      prompt: "Review the package",
      requestId: "review-1",
      attachments: [],
      readOnly: true,
    });
    await completeTurn(h, "turn-1");

    reject = true;
    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "Fix the findings",
        requestId: "fix-1",
        attachments: [],
      }),
    ).toMatchObject({ ok: false });
    expect(h.runtime.getStatus(sessionId)?.readOnlyCommandSandbox).toEqual({
      state: "off",
      reason: REASON,
    });
  });

  test("a Multi Review result turn keeps its submit tools approved and reloads the thread", async () => {
    const h = await sandboxOffInContainer({
      "mcpServerStatus/list": () => ({
        data: [
          {
            name: "orkestrator",
            runtimeStatus: "connected",
            tools: { submit_review: { name: "submit_review" } },
            toolsError: null,
          },
        ],
        nextCursor: null,
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build", policy: containerPolicy });
    await h.runtime.prompt(sessionId, { prompt: "Prepare", requestId: "prepare", attachments: [] });
    await completeTurn(h, "turn-1");
    const reloadsBefore = h
      .child()
      .requests.filter((request) => request.method === "thread/resume").length;

    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "Submit the review",
        requestId: "review-1",
        attachments: [],
        readOnly: true,
        agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "attempt-secret" },
        workflowResultTool: "submit_review",
      }),
    ).toMatchObject({ ok: true });

    // The thread was reloaded under the turn's own approval policy and
    // sandbox, with the attempt's server approved up front: an `approve`
    // server bypasses `untrusted`, so the submit call needs no approval the
    // refusal would decline.
    const resumes = h.child().requests.filter((request) => request.method === "thread/resume");
    expect(resumes.length).toBeGreaterThan(reloadsBefore);
    const reload = resumes.at(-1)!;
    expect(reload.params.sandbox).toBe("danger-full-access");
    expect(reload.params.approvalPolicy).toBe("untrusted");
    const config = reload.params.config as Record<string, Record<string, unknown>>;
    expect(config["mcp_servers.orkestrator"]?.default_tools_approval_mode).toBe("approve");
    const turn = turnStarts(h).at(-1)!;
    expect(turn.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turn.params.approvalPolicy).toBe("untrusted");
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
