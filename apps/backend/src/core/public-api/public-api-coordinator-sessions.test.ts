import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  coordinatorRuntimeId,
  type CoordinatorConversation,
} from "@orkestrator/protocol/coordinator";
import {
  encodePublicSessionId,
  type PublicSessionSummary,
} from "@orkestrator/protocol/public-api-resources";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";

/**
 * A Coordinator conversation through the public session actions on the real
 * dispatch journal, native-agent service and storage. It has no environment
 * row and no pane layout, and acting on it must never create either.
 */

afterEach(cleanupSessionHarnesses);

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQDa/0kPAAAAAElFTkSuQmCC";

function conversation(
  coordinatorId: string,
  id: string,
  fields: Partial<CoordinatorConversation> = {},
): CoordinatorConversation {
  const tabId = `coordinator-${id}`;
  return {
    id,
    tabId,
    logicalSessionKey: coordinatorConversationSessionKey(coordinatorId, { id, tabId }),
    agent: "claude",
    title: "Coordinator",
    createdAt: new Date(0).toISOString(),
    mailboxIncarnationId: `incarnation-${id}`,
    role: "main",
    ...fields,
  };
}

async function coordinatorSetup(options: { adopt?: boolean } = {}) {
  const session = await setup();
  const { harness, projectId } = session;
  await harness.storage.updateProject(projectId, { localPath: harness.root });
  const coordinatorId = "coordinator-1";
  await harness.storage.coordinators.mutateCoordinatorWorkspace(projectId, () => ({
    version: COORDINATOR_WORKSPACE_VERSION,
    id: coordinatorId,
    projectId,
    executionPolicy: COORDINATOR_EXECUTION_POLICY,
    lifecycleState: "ready",
    conversations: [
      conversation(coordinatorId, "main"),
      conversation(coordinatorId, "unassigned", { agent: undefined, role: "side", sideOrdinal: 1 }),
      conversation(coordinatorId, "closed", {
        role: "side",
        sideOrdinal: 2,
        closedAt: new Date(0).toISOString(),
      }),
    ],
    selectedConversationId: "main",
    repositoryContextRevision: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
  const environmentId = coordinatorRuntimeId(coordinatorId, "main");
  const tabId = "coordinator-main";
  const sessionId = encodePublicSessionId(environmentId, tabId);
  const providerSessionId = "provider-coordinator";
  if (options.adopt !== false) {
    await harness.commands.get("adopt_native_agent_session")!(
      {
        environmentId,
        agent: "claude",
        logicalSessionKey: `env-${environmentId}:${tabId}`,
        providerSessionId,
        origin: "interactive-native",
      },
      harness.context,
    );
  }
  return { ...session, coordinatorId, environmentId, tabId, sessionId, providerSessionId };
}

describe("Coordinator conversations are public sessions", () => {
  test("session.list and session.get read it without an environment or pane layout", async () => {
    const { harness, environmentId, tabId, sessionId } = await coordinatorSetup();
    const listed = await harness.call<{ items: PublicSessionSummary[]; total: number }>(
      "session.list",
      { environmentId },
    );
    expect(listed.ok && listed.result).toMatchObject({
      total: 1,
      items: [{ id: sessionId, environmentId, tabId, agent: "claude", title: "Coordinator" }],
    });
    const got = await harness.call<PublicSessionSummary>("session.get", { sessionId });
    expect(got.ok && got.result.id).toBe(sessionId);
    const transcript = await harness.call("session.transcript", { sessionId });
    expect(transcript.ok).toBe(true);
    expect(await harness.storage.getEnvironment(environmentId)).toBeNull();
    expect(await harness.storage.getPaneLayout(environmentId)).toBeNull();
  });

  test("session.prompt reaches the provider and its run completes, not interrupted", async () => {
    const { harness, service, stub, tabId, environmentId, sessionId, providerSessionId } =
      await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    const sent = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "What is the state of the release?" },
      { requestId: "coordinator-prompt" },
    );
    if (!sent.ok) throw new Error(`${sent.error.code}: ${sent.error.message}`);
    expect(stub.sends.at(-1)?.prompt).toContain("What is the state of the release?");

    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    const running = await harness.call("run.get", { operationId: sent.result.runId });
    expect(running.receipt?.state).toBe("running");

    stub.setStatus(async () => "idle");
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    const settled = await harness.call("run.get", { operationId: sent.result.runId });
    expect(settled.receipt?.state).toBe("succeeded");
    expect(settled.receipt?.execution?.state).toBe("completed");

    expect(await harness.storage.getEnvironment(environmentId)).toBeNull();
    expect(await harness.storage.getPaneLayout(environmentId)).toBeNull();
  });

  test("a run settles as interrupted once its conversation is closed", async () => {
    const {
      harness,
      service,
      stub,
      tabId,
      environmentId,
      sessionId,
      projectId,
      providerSessionId,
    } = await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    const sent = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "Go" },
      { requestId: "closing-prompt" },
    );
    if (!sent.ok) throw new Error(`${sent.error.code}: ${sent.error.message}`);
    expect(stub.sends).toHaveLength(1);
    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    await harness.storage.coordinators.mutateCoordinatorWorkspace(projectId, (current) => ({
      ...current!,
      conversations: current!.conversations.map((item) => ({
        ...item,
        closedAt: new Date(0).toISOString(),
      })),
    }));
    const settled = await harness.call("run.get", { operationId: sent.result.runId });
    expect(settled.receipt?.state).toBe("interrupted");
    expect(settled.receipt?.execution?.reason).toBe("The Coordinator conversation was closed");
  });

  test("a busy Coordinator refuses a prompt, as any session does", async () => {
    const { harness, service, stub, tabId, environmentId, sessionId, providerSessionId } =
      await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    const busy = await harness.call(
      "session.prompt",
      { sessionId, prompt: "Hello" },
      { requestId: "busy" },
    );
    expect(!busy.ok && busy.error.code).toBe("busy");
    expect(stub.sends).toHaveLength(0);
  });

  test("a paused Coordinator can be read but not prompted", async () => {
    const { harness, sessionId, environmentId, projectId } = await coordinatorSetup();
    await harness.storage.coordinators.mutateCoordinatorWorkspace(projectId, (current) => ({
      ...current!,
      lifecycleState: "paused",
    }));
    const listed = await harness.call("session.list", { environmentId });
    expect(listed.ok).toBe(true);
    const refused = await harness.call(
      "session.prompt",
      { sessionId, prompt: "Hello" },
      { requestId: "paused" },
    );
    expect(!refused.ok && refused.error.code).toBe("not-ready");
    expect(!refused.ok && refused.error.message).toContain("paused");
  });

  test("a conversation that never started is not-ready, not missing", async () => {
    const { harness, sessionId } = await coordinatorSetup({ adopt: false });
    const refused = await harness.call(
      "session.prompt",
      { sessionId, prompt: "Hello" },
      { requestId: "cold" },
    );
    expect(!refused.ok && refused.error.code).toBe("not-ready");
  });

  test("an unassigned, closed or unknown conversation names its reason", async () => {
    const { harness, coordinatorId } = await coordinatorSetup();
    const unassigned = coordinatorRuntimeId(coordinatorId, "unassigned");
    const listed = await harness.call("session.list", { environmentId: unassigned });
    expect(!listed.ok && listed.error.code).toBe("not-ready");
    expect(!listed.ok && listed.error.message).toContain("no agent yet");

    for (const environmentId of [
      coordinatorRuntimeId(coordinatorId, "closed"),
      coordinatorRuntimeId(coordinatorId, "missing"),
      coordinatorRuntimeId("no-such-coordinator", "main"),
      coordinatorRuntimeId(coordinatorId),
    ]) {
      const gone = await harness.call("session.list", { environmentId });
      expect(!gone.ok && gone.error.code).toBe("not-found");
      expect(!gone.ok && gone.error.message).toBe("The Coordinator conversation no longer exists");
    }
    const wrongTab = await harness.call("session.get", {
      sessionId: encodePublicSessionId(coordinatorRuntimeId(coordinatorId, "main"), "other-tab"),
    });
    expect(!wrongTab.ok && wrongTab.error.code).toBe("not-found");
  });

  test("fork, resume and a mode change are refused; the checkout stays a Coordinator's", async () => {
    const { harness, stub, sessionId, environmentId } = await coordinatorSetup();
    const attempts = [
      ["session.fork", { sessionId }],
      ["session.resume", { sessionId, historyId: "history-1" }],
      ["session.prompt", { sessionId, prompt: "Hello", mode: "build" }],
      ["session.config.set", { sessionId, mode: "build" }],
    ] as const;
    for (const [index, [action, input]] of attempts.entries()) {
      const refused = await harness.call(action, input, { requestId: `refused-${index}` });
      expect(!refused.ok && refused.error.code).toBe("unsupported");
    }
    expect(stub.sends).toHaveLength(0);
    expect(await harness.storage.getPaneLayout(environmentId)).toBeNull();
  });

  test("session.start and environment actions say a Coordinator is not an environment", async () => {
    const { harness, environmentId, stub } = await coordinatorSetup();
    const started = await harness.call(
      "session.start",
      { environmentId, agent: "claude", prompt: "Hello" },
      { requestId: "start-on-coordinator" },
    );
    expect(!started.ok && started.error.code).toBe("not-found");
    expect(!started.ok && started.error.message).toContain("project Coordinator");
    const environment = await harness.call("environment.get", { environmentId });
    expect(!environment.ok && environment.error.message).toContain("project Coordinator");
    expect(stub.sends).toHaveLength(0);
  });

  test("images go to application data and other files are refused, never the checkout", async () => {
    const { harness, service, stub, tabId, environmentId, sessionId, providerSessionId } =
      await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    const send = stub.provider.send as unknown as { mock: { calls: unknown[][] } };
    const before = await fs.readdir(harness.root);
    const file = await harness.call(
      "session.prompt",
      {
        sessionId,
        prompt: "Read this",
        attachments: [
          { name: "notes.txt", type: "file", dataBase64: Buffer.from("notes").toString("base64") },
        ],
      },
      { requestId: "file-attachment" },
    );
    expect(!file.ok && file.error.code).toBe("capability-unavailable");

    const image = await harness.call(
      "session.prompt",
      {
        sessionId,
        prompt: "Look at this",
        attachments: [{ name: "pixel.png", type: "image", dataBase64: PIXEL_PNG }],
      },
      { requestId: "image-attachment" },
    );
    if (!image.ok) throw new Error(`${image.error.code}: ${image.error.message}`);
    const options = send.mock.calls.at(-1)?.[2] as { attachments?: Array<{ path: string }> };
    const stored = options.attachments?.[0]?.path ?? "";
    expect(stored).toStartWith(path.join(harness.dataDir, "coordinator-attachments"));
    expect((await fs.stat(stored)).isFile()).toBe(true);
    expect(await fs.readdir(harness.root)).toEqual(before);
  });
});
