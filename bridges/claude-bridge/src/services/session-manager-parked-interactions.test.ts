import { describe, expect, jest, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import { coordinatorProcessPolicy } from "./read-only-policy.js";
import {
  answerQuestion,
  captureEvents,
  createSession,
  deleteSession,
  getPendingInteractions,
  getPendingQuestions,
  getSession,
  getSessionActivity,
  nextQueryCall,
  mockGetMcpServerNames,
  mockGetMcpServersForSdk,
  respondToInteraction,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";

const ASK_POLICY: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "ask",
  projectResources: true,
  networkAccess: "full",
};
const DENY_POLICY: NativeAgentExecutionPolicy = { ...ASK_POLICY, approvals: "deny" };

function context(requestId: string, extra: Record<string, unknown> = {}) {
  return { signal: new AbortController().signal, requestId, ...extra } as never;
}

/**
 * MCP elicitations are parked for the user rather than declined. Unset, the
 * callback left them unanswered until the CLI's own deadline — which the user
 * saw as the tab freezing for minutes with nothing to explain it.
 */
describe("MCP elicitations", () => {
  test("parks a form elicitation and returns the user's answer", async () => {
    const session = createSession("elicitation-form");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    const result = call.options.onElicitation!(
      {
        serverName: "linear",
        message: "Which team?",
        mode: "form",
        requestedSchema: { type: "object", properties: { team: { type: "string" } } },
      },
      { signal: new AbortController().signal, requestId: "r1" },
    );
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    expect(getPendingInteractions(session.id)[0]).toMatchObject({
      id: "r1",
      kind: "mcp-form",
      serverName: "linear",
      message: "Which team?",
      schema: { type: "object", properties: { team: { type: "string" } } },
    });
    // Blocked on the user, not on Claude.
    expect(await getSessionActivity(session.id)).toBe("waiting");

    expect(respondToInteraction("r1", { action: "accept", content: { team: "core" } })).toBe(true);
    expect(await result).toEqual({ action: "accept", content: { team: "core" } });
    expect(getPendingInteractions(session.id)).toEqual([]);
    expect(respondToInteraction("r1", { action: "decline" })).toBe(false);

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("parks a url elicitation with its link, and a decline reaches the server", async () => {
    const session = createSession("elicitation-url");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    const result = call.options.onElicitation!(
      {
        serverName: "linear",
        message: "Authorize",
        mode: "url",
        url: "https://linear.app/oauth",
        elicitationId: "e1",
      },
      { signal: new AbortController().signal, requestId: "r2" },
    );
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    expect(getPendingInteractions(session.id)[0]).toMatchObject({
      kind: "mcp-url",
      url: "https://linear.app/oauth",
      elicitationId: "e1",
    });

    respondToInteraction("r2", { action: "decline" });
    expect(await result).toEqual({ action: "decline" });

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("an unanswered elicitation is cancelled after five minutes", async () => {
    const session = createSession("elicitation-timeout");
    track(session.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    jest.useFakeTimers();
    try {
      const result = call.options.onElicitation!(
        { serverName: "linear", message: "Which team?", mode: "form" },
        { signal: new AbortController().signal, requestId: "r3" },
      );
      expect(getPendingInteractions(session.id)).toHaveLength(1);

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(await result).toEqual({ action: "cancel" });
      expect(call.options.abortController!.signal.aborted).toBe(false);
      expect(getPendingInteractions(session.id)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "interaction.resolved",
        sessionId: session.id,
        data: { requestId: "r3", action: "timeout" },
      }),
    );
    stop();
  });

  test("the CLI withdrawing the request cancels it and removes the card", async () => {
    const session = createSession("elicitation-withdrawn");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    const controller = new AbortController();
    const result = call.options.onElicitation!(
      { serverName: "linear", message: "Which team?", mode: "form" },
      { signal: controller.signal, requestId: "r4" },
    );
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    controller.abort();
    expect(await result).toEqual({ action: "cancel" });
    expect(call.options.abortController!.signal.aborted).toBe(false);
    expect(getPendingInteractions(session.id)).toEqual([]);

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("deleting the session cancels a parked elicitation", async () => {
    const session = createSession("elicitation-session-deleted");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "go").catch(() => undefined);
    const call = await nextQueryCall();

    const result = call.options.onElicitation!(
      { serverName: "linear", message: "Which team?", mode: "form" },
      { signal: new AbortController().signal, requestId: "r5" },
    );
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    deleteSession(session.id);
    expect(await result).toEqual({ action: "cancel" });
    expect(getPendingInteractions(session.id)).toEqual([]);

    call.finish();
    await promptPromise;
  });

  test("a url elicitation without a link is declined with a row naming the server", async () => {
    const session = createSession("elicitation-no-url");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    expect(
      await call.options.onElicitation!(
        { serverName: "linear", message: "Authorize", mode: "url" },
        { signal: new AbortController().signal, requestId: "r6" },
      ),
    ).toEqual({ action: "decline" });
    expect(getPendingInteractions(session.id)).toEqual([]);
    const notice = getSession(session.id)!.messages.at(-1)!.parts[0]!;
    expect(notice).toMatchObject({ type: "status", severity: "warning" });
    expect(notice.content).toContain("linear");

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("cancels a host dialog rather than leaving it to the CLI deadline", async () => {
    const session = createSession("user-dialog");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    // `cancelled` makes the CLI apply the dialog's own default. This host
    // declares no `supportedDialogKinds`, so it can render none of them.
    expect(call.options.supportedDialogKinds).toBeUndefined();
    expect(
      await call.options.onUserDialog!(
        { dialogKind: "something", payload: {} },
        { signal: new AbortController().signal, requestId: "r7" },
      ),
    ).toEqual({ behavior: "cancelled" });

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("asks for question previews as Markdown, never HTML", async () => {
    const session = createSession("question-previews");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    expect(call.options.toolConfig).toEqual({ askUserQuestion: { previewFormat: "markdown" } });

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });
});

/**
 * An `ask` policy used to never ask: the backend sends `bypassPermissions`
 * with every build prompt, the allow list pre-approved Bash and the file
 * tools, and `canUseTool` allowed whatever still reached it.
 */
describe("tool approvals under an ask policy", () => {
  test("caps the prompt's bypassPermissions and pre-approves only reading tools", async () => {
    const session = createSession("ask-launch");
    track(session.id);
    session.executionPolicy = ASK_POLICY;
    const promptPromise = sendPrompt(session.id, "go", { permissionMode: "bypassPermissions" });
    const call = await nextQueryCall();

    expect(call.options.permissionMode).toBe("default");
    expect(call.options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(call.options.allowedTools).toContain("Read");
    for (const tool of ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]) {
      expect(call.options.allowedTools).not.toContain(tool);
    }

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("keeps a narrower mode the prompt asks for", async () => {
    const session = createSession("ask-plan");
    track(session.id);
    session.executionPolicy = ASK_POLICY;
    const promptPromise = sendPrompt(session.id, "plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    expect(call.options.permissionMode).toBe("plan");

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("parks a Bash call as a command approval and runs it once approved", async () => {
    const session = createSession("ask-command");
    track(session.id);
    session.executionPolicy = ASK_POLICY;
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    const decision = call.options.canUseTool!(
      "Bash",
      { command: "git push" },
      context("req-1", { toolUseID: "tu-1", title: "Claude wants to run git push" }),
    );
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    expect(getPendingInteractions(session.id)[0]).toMatchObject({
      id: "req-1",
      kind: "command-approval",
      toolName: "Bash",
      toolUseId: "tu-1",
      command: "git push",
      title: "Claude wants to run git push",
    });

    respondToInteraction("req-1", { action: "accept" });
    // Allow once: no SDK suggestions, so nothing durable is saved.
    expect(await decision).toEqual({ behavior: "allow", updatedInput: { command: "git push" } });

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("parks a file edit as a file approval, and a decline denies it", async () => {
    const session = createSession("ask-file");
    track(session.id);
    session.executionPolicy = ASK_POLICY;
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    const decision = call.options.canUseTool!(
      "Edit",
      { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
      context("req-2"),
    );
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    expect(getPendingInteractions(session.id)[0]).toMatchObject({
      kind: "file-approval",
      paths: ["/repo/a.ts"],
    });

    respondToInteraction("req-2", { action: "decline" });
    expect(await decision).toEqual({
      behavior: "deny",
      message: "The user denied this tool call.",
    });

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("parks any other tool as a permission, and cancel also stops the turn", async () => {
    const session = createSession("ask-permission");
    track(session.id);
    session.executionPolicy = ASK_POLICY;
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    const decision = call.options.canUseTool!(
      "mcp__linear__create_issue",
      { title: "Bug" },
      context("req-3", { mcpServer: { name: "linear", source: "user" } }),
    );
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    expect(getPendingInteractions(session.id)[0]).toMatchObject({
      kind: "permission",
      toolName: "mcp__linear__create_issue",
      mcpServer: "linear",
      input: '{"title":"Bug"}',
    });

    respondToInteraction("req-3", { action: "cancel" });
    expect(await decision).toMatchObject({ behavior: "deny", interrupt: true });

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("marks exact requests rule-eligible and forwards a Bash suggestion only as a hint", async () => {
    const session = createSession("ask-rule-eligible");
    track(session.id);
    session.executionPolicy = ASK_POLICY;
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();
    const suggestions = [
      {
        type: "addRules",
        behavior: "allow",
        destination: "localSettings",
        rules: [{ toolName: "Bash", ruleContent: "npm run test:*" }],
      },
    ];

    const decisions = [
      call.options.canUseTool!(
        "Bash",
        { command: "npm run test -- --watch" },
        context("req-r1", { suggestions }),
      ),
      call.options.canUseTool!("Edit", { file_path: "relative.ts" }, context("req-r2")),
      call.options.canUseTool!(
        "mcp__linear__create_issue",
        { title: "Bug" },
        context("req-r3", { mcpServer: { name: "linear", source: "user" } }),
      ),
      call.options.canUseTool!(
        "WebFetch",
        { url: "https://Docs.Example.com/page", prompt: "summarise" },
        context("req-r4"),
      ),
      call.options.canUseTool!("Bash", { command: "x".repeat(40_000) }, context("req-r5")),
    ];
    decisions.push(
      call.options.canUseTool!(
        "Bash",
        { command: "npm test", dangerouslyDisableSandbox: true },
        context("req-r6"),
      ),
      call.options.canUseTool!(
        "Bash",
        { command: "npm test", unknownApprovalFlag: true },
        context("req-r7"),
      ),
    );
    await waitFor(() => getPendingInteractions(session.id).length === 7);
    const pending = new Map(getPendingInteractions(session.id).map((entry) => [entry.id, entry]));
    expect(pending.get("req-r1")).toMatchObject({
      ruleEligible: true,
      proposedCommandPrefix: ["npm", "run", "test"],
    });
    // A relative path cannot be placed in the workspace.
    expect(pending.get("req-r2")).not.toHaveProperty("ruleEligible");
    expect(pending.get("req-r3")).toMatchObject({ ruleEligible: true, mcpServer: "linear" });
    expect(pending.get("req-r4")).toMatchObject({
      ruleEligible: true,
      networkHost: "docs.example.com",
    });
    // A truncated command is never matched.
    expect(pending.get("req-r5")).not.toHaveProperty("ruleEligible");

    expect(pending.get("req-r6")).not.toHaveProperty("ruleEligible");
    expect(pending.get("req-r7")).not.toHaveProperty("ruleEligible");
    for (const id of ["req-r1", "req-r2", "req-r3", "req-r4", "req-r5", "req-r6", "req-r7"]) {
      respondToInteraction(id, { action: "accept" });
    }
    // Allow once, even where the SDK suggested a rule.
    expect(await decisions[0]).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm run test -- --watch" },
    });
    await Promise.all(decisions);

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("denies an unanswered approval after five minutes", async () => {
    const session = createSession("ask-timeout");
    track(session.id);
    session.executionPolicy = ASK_POLICY;
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    jest.useFakeTimers();
    try {
      const decision = call.options.canUseTool!("Bash", { command: "ls" }, context("req-4"));
      await Promise.resolve();
      expect(getPendingInteractions(session.id)).toHaveLength(1);

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(await decision).toEqual({
        behavior: "deny",
        message: "Approval timed out after 5 minutes",
      });
      expect(getPendingInteractions(session.id)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("without an ask policy a tool that reaches the callback still runs", async () => {
    const session = createSession("no-ask");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    expect(
      await call.options.canUseTool!("NotebookEdit", { notebook_path: "/x.ipynb" }, context("r")),
    ).toEqual({ behavior: "allow", updatedInput: { notebook_path: "/x.ipynb" } });
    expect(getPendingInteractions(session.id)).toEqual([]);

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });
});

/**
 * A `deny` policy used to refuse nothing, for the same reason: the backend's
 * `bypassPermissions` replaced the policy's own mode. It runs in `default`,
 * not `dontAsk`, because the CLI refuses AskUserQuestion outright in `dontAsk`.
 */
describe("a deny policy", () => {
  test("caps the prompt's bypassPermissions at default", async () => {
    const session = createSession("deny-launch");
    track(session.id);
    session.executionPolicy = DENY_POLICY;
    const promptPromise = sendPrompt(session.id, "go", { permissionMode: "bypassPermissions" });
    const call = await nextQueryCall();

    expect(call.options.permissionMode).toBe("default");
    expect(call.options.allowDangerouslySkipPermissions).toBeUndefined();

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("refuses a tool that reaches the callback but still asks the user questions", async () => {
    const session = createSession("deny-callback");
    track(session.id);
    session.executionPolicy = DENY_POLICY;
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    expect(
      await call.options.canUseTool!("mcp__linear__create_issue", { title: "Bug" }, context("d1")),
    ).toEqual({
      behavior: "deny",
      message: "mcp__linear__create_issue is not allowed: this session's policy denies approvals.",
    });
    expect(getPendingInteractions(session.id)).toEqual([]);
    expect(
      await call.options.canUseTool!(
        "mcp__orkestrator__submit_fix_result",
        {},
        context("no-server"),
      ),
    ).toMatchObject({ behavior: "deny" });

    const question = call.options.canUseTool!(
      "AskUserQuestion",
      { questions: [{ question: "Which branch?", header: "Branch", options: [] }] },
      context("d2"),
    );
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    answerQuestion("d2", { "Which branch?": "main" });
    expect(await question).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which branch?": "main" } },
    });

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("a coordinator build prompt runs in default with its read-only allow list", async () => {
    const session = createSession("coordinator-deny");
    track(session.id);
    session.executionPolicy = coordinatorProcessPolicy();
    const promptPromise = sendPrompt(session.id, "delegate", {
      permissionMode: "bypassPermissions",
    });
    const call = await nextQueryCall();

    expect(call.options.permissionMode).toBe("default");
    expect(call.options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(call.options.allowedTools).toEqual(
      expect.arrayContaining(["Read", "Grep", "Bash", "Agent", "AskUserQuestion"]),
    );
    expect(
      await call.options.canUseTool!("WebSearch", { query: "x" }, context("c1")),
    ).toMatchObject({ behavior: "deny" });

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("keeps a read-only turn's dontAsk", async () => {
    const session = createSession("deny-read-only");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "look", {
      readOnly: true,
      permissionMode: "dontAsk",
    });
    const call = await nextQueryCall();

    expect(call.options.permissionMode).toBe("dontAsk");

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });
});

test("a read-only reviewer turn may report provisional findings", async () => {
  mockGetMcpServerNames.mockImplementationOnce(async () => new Set(["orkestrator"]));
  mockGetMcpServersForSdk.mockImplementationOnce(async () => ({
    orkestrator: { type: "http", url: "http://localhost/mcp" },
  }));
  const session = createSession("workflow-read-only-finding");
  track(session.id);
  session.executionPolicy = DENY_POLICY;
  const prompt = sendPrompt(session.id, "review", { readOnly: true, permissionMode: "dontAsk" });
  const call = await nextQueryCall();
  const tool = "mcp__orkestrator__report_finding";
  expect(
    await call.options.canUseTool!(tool, { resultKey: "key" }, context("report_finding")),
  ).toMatchObject({ behavior: "allow" });
  // Anything else that reaches the callback in a read-only turn is still refused.
  expect(
    await call.options.canUseTool!("Write", { file_path: "a.ts" }, context("Write")),
  ).toMatchObject({ behavior: "deny" });
  expect(getPendingInteractions(session.id)).toHaveLength(0);
  call.push({ type: "result", subtype: "success" });
  call.finish();
  await prompt;
});

for (const policy of [ASK_POLICY, DENY_POLICY]) {
  test(`${policy.approvals} allows injected workflow results without parking`, async () => {
    mockGetMcpServerNames.mockImplementationOnce(async () => new Set(["orkestrator"]));
    mockGetMcpServersForSdk.mockImplementationOnce(async () => ({
      orkestrator: { type: "http", url: "http://localhost/mcp" },
    }));
    const session = createSession(`workflow-${policy.approvals}`);
    track(session.id);
    session.executionPolicy = policy;
    const prompt = sendPrompt(session.id, "build", { permissionMode: "bypassPermissions" });
    const call = await nextQueryCall();
    for (const name of [
      "submit_review_report",
      "submit_fix_result",
      "validate_workflow_result",
      "get_workflow_result_status",
      "report_finding",
    ]) {
      const tool = `mcp__orkestrator__${name}`;
      expect(call.options.allowedTools).toContain(tool);
      expect(
        await call.options.canUseTool!(tool, { resultKey: "key" }, context(name)),
      ).toMatchObject({ behavior: "allow" });
    }
    expect(getPendingInteractions(session.id)).toHaveLength(0);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });
}

test("declines unsupported arrays and oversized UTF-8 schemas with a visible notice", async () => {
  const session = createSession("unsupported-schema");
  track(session.id);
  const prompt = sendPrompt(session.id, "go");
  const call = await nextQueryCall();
  for (const schema of [
    {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    },
    { type: "object", properties: { team: { type: "string", description: "界".repeat(6000) } } },
  ]) {
    expect(
      await call.options.onElicitation!(
        { serverName: "linear", message: "Input", mode: "form", requestedSchema: schema } as never,
        { signal: new AbortController().signal, requestId: "invalid" },
      ),
    ).toEqual({ action: "decline" });
    expect(getPendingInteractions(session.id)).toHaveLength(0);
    expect(getSession(session.id)!.messages.at(-1)!.parts[0]).toMatchObject({
      type: "status",
      severity: "warning",
      content: expect.stringContaining("linear"),
    });
  }
  call.push({ type: "result", subtype: "success" });
  call.finish();
  await prompt;
});

test("retained background approvals and elicitations report waiting with a free composer", async () => {
  const session = createSession("background-interaction");
  track(session.id);
  session.executionPolicy = ASK_POLICY;
  const prompt = sendPrompt(session.id, "go");
  const call = await nextQueryCall();
  call.push({
    type: "system",
    subtype: "task_started",
    task_id: "bg",
    description: "Background task",
    is_backgrounded: true,
  });
  call.push({ type: "result", subtype: "success" });
  await waitFor(
    () => session.status === "idle" && session.backgroundTasks?.bg?.status === "running",
  );
  expect(await getSessionActivity(session.id)).toBe("working");
  for (const kind of ["tool", "form"]) {
    const result =
      kind === "tool"
        ? call.options.canUseTool!("Bash", { command: "ls" }, context(kind))
        : call.options.onElicitation!(
            { serverName: "linear", message: "Input", mode: "form" },
            { signal: new AbortController().signal, requestId: kind },
          );
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    expect(session.status).toBe("idle");
    expect(await getSessionActivity(session.id)).toBe("waiting");
    // Authoritative reads remain available with no mounted subscriber.
    expect(getPendingInteractions(session.id)[0]!.id).toBe(kind);
    respondToInteraction(kind, { action: "decline" });
    await result;
    expect(await getSessionActivity(session.id)).toBe("working");
  }
  call.finish();
  await prompt;
});

test("injected artifact tools auto-allow under deny approvals without parking", async () => {
  mockGetMcpServerNames.mockImplementationOnce(async () => new Set(["orkestrator-artifacts"]));
  mockGetMcpServersForSdk.mockImplementationOnce(async () => ({
    "orkestrator-artifacts": { type: "http", url: "http://localhost/mcp" },
  }));
  const session = createSession("artifact-tools-deny");
  track(session.id);
  session.executionPolicy = DENY_POLICY;
  const prompt = sendPrompt(session.id, "build", { permissionMode: "dontAsk" });
  const call = await nextQueryCall();
  for (const name of [
    "create_artifact",
    "preview_artifact",
    "publish_artifact",
    "get_artifact_operation",
  ]) {
    const tool = `mcp__orkestrator-artifacts__${name}`;
    expect(
      await call.options.canUseTool!(tool, { requestKey: "test" }, context(name)),
    ).toMatchObject({ behavior: "allow" });
  }
  expect(getPendingInteractions(session.id)).toHaveLength(0);
  call.push({ type: "result", subtype: "success" });
  call.finish();
  await prompt;
});
