/**
 * Narrow-only execution policy (H4) against a scripted app-server: a thread that
 * is really attached, a config that really yields, and a restart that really
 * reloads the bridge's store. `session-policy-narrowing-routes.test.ts` covers
 * what the routes answer.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { PolicyWideningRefusedError } from "@orkestrator/protocol/execution-policy-narrowing";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import { harness, type Harness, threadPayload } from "./app-server-runtime-test-harness.js";

// Full network, so the scripted app-server need not confirm a web search mode.
const askPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "provider",
  approvals: "ask",
  projectResources: false,
  networkAccess: "full",
};
const widerPolicy: NativeAgentExecutionPolicy = { ...askPolicy, approvals: "auto-approve" };
const narrowerPolicy: NativeAgentExecutionPolicy = { ...askPolicy, approvals: "deny" };

async function attachedSession(h: Harness, policy: NativeAgentExecutionPolicy): Promise<string> {
  const { sessionId } = h.runtime.createSession({ mode: "build", policy });
  expect(
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "first", attachments: [] }),
  ).toMatchObject({ ok: true });
  h.child().notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  await h.drain();
  return sessionId;
}

const resumable = { "thread/resume": () => ({ thread: threadPayload("thread-1") }) };

describe("resume onto an attached thread", () => {
  test("refuses a wider policy before touching the thread", async () => {
    const h = await harness(resumable);
    const sessionId = await attachedSession(h, askPolicy);
    const sessions = h.runtime.getRegistry().listSessions().length;

    await expect(
      h.runtime.resumeSession({ threadId: "thread-1", mode: "build", policy: widerPolicy }),
    ).rejects.toBeInstanceOf(PolicyWideningRefusedError);

    expect(h.child().requests.some((request) => request.method === "thread/resume")).toBe(false);
    expect(h.runtime.getRegistry().listSessions()).toHaveLength(sessions);
    expect(h.runtime.getStatus(sessionId)?.policy).toEqual(askPolicy);
  });

  test.each([
    ["narrower", narrowerPolicy],
    ["equal", askPolicy],
  ] as const)("a %s policy gets its own session on the thread", async (_label, policy) => {
    const h = await harness(resumable);
    const sessionId = await attachedSession(h, askPolicy);

    const resumed = await h.runtime.resumeSession({ threadId: "thread-1", mode: "build", policy });

    expect(h.runtime.getRegistry().getSession(resumed!.sessionId)?.config.policy).toEqual(policy);
    expect(h.runtime.getStatus(sessionId)?.policy).toEqual(askPolicy);
  });
});

describe("POST config while the engine work yields", () => {
  function heldConfigure(h: Harness) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = h.engine.configureThread.bind(h.engine);
    let held = false;
    spyOn(h.engine, "configureThread").mockImplementation(async (...args) => {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return original(...args);
    });
    return { entered, release };
  }

  test("a delayed config cannot restore the policy a newer request narrowed", async () => {
    const h = await harness(resumable);
    const sessionId = await attachedSession(h, askPolicy);
    const { entered, release } = heldConfigure(h);

    const delayed = h.runtime.updateConfig(sessionId, { mode: "build", policy: askPolicy });
    await entered.promise;
    expect(await h.runtime.updateConfig(sessionId, { mode: "build", policy: narrowerPolicy })).toBe(
      "updated",
    );
    release.resolve();

    await expect(delayed).rejects.toBeInstanceOf(PolicyWideningRefusedError);
    expect(h.runtime.getStatus(sessionId)?.policy).toEqual(narrowerPolicy);
  });

  test("a delayed config with no policy cannot either", async () => {
    const h = await harness(resumable);
    const sessionId = await attachedSession(h, askPolicy);
    const { entered, release } = heldConfigure(h);

    const delayed = h.runtime.updateConfig(sessionId, { mode: "build", fastMode: true });
    await entered.promise;
    expect(await h.runtime.updateConfig(sessionId, { mode: "build", policy: narrowerPolicy })).toBe(
      "updated",
    );
    release.resolve();

    expect(await delayed).toBe("running");
    expect(h.runtime.getStatus(sessionId)?.policy).toEqual(narrowerPolicy);
  });
});

describe("a bridge restart", () => {
  test("restored sessions take the backend's policy once, and a prompt makes theirs live", async () => {
    const before = await harness(resumable);
    const sessionId = await attachedSession(before, askPolicy);
    await before.runtime.stop();

    const taken = await harness(resumable);
    const session = taken.runtime.getRegistry().getSession(sessionId)!;
    expect(session.config.policy).toEqual(askPolicy);
    expect(session.policyPending).toBe(true);

    expect(
      await taken.runtime.updateConfig(sessionId, { mode: "build", policy: widerPolicy }),
    ).toBe("updated");
    expect(session.config.policy).toEqual(widerPolicy);
    await expect(
      taken.runtime.updateConfig(sessionId, {
        mode: "build",
        policy: { ...widerPolicy, projectResources: true },
      }),
    ).rejects.toBeInstanceOf(PolicyWideningRefusedError);
    expect(session.config.policy).toEqual(widerPolicy);
    await taken.runtime.stop();

    const prompted = await harness(resumable);
    const restored = prompted.runtime.getRegistry().getSession(sessionId)!;
    expect(restored.policyPending).toBe(true);
    await prompted.runtime.prompt(sessionId, {
      prompt: "next",
      requestId: "next",
      attachments: [],
    });
    expect(restored.policyPending).toBe(false);
    await expect(
      prompted.runtime.updateConfig(sessionId, {
        mode: "build",
        policy: { ...widerPolicy, projectResources: true },
      }),
    ).rejects.toBeInstanceOf(PolicyWideningRefusedError);
  });
});

test("resume rechecks a sibling narrowed during engine resume and restores engine config", async () => {
  const h = await harness(resumable);
  const sessionId = await attachedSession(h, askPolicy);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = h.engine.resumeThread.bind(h.engine);
  let held = false;
  spyOn(h.engine, "resumeThread").mockImplementation(async (...args) => {
    if (!held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return original(...args);
  });
  const restore = spyOn(h.engine, "configureThread");
  const count = h.runtime.getRegistry().listSessions().length;
  const pending = h.runtime.resumeSession({ threadId: "thread-1", policy: askPolicy });
  const refused = pending.then(
    () => null,
    (error) => error,
  );
  await entered.promise;
  try {
    expect(await h.runtime.updateConfig(sessionId, { mode: "build", policy: narrowerPolicy })).toBe(
      "updated",
    );
  } finally {
    release.resolve();
  }
  expect(await refused).toBeInstanceOf(PolicyWideningRefusedError);
  expect(h.runtime.getRegistry().listSessions()).toHaveLength(count);
  expect(restore.mock.calls.at(-1)?.[1].policy).toEqual(narrowerPolicy);
});

test("policy-free resume refuses incompatible sibling inheritance", async () => {
  const h = await harness(resumable);
  await attachedSession(h, askPolicy);
  await h.runtime.resumeSession({ threadId: "thread-1", policy: narrowerPolicy });
  await expect(h.runtime.resumeSession({ threadId: "thread-1" })).rejects.toBeInstanceOf(
    PolicyWideningRefusedError,
  );
});

test("duplicate prompts leave the restored policy pending", async () => {
  const h = await harness(resumable);
  const sessionId = await attachedSession(h, askPolicy);
  const session = h.runtime.getRegistry().getSession(sessionId)!;
  session.policyPending = true;
  expect(
    await h.runtime.prompt(sessionId, { prompt: "duplicate", requestId: "first", attachments: [] }),
  ).toMatchObject({ ok: true });
  expect(session.policyPending).toBe(true);
  expect(await h.runtime.updateConfig(sessionId, { mode: "build", policy: widerPolicy })).toBe(
    "updated",
  );
});

test("journal-blocked prompts leave the restored policy pending", async () => {
  const h = await harness(resumable);
  const { sessionId } = h.runtime.createSession({ policy: askPolicy });
  const session = h.runtime.getRegistry().getSession(sessionId)!;
  session.policyPending = true;
  const classify = spyOn(h.runtime.getJournal(), "classify").mockReturnValue({
    action: "blocked",
    reason: "test blocked journal",
  });
  expect(
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "blocked", attachments: [] }),
  ).toMatchObject({ ok: false, status: 503 });
  expect(session.policyPending).toBe(true);
  classify.mockRestore();
  expect(await h.runtime.updateConfig(sessionId, { mode: "build", policy: widerPolicy })).toBe(
    "updated",
  );
});
