import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test as bunTest,
} from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoordinatorService } from "./coordinator-service.js";
import {
  createLocalWorktree,
  prepareEnvironmentForSetup,
  reconcileContainerDelegationBase,
  reconcilePreparedContainerDelegation,
} from "./commands-environment.js";
import * as remoteGit from "./git-noninteractive-env.js";
import { ProjectGitService } from "./project-git-service.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";
import { readStoredValue, seedStore, writeLegacyStore } from "./storage-test-support.js";
import { runCommand } from "./shell.js";
import { prepareCoordinatorCodexHome } from "./commands-servers.js";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

// Bun abandons a timed-out test body but keeps running it, and kills its child
// processes. Every test here records its body so cleanup waits for that late
// Git and storage work instead of deleting the fixture underneath it (flakes
// 0165 and 0461). The recorded copy settles quietly: Bun reports the timeout
// itself, and a body that finishes in time still fails through `running`.
let pendingBody: Promise<void> | null = null;
function tracked<A extends unknown[]>(body: (...args: A) => unknown) {
  return (...args: A): Promise<unknown> => {
    const running = Promise.resolve().then(() => body(...args));
    pendingBody = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  };
}
const test = Object.assign((name: string, body: () => unknown) => bunTest(name, tracked(body)), {
  each:
    <T>(cases: readonly T[]) =>
    (name: string, body: (value: T) => unknown) =>
      bunTest.each(cases)(name, tracked(body)),
});

describe("project coordinator", () => {
  let root: string;
  let checkout: string;
  let storage: StorageService;
  // Repositories built once and copied per test, so each test starts from a
  // real checkout without paying for `git init` and a first commit again.
  let templates: string;
  let templateCheckout: string;
  // A bare repository whose `main` is the template checkout's initial commit.
  let templateRemote: string;
  // A one-commit repository the submodule case adds; `submodule add` only clones it.
  let templateSubmodule: string;

  beforeAll(async () => {
    templates = await fs.mkdtemp(path.join(os.tmpdir(), "ork-coordinator-templates-"));
    templateCheckout = path.join(templates, "checkout");
    templateRemote = path.join(templates, "remote.git");
    templateSubmodule = path.join(templates, "submodule");
    const commitReadme = async (cwd: string, file: string, email: string, name: string) => {
      await fs.mkdir(cwd);
      await runCommand("git", ["init", "-b", "main"], { cwd });
      await runCommand("git", ["config", "user.email", email], { cwd });
      await runCommand("git", ["config", "user.name", name], { cwd });
      await fs.writeFile(path.join(cwd, file), file === "README.md" ? "initial\n" : "lib\n");
      await runCommand("git", ["add", file], { cwd });
      await runCommand("git", ["commit", "-m", file === "README.md" ? "initial" : "sub"], { cwd });
    };
    await Promise.all([
      commitReadme(templateCheckout, "README.md", "test@example.invalid", "Coordinator Test"),
      commitReadme(templateSubmodule, "lib.txt", "sub@example.invalid", "Sub"),
    ]);
    await runCommand("git", ["clone", "--bare", "--quiet", templateCheckout, templateRemote], {
      cwd: templates,
    });
  });

  afterAll(async () => {
    await fs.rm(templates, { recursive: true, force: true });
  });

  /** Copies the prebuilt bare remote to `target` and adds it as `name` without fetching. */
  async function addTemplateRemote(name: string, target: string): Promise<void> {
    await fs.cp(templateRemote, target, { recursive: true });
    await runCommand("git", ["remote", "add", name, target], { cwd: checkout });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-coordinator-"));
    checkout = path.join(root, "checkout");
    await fs.cp(templateCheckout, checkout, { recursive: true });
    storage = new StorageService(path.join(root, "data"));
    await storage.init();
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      agentSettings: { ...config.global.agentSettings, defaultAgent: "codex" },
    });
  });

  afterEach(
    async () => {
      const body = pendingBody;
      pendingBody = null;
      if (body) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          body,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 25_000);
          }),
        ]);
        clearTimeout(timer);
      }
      storage.close();
      await fs.rm(root, { recursive: true, force: true });
    },
    { timeout: 30_000 },
  );

  test("concurrent ensure converges without sending work and a closed last tab stays closed", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshots = await Promise.all(
      Array.from({ length: 8 }, () => service.ensure(project.id)),
    );
    expect(new Set(snapshots.map(({ workspace }) => workspace.id)).size).toBe(1);
    expect(snapshots[0]!.workspace.conversations).toHaveLength(1);
    expect(await storage.listNativeAgentSessions()).toEqual([]);

    const conversationId = snapshots[0]!.workspace.conversations[0]!.id;
    const closed = await service.closeConversation(project.id, conversationId);
    expect(closed.workspace.selectedConversationId).toBeNull();
    expect((await service.ensure(project.id)).workspace.selectedConversationId).toBeNull();
  });

  test("one main coordinator; new conversations are numbered side agents", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const main = initial.workspace.conversations[0]!;
    expect(main).toMatchObject({ role: "main", title: "Coordinator" });

    await service.createConversation(project.id);
    const two = await service.createConversation(project.id);
    const sides = two.workspace.conversations.filter((item) => item.role === "side");
    expect(sides.map((item) => [item.title, item.sideOrdinal])).toEqual([
      ["Side 1", 1],
      ["Side 2", 2],
    ]);
    // A closed side's number is reused.
    await service.closeConversation(project.id, sides[0]!.id);
    const reused = await service.createConversation(project.id);
    expect(
      reused.workspace.conversations
        .filter((item) => item.role === "side" && !item.closedAt)
        .map((item) => item.title)
        .toSorted(),
    ).toEqual(["Side 1", "Side 2"]);

    // Closing the main is how its provider is changed: the next new
    // conversation is the main again, never a second one alongside it.
    await service.closeConversation(project.id, main.id);
    const replaced = await service.createConversation(project.id);
    const mains = replaced.workspace.conversations.filter(
      (item) => item.role === "main" && !item.closedAt,
    );
    expect(mains).toHaveLength(1);
    expect(mains[0]!.id).not.toBe(main.id);
  });

  test("a new conversation closes the unused empty side agents its caller names", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const workspaceId = initial.workspace.id;
    const main = initial.workspace.conversations[0]!;
    const side = async () =>
      (await service.createConversation(project.id)).workspace.selectedConversationId!;
    const empty = await side();
    const drafted = await side();
    const metadataOnly = await side();
    const owning = await side();
    const assigned = await side();
    const snapshot = (await service.get(project.id))!;
    const byId = new Map(snapshot.workspace.conversations.map((item) => [item.id, item]));
    const draftKey = (id: string) =>
      `agent-native:${coordinatorRuntimeId(workspaceId, id)}:${encodeURIComponent(
        `${coordinatorRuntimeId(workspaceId, id)}:${byId.get(id)!.tabId}`,
      )}`;
    await storage.saveComposeDraft(
      draftKey(drafted),
      "environment",
      coordinatorRuntimeId(workspaceId, drafted),
      { text: "Half-written plan", mentions: [], attachments: [], annotations: [] },
    );
    // A platform picked but nothing written is still an empty composer.
    await storage.saveComposeDraft(
      draftKey(metadataOnly),
      "environment",
      coordinatorRuntimeId(workspaceId, metadataOnly),
      {
        text: "  ",
        mentions: [],
        attachments: [],
        annotations: [],
        metadata: { platform: "codex" },
      },
    );
    await storage.saveCoordinatorWorkflowAssociation({
      id: "work-of-owning",
      projectId: project.id,
      coordinatorId: workspaceId,
      conversationId: owning,
      kind: "environment",
      resourceId: "env-somewhere",
      requestId: "request-owning",
      createdAt: new Date().toISOString(),
    });
    await service.assignConversationAgent(project.id, assigned, "claude");

    const created = await service.createConversation(project.id, undefined, {
      closeUnused: [empty, drafted, metadataOnly, owning, assigned, main.id, "missing"],
    });
    const open = new Set(
      created.workspace.conversations.filter((item) => !item.closedAt).map((item) => item.id),
    );
    expect(open.has(empty)).toBe(false);
    expect(open.has(metadataOnly)).toBe(false);
    // Text, owned work, an assigned provider and the main coordinator all stay.
    expect(open.has(drafted)).toBe(true);
    expect(open.has(owning)).toBe(true);
    expect(open.has(assigned)).toBe(true);
    expect(open.has(main.id)).toBe(true);
    expect(open.has(created.workspace.selectedConversationId!)).toBe(true);
    // Without names, nothing is closed.
    const again = await service.createConversation(project.id);
    expect(again.workspace.conversations.filter((item) => !item.closedAt)).toHaveLength(
      open.size + 1,
    );
  });

  test("a draft committed after candidate inspection keeps its conversation open", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await service.ensure(project.id);
    const before = await service.createConversation(project.id);
    const id = before.workspace.selectedConversationId!;
    const runtimeId = coordinatorRuntimeId(before.workspace.id, id);
    const inspected = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const original = storage.listComposeDrafts.bind(storage);
    const read = spyOn(storage, "listComposeDrafts").mockImplementation(async (...args) => {
      const drafts = await original(...args);
      if (args[1] === runtimeId) {
        inspected.resolve();
        await resume.promise;
      }
      return drafts;
    });
    const creation = service.createConversation(project.id, undefined, { closeUnused: [id] });
    try {
      await inspected.promise;
      // A separate storage instance represents another window's committed save.
      const other = new StorageService(path.join(root, "data"));
      try {
        await other.init();
        await other.saveComposeDraft("concurrent-draft", "environment", runtimeId, {
          text: "Keep this plan",
        });
      } finally {
        other.close();
      }
    } finally {
      resume.resolve();
      read.mockRestore();
    }
    const after = await creation;
    expect(after.workspace.conversations.find((item) => item.id === id)?.closedAt).toBeUndefined();
    expect((await storage.getComposeDraft("concurrent-draft"))?.value).toEqual({
      text: "Keep this plan",
    });
  });

  test.each([
    "missing",
    "storage-error",
    "mail",
    "provider-session",
    "assigned-during-inspection",
    "session-during-inspection",
  ] as const)("unused cleanup preserves usage and fails closed: %s", async (usage) => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await service.ensure(project.id);
    const before = await service.createConversation(project.id);
    const id = before.workspace.selectedConversationId!;
    if (usage === "provider-session") {
      await storage.mutateCoordinatorWorkspace(project.id, (current) => ({
        ...current!,
        conversations: current!.conversations.map((item) =>
          item.id === id ? { ...item, providerSessionId: "session" } : item,
        ),
      }));
    }
    const mailbox = spyOn(storage, "getAgentMailMailbox").mockImplementation(async () => {
      if (usage === "assigned-during-inspection" || usage === "session-during-inspection") {
        await storage.mutateCoordinatorWorkspace(project.id, (current) => ({
          ...current!,
          conversations: current!.conversations.map((item) =>
            item.id === id
              ? {
                  ...item,
                  ...(usage === "assigned-during-inspection"
                    ? { agent: "codex" as const }
                    : { providerSessionId: "late-session" }),
                }
              : item,
          ),
        }));
      }
      if (usage === "storage-error") throw new Error("Malformed mail store");
      if (usage === "mail")
        return { total: 1 } as Awaited<ReturnType<StorageService["getAgentMailMailbox"]>>;
      throw new AgentMailError("recipient-not-found", "Mailbox not found");
    });
    try {
      const after = await service.createConversation(project.id, undefined, { closeUnused: [id] });
      expect(Boolean(after.workspace.conversations.find((item) => item.id === id)?.closedAt)).toBe(
        usage === "missing",
      );
      if (usage === "missing") {
        await expect(
          storage.saveComposeDraft(
            "too-late",
            "environment",
            coordinatorRuntimeId(before.workspace.id, id),
            { text: "late" },
          ),
        ).rejects.toThrow("conversation is closed");
      }
    } finally {
      mailbox.mockRestore();
    }
  });

  test("closing unused composers makes room at the open-conversation limit", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await service.ensure(project.id);
    const sides: string[] = [];
    for (let index = 0; index < 15; index += 1) {
      sides.push((await service.createConversation(project.id)).workspace.selectedConversationId!);
    }
    await expect(service.createConversation(project.id)).rejects.toThrow(
      "Coordinator conversation limit reached",
    );
    const created = await service.createConversation(project.id, undefined, {
      closeUnused: sides,
    });
    expect(created.workspace.conversations.filter((item) => !item.closedAt)).toHaveLength(2);
    expect(
      created.workspace.conversations.find(
        (item) => item.id === created.workspace.selectedConversationId,
      ),
    ).toMatchObject({ sideOrdinal: 1, title: "Side 1" });
  });

  test("ensure and createConversation persist the renderer's canonical session keys", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const created = await service.createConversation(project.id);
    const persisted = readStoredValue<{
      workspaces: Record<string, typeof initial.workspace>;
    }>(path.join(root, "data"), "coordinators.json")!.workspaces[project.id]!;
    expect(persisted.conversations).toHaveLength(2);
    expect(persisted.id).toBe(created.workspace.id);
    for (const conversation of persisted.conversations) {
      expect(conversation.logicalSessionKey).toBe(
        `env-coordinator:${persisted.id}:${conversation.id}:${conversation.tabId}`,
      );
    }
    expect(persisted.conversations[0]!.id).toBe(initial.workspace.conversations[0]!.id);
  });

  test("retention never removes an open conversation", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const originalConversationId = initial.workspace.conversations[0]!.id;
    const cycle = async (index: number) => {
      const created = await service.createConversation(project.id, `Temporary ${index}`);
      const id = created.workspace.selectedConversationId!;
      await service.closeConversation(project.id, id);
      return id;
    };
    const oldestClosedId = await cycle(0);

    // Fill the 64-conversation boundary in one mutation. 64 complete
    // create/close cycles (128 durable writes) exceeded Bun's 5 s limit under
    // aggregate load (flake 0266); retention itself runs on each create below.
    await storage.mutateCoordinatorWorkspace(project.id, (current) => {
      if (!current) throw new Error("Coordinator workspace disappeared");
      const original = current.conversations.find((item) => item.id === originalConversationId)!;
      const closed = current.conversations.find((item) => item.id === oldestClosedId)!;
      return {
        ...current,
        conversations: [
          original,
          closed,
          ...Array.from({ length: 62 }, (_, index) => ({
            ...closed,
            id: `closed-${index}`,
            tabId: `closed-tab-${index}`,
            logicalSessionKey: `closed-session-${index}`,
            mailboxIncarnationId: `closed-mailbox-${index}`,
          })),
        ],
      };
    });
    let newestClosedId = oldestClosedId;
    for (let index = 1; index <= 3; index += 1) newestClosedId = await cycle(index);

    const retained = await service.get(project.id);
    const ids = retained!.workspace.conversations.map((item) => item.id);
    expect(ids).toHaveLength(64);
    expect(
      retained!.workspace.conversations.some(
        (item) => item.id === originalConversationId && !item.closedAt,
      ),
    ).toBe(true);
    // Each full create evicted the oldest closed conversation instead.
    expect(ids).not.toContain(oldestClosedId);
    expect(ids).not.toContain("closed-1");
    expect(ids).toContain("closed-2");
    expect(ids).toContain(newestClosedId);
  });

  test("retention removes attachment directories only after closed conversations are pruned", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const coordinatorId = initial.workspace.id;
    const closedConversationId = initial.workspace.conversations[0]!.id;
    const closedAttachment = await storage.writeCoordinatorAttachment(
      coordinatorId,
      closedConversationId,
      "closed.png",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );
    await service.closeConversation(project.id, closedConversationId);

    const firstOpen = await service.createConversation(project.id, "Open");
    const openConversationId = firstOpen.workspace.selectedConversationId!;
    const openAttachment = await storage.writeCoordinatorAttachment(
      coordinatorId,
      openConversationId,
      "open.png",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );

    // Populate the durable boundary in one mutation. Running 63 complete
    // create/close cycles here makes this filesystem test exceed Bun's 5s
    // limit when the aggregate suite is under load, while the behavior under
    // test is the single retention pass on the next create.
    await storage.mutateCoordinatorWorkspace(project.id, (current) => {
      if (!current) throw new Error("Coordinator workspace disappeared");
      const closed = current.conversations.find((item) => item.id === closedConversationId)!;
      const open = current.conversations.find((item) => item.id === openConversationId)!;
      return {
        ...current,
        conversations: [
          closed,
          open,
          ...Array.from({ length: 62 }, (_, index) => ({
            ...closed,
            id: `closed-${index}`,
            tabId: `closed-tab-${index}`,
            logicalSessionKey: `closed-session-${index}`,
            mailboxIncarnationId: `closed-mailbox-${index}`,
          })),
        ],
      };
    });
    await service.createConversation(project.id, "Trigger retention");

    const retained = await service.get(project.id);
    expect(retained!.workspace.conversations.some((item) => item.id === closedConversationId)).toBe(
      false,
    );
    expect(retained!.workspace.conversations.some((item) => item.id === openConversationId)).toBe(
      true,
    );
    await expect(fs.access(closedAttachment)).rejects.toThrow();
    expect((await fs.stat(openAttachment)).isFile()).toBe(true);
  });

  test("ensure retries a transient startup error without replacing materialized conversations", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const conversation = initial.workspace.conversations[0]!;
    await service.assignConversationAgent(project.id, conversation.id, "codex");
    await storage.adoptNativeAgentSession({
      key: `coordinator:${initial.workspace.id}:${conversation.id}:codex`,
      environmentId: `coordinator:${initial.workspace.id}:${conversation.id}`,
      agent: "codex",
      logicalSessionKey: conversation.logicalSessionKey,
      providerSessionId: "thread-1",
      origin: "coordinator",
      executionPolicy: "coordinator-read-only",
      owner: {
        kind: "coordinator",
        projectId: project.id,
        coordinatorId: initial.workspace.id,
      },
    });
    await service.recordStartupError(project.id, new Error("bridge did not become healthy"));

    const retried = await service.ensure(project.id);
    expect(retried.workspace).toMatchObject({
      id: initial.workspace.id,
      lifecycleState: "ready",
      selectedConversationId: conversation.id,
      conversations: [{ id: conversation.id, agent: "codex" }],
    });
    expect(retried.workspace.lastStartupError).toBeUndefined();
  });

  test("a new conversation has no agent until its first prompt assigns one", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const first = initial.workspace.conversations[0]!;
    expect(first.agent).toBeUndefined();
    // The repository default is a preselection for the composer, not a binding.
    expect(await service.preferredAgent(project.id)).toBe("codex");

    const created = await service.createConversation(project.id, "Second");
    const second = created.workspace.conversations.find((item) => item.id !== first.id)!;
    expect(second.agent).toBeUndefined();

    const assigned = await service.assignConversationAgent(project.id, second.id, "codex");
    expect(assigned.workspace.conversations.find((item) => item.id === second.id)!.agent).toBe(
      "codex",
    );
    // Assignment binds one conversation, never its siblings.
    expect(
      assigned.workspace.conversations.find((item) => item.id === first.id)!.agent,
    ).toBeUndefined();
  });

  test("assignment is refused for a platform this host does not qualify", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const conversation = initial.workspace.conversations[0]!;
    await expect(
      service.assignConversationAgent(project.id, conversation.id, "grok"),
    ).rejects.toThrow(/request permission|turned off in settings/);
    expect(
      (await storage.getCoordinatorWorkspace(project.id))!.conversations[0]!.agent,
    ).toBeUndefined();
  });

  test("re-assignment is allowed before a session exists and refused after", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const conversation = initial.workspace.conversations[0]!;
    await service.assignConversationAgent(project.id, conversation.id, "codex");
    // A first send that never reached a bridge leaves nothing materialized, so
    // the user must not be stranded on the platform that just failed.
    const reassigned = await service.assignConversationAgent(project.id, conversation.id, "claude");
    expect(reassigned.workspace.conversations[0]!.agent).toBe("claude");

    await storage.adoptNativeAgentSession({
      key: `coordinator:${initial.workspace.id}:${conversation.id}:claude`,
      environmentId: coordinatorRuntimeId(initial.workspace.id, conversation.id),
      agent: "claude",
      logicalSessionKey: conversation.logicalSessionKey,
      providerSessionId: "session-1",
      origin: "coordinator",
      executionPolicy: "coordinator-read-only",
      owner: {
        kind: "coordinator",
        projectId: project.id,
        coordinatorId: initial.workspace.id,
      },
    });
    await expect(
      service.assignConversationAgent(project.id, conversation.id, "codex"),
    ).rejects.toThrow("already has a provider session");
    // Re-asserting the same platform stays a no-op rather than an error, so a
    // retried first send cannot fail on its own success.
    await expect(
      service.assignConversationAgent(project.id, conversation.id, "claude"),
    ).resolves.toBeDefined();
  });

  test("a closed conversation cannot be assigned", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    const conversation = initial.workspace.conversations[0]!;
    await service.closeConversation(project.id, conversation.id);
    await expect(
      service.assignConversationAgent(project.id, conversation.id, "codex"),
    ).rejects.toThrow("conversation was not found");
  });

  test("an unqualified repository default no longer errors the whole workspace", async () => {
    const config = await storage.loadConfig();
    const global = {
      ...config.global,
      enabledAgentPlatforms: ["cursor", "grok", "opencode"] satisfies AgentPlatform[],
      agentSettings: { ...config.global.agentSettings, defaultAgent: "grok" as const },
    };
    delete global.coordinatorProviderTiers;
    await storage.saveConfig({ ...config, global });
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const service = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await service.ensure(project.id);
    expect(initial.workspace.lifecycleState).toBe("ready");
    expect(initial.workspace.lastStartupError).toBeUndefined();
    // Grok is not qualified at the default safety level, so the composer
    // preselects something that is rather than offering a dead end.
    expect(await service.preferredAgent(project.id)).toBe("cursor");
    expect(initial.providerAvailability.grok).toMatchObject({
      tier: "advisory",
      available: false,
    });
    expect(initial.providerAvailability.cursor).toMatchObject({
      tier: "provider-configured",
      available: true,
    });
    expect(initial.providerAvailability.opencode).toMatchObject({
      tier: "provider-configured",
      available: true,
    });
  });

  test("a workspace persisted with the Codex-named bridge fields keeps its bridge", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const now = new Date().toISOString();
    // Written exactly as a pre-rename installation left it, and imported the
    // way an upgrade does. Dropping these would hide a running child from the
    // reaper, and the next launch would start a second bridge against the
    // same rollout.
    const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestrator-coordinator-legacy-"));
    writeLegacyStore(legacyDir, "projects.json", [project]);
    writeLegacyStore(legacyDir, "coordinators.json", {
      version: 1,
      revision: 3,
      workflows: [],
      workspaces: {
        [project.id]: {
          version: 1,
          id: "workspace-legacy",
          projectId: project.id,
          executionPolicy: "coordinator-read-only",
          lifecycleState: "ready",
          selectedConversationId: "conversation-legacy",
          repositoryContextRevision: 0,
          createdAt: now,
          updatedAt: now,
          codexBridgePort: 4123,
          codexBridgePid: 9911,
          conversations: [
            {
              id: "conversation-legacy",
              tabId: "coordinator-conversation-legacy",
              logicalSessionKey: "coordinator-workspace-legacy:conversation-legacy",
              agent: "codex",
              title: "Coordinator",
              createdAt: now,
              mailboxIncarnationId: "incarnation-legacy",
              codexBridgePort: 4123,
              codexBridgePid: 9911,
            },
          ],
        },
      },
    });
    const upgraded = new StorageService(legacyDir);
    const workspace = (await upgraded.getCoordinatorWorkspace(project.id))!;
    upgraded.close();
    await fs.rm(legacyDir, { recursive: true, force: true });
    expect(workspace).toMatchObject({ id: "workspace-legacy", bridgePort: 4123, bridgePid: 9911 });
    expect(workspace.conversations[0]).toMatchObject({
      id: "conversation-legacy",
      agent: "codex",
      bridgePort: 4123,
      bridgePid: 9911,
      // The renderer's tab key, so mail lands in the transcript the tab shows.
      logicalSessionKey:
        "env-coordinator:workspace-legacy:conversation-legacy:coordinator-conversation-legacy",
    });
    expect(workspace.conversations[0]).not.toHaveProperty("codexBridgePort");
  });

  test("Git status permits confirmed dirty branch switches and detects external context changes", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await coordinator.ensure(project.id);
    const git = new ProjectGitService(storage);
    const first = await git.status(project.id);
    expect(first).toMatchObject({ branch: "main", trackedChanges: 0, untrackedChanges: 0 });
    expect(await git.fetch(project.id, true)).toMatchObject({
      upstream: null,
      remoteState: "unknown",
      lastError: null,
    });
    const firstStoredRevision = (await storage.getCoordinatorWorkspace(project.id))!
      .repositoryStatus!.revision;
    await git.status(project.id);
    expect((await storage.getCoordinatorWorkspace(project.id))!.repositoryStatus!.revision).toBe(
      firstStoredRevision,
    );

    const releaseTurn = git.beginCoordinatorTurn(project.id);
    await expect(git.switchBranch(project.id, "refs/heads/main")).rejects.toThrow(
      "Wait for the coordinator turn",
    );
    releaseTurn();
    const switching = git.switchBranch(project.id, "refs/heads/main");
    expect(() => git.beginCoordinatorTurn(project.id)).toThrow("checkout is changing");
    await switching;

    const activeTurnGit = new ProjectGitService(storage, async () => true);
    await expect(activeTurnGit.switchBranch(project.id, "refs/heads/main")).rejects.toThrow(
      "active coordinator turn",
    );

    await runCommand("git", ["branch", "occupied"], { cwd: checkout });
    const occupiedWorktree = path.join(root, "occupied-worktree");
    await runCommand("git", ["worktree", "add", occupiedWorktree, "occupied"], { cwd: checkout });
    await git.status(project.id);
    await expect(git.switchBranch(project.id, "refs/heads/occupied")).rejects.toThrow(
      "another worktree",
    );
    await fs.writeFile(path.join(checkout, "preserved.txt"), "keep me\n");
    await expect(git.prepareSwitchBranch(project.id, "refs/heads/occupied")).rejects.toThrow(
      "another worktree",
    );
    await expect(
      git.switchBranch(project.id, "refs/heads/occupied", { confirmationToken: "stale" }),
    ).rejects.toThrow("another worktree");
    expect(await fs.readFile(path.join(checkout, "preserved.txt"), "utf8")).toBe("keep me\n");
    await fs.rm(path.join(checkout, "preserved.txt"));
    await runCommand("git", ["worktree", "remove", occupiedWorktree], { cwd: checkout });

    const gitDirectory = (
      await runCommand("git", ["rev-parse", "--git-dir"], { cwd: checkout })
    ).stdout.trim();
    await fs.writeFile(path.join(checkout, "README.md"), "merge dirty\n");
    await fs.writeFile(
      path.resolve(checkout, gitDirectory, "MERGE_HEAD"),
      `${first.headCommit!}\n`,
    );
    expect(await git.status(project.id)).toMatchObject({ mergeInProgress: true });
    await expect(git.switchBranch(project.id, "refs/heads/main")).rejects.toThrow("current merge");
    await expect(git.prepareSwitchBranch(project.id, "refs/heads/main")).rejects.toThrow(
      "current merge",
    );
    await expect(
      git.switchBranch(project.id, "refs/heads/main", { confirmationToken: "ignored" }),
    ).rejects.toThrow("current merge");
    expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe("merge dirty\n");
    await fs.rm(path.resolve(checkout, gitDirectory, "MERGE_HEAD"));
    await runCommand("git", ["checkout", "--", "README.md"], { cwd: checkout });

    const rebaseMarker = path.resolve(checkout, gitDirectory, "rebase-merge");
    await fs.mkdir(rebaseMarker);
    expect(await git.status(project.id)).toMatchObject({ rebaseInProgress: true });
    await expect(git.switchBranch(project.id, "refs/heads/main")).rejects.toThrow("current rebase");
    await fs.rm(rebaseMarker, { recursive: true });

    await fs.writeFile(path.join(checkout, "README.md"), "changed\n");
    await fs.writeFile(path.join(checkout, "untracked.txt"), "local\n");
    const dirty = await git.status(project.id);
    expect(dirty.trackedChanges).toBe(1);
    expect(dirty.untrackedChanges).toBe(1);
    expect(dirty.repositoryOperationBlockedReason).toContain("Commit or discard");
    await expect(git.switchBranch(project.id, "refs/heads/occupied")).rejects.toThrow(
      "Confirm the current checkout",
    );
    await expect(git.switchBranch(project.id, "refs/heads/occupied", true)).rejects.toThrow(
      "Confirm the current checkout",
    );
    const confirmation = await git.prepareSwitchBranch(project.id, "refs/heads/occupied");
    expect(confirmation).toMatchObject({
      ref: "refs/heads/occupied",
      trackedChanges: 1,
      untrackedFiles: 1,
      requiresEnhancedConfirmation: false,
    });
    const discarded = await git.switchBranch(project.id, "refs/heads/occupied", {
      confirmationToken: confirmation.token,
    });
    expect(discarded).toMatchObject({
      branch: "occupied",
      trackedChanges: 0,
      untrackedChanges: 0,
    });
    expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe("initial\n");
    await expect(fs.access(path.join(checkout, "untracked.txt"))).rejects.toThrow();

    await runCommand("git", ["switch", "-c", "external"], { cwd: checkout });
    const changed = await git.status(project.id);
    const snapshot = await coordinator.get(project.id);
    expect(changed.branch).toBe("external");
    expect(snapshot!.workspace.repositoryContextRevision).toBeGreaterThan(0);
  });

  test("operation markers in a newline-containing Git directory block linked-worktree switches", async () => {
    const repository = path.join(root, "repository\nmetadata");
    await fs.rename(checkout, repository);
    await runCommand("git", ["branch", "other"], { cwd: repository });
    await runCommand("git", ["worktree", "add", "-b", "linked", checkout], {
      cwd: repository,
    });
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const git = new ProjectGitService(storage);
    const initial = await git.status(project.id);
    expect(initial).toMatchObject({ branch: "linked", mergeInProgress: false });

    const gitDirectory = (
      await runCommand("git", ["rev-parse", "--absolute-git-dir"], { cwd: checkout })
    ).stdout.trim();
    expect(gitDirectory).toContain("repository\nmetadata");
    expect(gitDirectory).not.toBe(path.join(checkout, ".git"));
    const marker = path.join(gitDirectory, "MERGE_HEAD");
    await fs.writeFile(marker, `${initial.headCommit!}\n`);

    expect(await git.status(project.id)).toMatchObject({
      mergeInProgress: true,
      repositoryOperationBlockedReason: "Finish the current merge first.",
      trackedChanges: 0,
      untrackedChanges: 0,
    });
    await expect(git.prepareSwitchBranch(project.id, "refs/heads/other")).rejects.toThrow(
      "current merge",
    );
    await expect(git.switchBranch(project.id, "refs/heads/other")).rejects.toThrow("current merge");
    expect(
      (await runCommand("git", ["branch", "--show-current"], { cwd: checkout })).stdout.trim(),
    ).toBe("linked");
    expect(await fs.readFile(marker, "utf8")).toBe(`${initial.headCommit!}\n`);

    await fs.rm(marker);
    expect(await git.switchBranch(project.id, "refs/heads/other")).toMatchObject({
      branch: "other",
      mergeInProgress: false,
    });
  });

  /** A coordinator-owned project on the template checkout, with a second branch `other`. */
  async function discardFixture() {
    await runCommand("git", ["branch", "other"], { cwd: checkout });
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await coordinator.ensure(project.id);
    return {
      project,
      git: new ProjectGitService(storage),
      gitDirectory: path.join(checkout, ".git"),
    };
  }

  // The bound-discard refusals are three cases: each drives several full status
  // reads and checkout inspections, and together they did not fit one
  // five-second budget under aggregate load (flake 0165).
  test("bound discard confirmations refuse stale and reused tokens", async () => {
    const { project, git } = await discardFixture();

    await fs.writeFile(path.join(checkout, "README.md"), "stale\n");
    const staleConfirmation = await git.prepareSwitchBranch(project.id, "refs/heads/other");
    await fs.writeFile(path.join(checkout, "newer.txt"), "added after prepare\n");
    await expect(
      git.switchBranch(project.id, "refs/heads/other", {
        confirmationToken: staleConfirmation.token,
      }),
    ).rejects.toThrow("checkout changed after confirmation");
    expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe("stale\n");
    expect(await fs.readFile(path.join(checkout, "newer.txt"), "utf8")).toBe(
      "added after prepare\n",
    );
    const boundConfirmation = await git.prepareSwitchBranch(project.id, "refs/heads/other");
    expect(boundConfirmation.untrackedFiles).toBe(1);
    const switched = await git.switchBranch(project.id, "refs/heads/other", {
      confirmationToken: boundConfirmation.token,
    });
    expect(switched).toMatchObject({ branch: "other", trackedChanges: 0, untrackedChanges: 0 });
    await fs.writeFile(path.join(checkout, "README.md"), "reuse\n");
    await expect(
      git.switchBranch(project.id, "refs/heads/main", {
        confirmationToken: boundConfirmation.token,
      }),
    ).rejects.toThrow("Confirm the current checkout");
    expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe("reuse\n");
    await runCommand("git", ["checkout", "--", "README.md"], { cwd: checkout });
  });

  test("bound discard confirmations refuse sequencer and conflicted merge switches", async () => {
    const { project, git, gitDirectory } = await discardFixture();
    const headCommit = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })
    ).stdout.trim();

    await fs.writeFile(path.join(checkout, "README.md"), "cherry\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await fs.writeFile(path.resolve(checkout, gitDirectory, "CHERRY_PICK_HEAD"), `${headCommit}\n`);
    expect(await git.status(project.id)).toMatchObject({ sequencerInProgress: true });
    await expect(git.prepareSwitchBranch(project.id, "refs/heads/other")).rejects.toThrow(
      "current cherry-pick",
    );
    await expect(
      git.switchBranch(project.id, "refs/heads/other", { confirmationToken: "ignored" }),
    ).rejects.toThrow("current cherry-pick");
    expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe("cherry\n");
    await fs.rm(path.resolve(checkout, gitDirectory, "CHERRY_PICK_HEAD"));
    await runCommand("git", ["reset", "--hard", "HEAD"], { cwd: checkout });

    await fs.writeFile(path.join(checkout, "README.md"), "conflicted\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "conflict side"], { cwd: checkout });
    await runCommand("git", ["switch", "other"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "README.md"), "other side\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "other side"], { cwd: checkout });
    await runCommand("git", ["merge", "main"], { cwd: checkout }).catch(() => undefined);
    const conflicted = await git.status(project.id);
    expect(conflicted.conflicts).toBeGreaterThan(0);
    await expect(git.prepareSwitchBranch(project.id, "refs/heads/main")).rejects.toThrow(
      /merge|conflicts/i,
    );
    await expect(
      git.switchBranch(project.id, "refs/heads/main", { confirmationToken: "ignored" }),
    ).rejects.toThrow(/merge|conflicts/i);
    await runCommand("git", ["merge", "--abort"], { cwd: checkout });
  });

  test("bound discard confirmations refuse a vanished branch and unconfirmed nested repositories", async () => {
    const { project, git } = await discardFixture();
    await runCommand("git", ["switch", "other"], { cwd: checkout });

    await fs.writeFile(path.join(checkout, "README.md"), "before vanish\n");
    const vanishing = await git.prepareSwitchBranch(project.id, "refs/heads/main");
    await runCommand("git", ["branch", "-D", "main"], { cwd: checkout });
    await expect(
      git.switchBranch(project.id, "refs/heads/main", { confirmationToken: vanishing.token }),
    ).rejects.toThrow("no longer available");
    expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe("before vanish\n");
    await runCommand("git", ["branch", "main", "HEAD"], { cwd: checkout });
    await runCommand("git", ["checkout", "--", "README.md"], { cwd: checkout });

    const nested = path.join(checkout, "nested-repo");
    await fs.mkdir(nested);
    await runCommand("git", ["init", "-b", "main"], { cwd: nested });
    await fs.writeFile(path.join(nested, "secret.txt"), "secret\n");
    await fs.writeFile(path.join(checkout, "README.md"), "nested dirty\n");
    const nestedConfirmation = await git.prepareSwitchBranch(project.id, "refs/heads/main");
    expect(nestedConfirmation.requiresEnhancedConfirmation).toBe(true);
    expect(nestedConfirmation.nestedRepositories.some((item) => item.includes("nested-repo"))).toBe(
      true,
    );
    await expect(
      git.switchBranch(project.id, "refs/heads/main", {
        confirmationToken: nestedConfirmation.token,
      }),
    ).rejects.toThrow("nested repositories");
    expect(await fs.readFile(path.join(nested, "secret.txt"), "utf8")).toBe("secret\n");
    const nestedAuthorized = await git.prepareSwitchBranch(project.id, "refs/heads/main");
    await git.switchBranch(project.id, "refs/heads/main", {
      confirmationToken: nestedAuthorized.token,
      includeNestedRepositories: true,
    });
    await expect(fs.access(nested)).rejects.toThrow();
  });

  test("discards an unborn HEAD and a dirty remote-tracking switch", async () => {
    const remote = path.join(root, "remote.git");
    await runCommand("git", ["init", "--bare", "-b", "main", remote], { cwd: root });
    await runCommand("git", ["remote", "add", "origin", remote], { cwd: checkout });
    await runCommand("git", ["push", "-u", "origin", "main"], { cwd: checkout });
    await runCommand("git", ["switch", "-c", "feature"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "feature.txt"), "feature\n");
    await runCommand("git", ["add", "feature.txt"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "feature"], { cwd: checkout });
    await runCommand("git", ["push", "-u", "origin", "feature"], { cwd: checkout });
    await runCommand("git", ["switch", "main"], { cwd: checkout });
    await runCommand("git", ["branch", "-D", "feature"], { cwd: checkout });

    const project = await storage.addProject(createProject(remote, checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await coordinator.ensure(project.id);
    const git = new ProjectGitService(storage);
    await git.fetch(project.id, true);
    await fs.writeFile(path.join(checkout, "README.md"), "remote dirty\n");
    await fs.writeFile(path.join(checkout, "scratch.txt"), "scratch\n");
    const remoteConfirmation = await git.prepareSwitchBranch(
      project.id,
      "refs/remotes/origin/feature",
    );
    expect(
      await git.switchBranch(project.id, "refs/remotes/origin/feature", {
        confirmationToken: remoteConfirmation.token,
      }),
    ).toMatchObject({ branch: "feature", trackedChanges: 0, untrackedChanges: 0 });
    expect(await fs.readFile(path.join(checkout, "feature.txt"), "utf8")).toBe("feature\n");
    await expect(fs.access(path.join(checkout, "scratch.txt"))).rejects.toThrow();

    const unborn = path.join(root, "unborn");
    await fs.mkdir(unborn);
    await runCommand("git", ["init", "-b", "main"], { cwd: unborn });
    await runCommand("git", ["config", "user.email", "unborn@example.invalid"], { cwd: unborn });
    await runCommand("git", ["config", "user.name", "Unborn"], { cwd: unborn });
    await fs.writeFile(path.join(unborn, "staged.txt"), "staged\n");
    await runCommand("git", ["add", "staged.txt"], { cwd: unborn });
    await runCommand("git", ["remote", "add", "origin", remote], { cwd: unborn });
    await runCommand("git", ["fetch", "origin"], { cwd: unborn });
    const unbornProject = await storage.addProject(
      createProject("https://example.invalid/unborn.git", unborn),
    );
    await coordinator.ensure(unbornProject.id);
    expect(await git.status(unbornProject.id)).toMatchObject({
      headCommit: null,
      trackedChanges: 1,
    });
    const unbornConfirmation = await git.prepareSwitchBranch(
      unbornProject.id,
      "refs/remotes/origin/main",
    );
    expect(
      await git.switchBranch(unbornProject.id, "refs/remotes/origin/main", {
        confirmationToken: unbornConfirmation.token,
      }),
    ).toMatchObject({
      branch: "main",
      headCommit: expect.any(String),
      trackedChanges: 0,
      untrackedChanges: 0,
    });
    await expect(fs.access(path.join(unborn, "staged.txt"))).rejects.toThrow();
  });

  // Fetching every remote and the dirty-submodule refusal are separate cases:
  // together their real fetches, submodule clone and checkout inspections did
  // not fit one five-second budget under aggregate load (flakes 0461/0480/0490).
  test("fetch covers every configured remote and reports a failing one as stale", async () => {
    const origin = path.join(root, "origin.git");
    const extra = path.join(root, "extra.git");
    const broken = path.join(root, "missing.git");
    // Both remotes already hold `main`; the checkout has no remote-tracking refs
    // until the service fetches, so the refs below prove each remote was fetched.
    await addTemplateRemote("origin", origin);
    await addTemplateRemote("extra", extra);
    const project = await storage.addProject(createProject(origin, checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await coordinator.ensure(project.id);
    const git = new ProjectGitService(storage);
    const fetched = await git.fetch(project.id, true);
    expect(fetched).toMatchObject({
      remoteState: "fresh",
      lastError: null,
    });
    expect(
      fetched.branches.filter((branch) => branch.kind === "remote").map((branch) => branch.ref),
    ).toEqual(["refs/remotes/extra/main", "refs/remotes/origin/main"]);
    await runCommand("git", ["remote", "add", "broken", broken], { cwd: checkout });
    const failed = await git.fetch(project.id, true);
    expect(failed.remoteState).toBe("stale");
    expect(failed.lastError).toBeTruthy();
  });

  test("a dirty submodule needs enhanced confirmation before a discarding switch", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await coordinator.ensure(project.id);
    const git = new ProjectGitService(storage);
    await runCommand("git", ["branch", "other"], { cwd: checkout });
    await runCommand(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", templateSubmodule, "vendor"],
      {
        cwd: checkout,
      },
    );
    await runCommand("git", ["commit", "-m", "add submodule"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "vendor", "lib.txt"), "dirty submodule\n");
    const submoduleConfirmation = await git.prepareSwitchBranch(project.id, "refs/heads/other");
    expect(submoduleConfirmation.requiresEnhancedConfirmation).toBe(true);
    expect(submoduleConfirmation.dirtySubmodules.some((item) => item.includes("vendor"))).toBe(
      true,
    );
    await expect(
      git.switchBranch(project.id, "refs/heads/other", {
        confirmationToken: submoduleConfirmation.token,
      }),
    ).rejects.toThrow("dirty submodules");
    expect(await fs.readFile(path.join(checkout, "vendor", "lib.txt"), "utf8")).toBe(
      "dirty submodule\n",
    );
    const authorized = await git.prepareSwitchBranch(project.id, "refs/heads/other");
    expect(
      await git.switchBranch(project.id, "refs/heads/other", {
        confirmationToken: authorized.token,
        includeNestedRepositories: true,
      }),
    ).toMatchObject({ branch: "other" });
  });

  test("fetch force, fast-forward sync, remote switching, and divergence stay safe", async () => {
    const remote = path.join(root, "remote.git");
    await runCommand("git", ["init", "--bare", "-b", "main", remote], { cwd: root });
    await runCommand("git", ["remote", "add", "origin", remote], { cwd: checkout });
    await runCommand("git", ["push", "-u", "origin", "main"], { cwd: checkout });
    const project = await storage.addProject(createProject(remote, checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await coordinator.ensure(project.id);
    const git = new ProjectGitService(storage);

    await runCommand("git", ["branch", "--unset-upstream"], { cwd: checkout });
    expect(await git.fetch(project.id, true)).toMatchObject({
      upstream: null,
      remote: null,
      remoteState: "fresh",
      lastError: null,
    });
    await runCommand("git", ["branch", "--set-upstream-to", "origin/main", "main"], {
      cwd: checkout,
    });
    await git.status(project.id);
    const baseline = await git.fetch(project.id, true);
    expect((await git.fetch(project.id)).fetchedAt).toBe(baseline.fetchedAt);
    await Bun.sleep(5);
    const [, forced] = await Promise.all([git.fetch(project.id), git.fetch(project.id, true)]);
    expect(Date.parse(forced.fetchedAt!)).toBeGreaterThan(Date.parse(baseline.fetchedAt!));
    const [coalescedFirst, coalescedSecond] = await Promise.all([
      git.fetch(project.id, true),
      git.fetch(project.id, true),
    ]);
    expect(coalescedSecond.fetchedAt).toBe(coalescedFirst.fetchedAt);

    const publisher = path.join(root, "publisher");
    await runCommand("git", ["clone", remote, publisher], { cwd: root });
    await runCommand("git", ["config", "user.email", "publisher@example.invalid"], {
      cwd: publisher,
    });
    await runCommand("git", ["config", "user.name", "Publisher"], { cwd: publisher });
    await fs.writeFile(path.join(publisher, "remote.txt"), "remote\n");
    await runCommand("git", ["add", "remote.txt"], { cwd: publisher });
    await runCommand("git", ["commit", "-m", "remote"], { cwd: publisher });
    await runCommand("git", ["push"], { cwd: publisher });

    expect(await git.fetch(project.id, true)).toMatchObject({ behind: 1, ahead: 0 });
    expect(await git.sync(project.id)).toMatchObject({ behind: 0, ahead: 0 });
    expect(await fs.readFile(path.join(checkout, "remote.txt"), "utf8")).toBe("remote\n");

    await runCommand("git", ["switch", "-c", "feature"], { cwd: publisher });
    await fs.writeFile(path.join(publisher, "feature.txt"), "feature\n");
    await runCommand("git", ["add", "feature.txt"], { cwd: publisher });
    await runCommand("git", ["commit", "-m", "feature"], { cwd: publisher });
    await runCommand("git", ["push", "-u", "origin", "feature"], { cwd: publisher });
    const fetched = await git.fetch(project.id, true);
    expect(fetched.branches.some((branch) => branch.ref === "refs/remotes/origin/feature")).toBe(
      true,
    );
    await runCommand("git", ["branch", "feature", "main"], { cwd: checkout });
    await expect(git.switchBranch(project.id, "refs/remotes/origin/feature")).rejects.toThrow(
      "local branch with that name",
    );
    await runCommand("git", ["branch", "-D", "feature"], { cwd: checkout });
    expect(await git.switchBranch(project.id, "refs/remotes/origin/feature")).toMatchObject({
      branch: "feature",
    });

    await runCommand("git", ["switch", "main"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "local.txt"), "local\n");
    await runCommand("git", ["add", "local.txt"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "local"], { cwd: checkout });
    await runCommand("git", ["switch", "main"], { cwd: publisher });
    await fs.writeFile(path.join(publisher, "second.txt"), "second\n");
    await runCommand("git", ["add", "second.txt"], { cwd: publisher });
    await runCommand("git", ["commit", "-m", "second"], { cwd: publisher });
    await runCommand("git", ["push"], { cwd: publisher });
    expect(await git.fetch(project.id, true)).toMatchObject({ ahead: 1, behind: 1 });
    await expect(git.sync(project.id)).rejects.toThrow("diverged");
  });

  test.each(["wildcard", "absent", "stale"])(
    "launch bases refresh main with a %s tracking ref",
    async (tracking: string) => {
      const remote = path.join(root, "remote.git");
      await runCommand("git", ["init", "--bare", "-b", "main", remote], { cwd: root });
      await runCommand("git", ["remote", "add", "origin", remote], { cwd: checkout });
      await runCommand("git", ["push", "-u", "origin", "main"], { cwd: checkout });
      const project = await storage.addProject(createProject(remote, checkout));
      const git = new ProjectGitService(storage);
      const checkoutHead = async () =>
        (await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();

      if (tracking !== "wildcard") {
        await runCommand(
          "git",
          ["config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other"],
          { cwd: checkout },
        );
        if (tracking === "absent") {
          await runCommand("git", ["update-ref", "-d", "refs/remotes/origin/main"], {
            cwd: checkout,
          });
        }
      }
      // The checkout moves to a feature branch while main advances remotely.
      await runCommand("git", ["switch", "-c", "feature"], { cwd: checkout });
      await fs.writeFile(path.join(checkout, "feature.txt"), "feature\n");
      await runCommand("git", ["add", "feature.txt"], { cwd: checkout });
      await runCommand("git", ["commit", "-m", "feature"], { cwd: checkout });
      const featureHead = await checkoutHead();
      const publisher = path.join(root, "publisher");
      await runCommand("git", ["clone", remote, publisher], { cwd: root });
      await runCommand("git", ["config", "user.email", "publisher@example.invalid"], {
        cwd: publisher,
      });
      await runCommand("git", ["config", "user.name", "Publisher"], { cwd: publisher });
      await fs.writeFile(path.join(publisher, "remote.txt"), "remote\n");
      await runCommand("git", ["add", "remote.txt"], { cwd: publisher });
      await runCommand("git", ["commit", "-m", "remote"], { cwd: publisher });
      await runCommand("git", ["push"], { cwd: publisher });
      const remoteHead = (
        await runCommand("git", ["rev-parse", "HEAD"], { cwd: publisher })
      ).stdout.trim();

      expect(await git.baseBranchTip(project.id, "main")).toEqual({
        branch: "main",
        commit: remoteHead,
        ref: "origin/main",
        fetched: true,
      });
      // Only refs moved: the checkout is still on its own branch and commit.
      expect(await checkoutHead()).toBe(featureHead);

      // Both the base branch's tip and the checkout's HEAD are valid bases.
      expect(await git.branchContainsCommit(project.id, "main", remoteHead)).toEqual({
        contained: true,
      });
      expect(await git.branchContainsCommit(project.id, "feature", featureHead)).toEqual({
        contained: true,
      });
      expect(await git.branchContainsCommit(project.id, "main", featureHead)).toEqual({
        contained: false,
        reason: "the commit is not on main",
      });
      expect(await git.branchContainsCommit(project.id, "missing", remoteHead)).toEqual({
        contained: false,
        reason: "missing does not exist in the project checkout",
      });
      expect(await git.branchContainsCommit(project.id, "main", "f".repeat(40))).toEqual({
        contained: false,
        reason: "the commit does not exist in the project checkout",
      });

      // An unreachable remote still answers from the last fetched ref.
      await runCommand("git", ["remote", "set-url", "origin", path.join(root, "gone.git")], {
        cwd: checkout,
      });
      // A fresh service has no cooldown from the earlier successful fetch.
      const offline = await new ProjectGitService(storage).baseBranchTip(project.id, "main");
      expect(offline).toMatchObject({ commit: remoteHead, ref: "origin/main", fetched: false });
      expect(offline.fetchError).toBeTruthy();

      // A local-only branch falls back to the local ref.
      await runCommand("git", ["remote", "remove", "origin"], { cwd: checkout });
      expect(await git.baseBranchTip(project.id, "feature")).toEqual({
        branch: "feature",
        commit: featureHead,
        ref: "feature",
        fetched: false,
      });
      expect(await git.baseBranchTip(project.id, "nowhere")).toMatchObject({
        commit: null,
        unavailableReason: "Base branch nowhere was not found locally or on origin",
      });
    },
  );

  test("base discovery deduplicates slow fetches and cools down each branch after failure", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    await runCommand("git", ["remote", "add", "origin", path.join(root, "gone.git")], {
      cwd: checkout,
    });
    const git = new ProjectGitService(storage);
    let rejectFetch!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetch = spyOn(remoteGit, "runRemoteGit").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
          markStarted();
        }),
    );
    const now = spyOn(Date, "now");
    try {
      const first = git.baseBranchTip(project.id, "main");
      // Wait for the controlled network boundary, not a timer guess.
      await started;
      const second = git.baseBranchTip(project.id, "main");
      // A checkout status read must complete while the fetch is still pending.
      expect((await git.status(project.id)).branch).toBe("main");
      rejectFetch(new Error("remote unavailable"));
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.fetchError)).toEqual([
        "remote unavailable",
        "remote unavailable",
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await git.baseBranchTip(project.id, "main")).toMatchObject({
        fetched: false,
        fetchError: "remote unavailable",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      await git.baseBranchTip(project.id, "other");
      expect(fetch).toHaveBeenCalledTimes(2);
      now.mockReturnValue(Date.now() + 60_001);
      await git.baseBranchTip(project.id, "main");
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      fetch.mockRestore();
      now.mockRestore();
    }
  });

  test("rejects non-repositories and configured checkouts that are not the repository root", async () => {
    const nested = path.join(checkout, "nested");
    await fs.mkdir(nested);
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", nested),
    );
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    await expect(coordinator.ensure(project.id)).rejects.toThrow("repository root");
    await expect(new ProjectGitService(storage).status(project.id)).rejects.toThrow(
      "repository root",
    );

    const plainDirectory = path.join(root, "plain-directory");
    await fs.mkdir(plainDirectory);
    const plainProject = await storage.addProject(
      createProject("https://example.invalid/plain.git", plainDirectory),
    );
    await expect(coordinator.ensure(plainProject.id)).rejects.toThrow("not a Git repository");
    expect(await storage.getCoordinatorWorkspace(plainProject.id)).toBeNull();
  });

  test("isolates invalid coordinator store records from mail and project reads", async () => {
    seedStore(storage.getDataDir(), "coordinators.json", {
      version: 999,
      revision: 1,
      workspaces: {},
      workflows: [],
    });
    await expect(storage.synchronizeAgentMailboxes()).resolves.toBeUndefined();
    await expect(storage.listAgentMailboxes()).resolves.toBeDefined();
    await expect(storage.listCoordinatorWorkspaces()).resolves.toEqual([]);

    seedStore(storage.getDataDir(), "coordinators.json", {
      version: 1,
      revision: 2,
      workspaces: { wrong: { projectId: "wrong" } },
      workflows: [],
    });
    await expect(storage.synchronizeAgentMailboxes()).resolves.toBeUndefined();
    await expect(storage.listCoordinatorWorkspaces()).resolves.toEqual([]);
  });

  test("preserves pending reservations and old idempotency receipts at store capacity", async () => {
    const associations = Array.from({ length: 2_001 }, (_, index) => ({
      id: `association-${index}`,
      coordinatorId: "coordinator-capacity",
      projectId: `project-${index % 3}`,
      kind: "environment" as const,
      resourceId: index === 0 ? "pending:old" : `environment-${index}`,
      requestId: `request-${index}`,
      payloadHash: `hash-${index}`,
      pending: index === 0,
      createdAt: new Date(index).toISOString(),
    }));
    seedStore(storage.getDataDir(), "coordinators.json", {
      version: 1,
      revision: 1,
      workspaces: {},
      workflows: associations,
    });

    await expect(
      storage.completeCoordinatorWorkflowAssociation("association-0", "environment-old"),
    ).resolves.toMatchObject({ resourceId: "environment-old", pending: false });
    await expect(
      storage.reserveCoordinatorWorkflowAssociation(associations[1]!),
    ).resolves.toMatchObject({ claimed: false, association: { resourceId: "environment-1" } });
    await expect(
      storage.reserveCoordinatorWorkflowAssociation({
        ...associations[1]!,
        id: "new-association",
        requestId: "new-request",
        payloadHash: "new-hash",
      }),
    ).rejects.toThrow("store is full");
  });

  test("creates a local delegated worktree from the exact unpublished commit", async () => {
    const remote = path.join(root, "delegation-remote.git");
    await runCommand("git", ["init", "--bare", "-b", "main", remote], { cwd: root });
    await runCommand("git", ["remote", "add", "origin", remote], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "unpublished.txt"), "local only\n");
    await runCommand("git", ["add", "unpublished.txt"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "unpublished"], { cwd: checkout });
    await runCommand("git", ["push", "origin", "HEAD^:refs/heads/main"], { cwd: checkout });
    const commit = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })
    ).stdout.trim();
    const worktrees = path.join(root, "worktrees");
    const created = await createLocalWorktree(
      checkout,
      "Project",
      "delegated-work",
      commit,
      [],
      worktrees,
    );
    expect(created.createdFromCommit).toBe(commit);
    expect(
      (await runCommand("git", ["rev-parse", "HEAD"], { cwd: created.path })).stdout.trim(),
    ).toBe(commit);
    expect(await fs.readFile(path.join(created.path, "unpublished.txt"), "utf8")).toBe(
      "local only\n",
    );
  });

  test("reconciles a clean container to the exact delegated branch and commit", async () => {
    const commit = "c".repeat(40);
    const calls: string[][] = [];
    const execute = mock(async (_command: string, args: string[]) => {
      calls.push(args);
      const gitCommand = args[5];
      if (gitCommand === "cat-file") return { stdout: "", stderr: "" };
      if (gitCommand === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (gitCommand === "branch") return { stdout: "main\n", stderr: "" };
      if (gitCommand === "status") return { stdout: "", stderr: "" };
      if (gitCommand === "show-ref") throw new Error("missing branch");
      return { stdout: "", stderr: "" };
    });
    await reconcileContainerDelegationBase(
      { branch: "delegated", delegationBaseCommit: commit },
      "container-1",
      execute,
    );
    expect(calls).toContainEqual([
      "exec",
      "container-1",
      "git",
      "-C",
      "/workspace",
      "switch",
      "-c",
      "delegated",
      commit,
    ]);
    expect(calls).toContainEqual([
      "exec",
      "container-1",
      "git",
      "-C",
      "/workspace",
      "reset",
      "--hard",
      commit,
    ]);

    await expect(
      reconcileContainerDelegationBase(
        { branch: "delegated", delegationBaseCommit: commit },
        "container-1",
        async () => Promise.reject(new Error("missing commit")),
      ),
    ).rejects.toThrow("unavailable in the container clone");
    await expect(
      reconcileContainerDelegationBase(
        { branch: "delegated", delegationBaseCommit: commit },
        "container-1",
        async (_command, args) => {
          const gitCommand = args[5];
          if (gitCommand === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
          if (gitCommand === "branch") return { stdout: "main\n", stderr: "" };
          if (gitCommand === "status") return { stdout: "modified\n", stderr: "" };
          return { stdout: "", stderr: "" };
        },
      ),
    ).rejects.toThrow("worker checkout has changes");
  });

  test("persists a delegated container base only after prepared-workspace reconciliation", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const environment = createEnvironment(project.id, {
      name: "container worker",
      environmentType: "containerized",
    });
    environment.containerId = "container-1";
    environment.delegationBaseCommit = "d".repeat(40);
    environment.createdFromCommit = "a".repeat(40);
    await storage.addEnvironment(environment);
    let reconciled = false;

    const updated = await reconcilePreparedContainerDelegation(
      environment,
      { storage } as never,
      async () => {
        expect((await storage.getEnvironment(environment.id))?.createdFromCommit).toBe(
          "a".repeat(40),
        );
        reconciled = true;
      },
    );
    expect(reconciled).toBe(true);
    expect(updated.createdFromCommit).toBe("d".repeat(40));
  });

  test("prepares a fresh container checkout before reconciling its delegated base", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const environment = createEnvironment(project.id, {
      name: "fresh container worker",
      environmentType: "containerized",
    });
    environment.containerId = "container-1";
    environment.delegationBaseCommit = "d".repeat(40);
    const order: string[] = [];

    const prepared = await prepareEnvironmentForSetup(
      environment,
      { storage } as never,
      undefined,
      async (current) => {
        order.push("prepare");
        return { ...current, createdFromCommit: "a".repeat(40) };
      },
      async (current) => {
        order.push("reconcile");
        expect(current.createdFromCommit).toBe("a".repeat(40));
        return { ...current, createdFromCommit: current.delegationBaseCommit };
      },
      async () => null,
    );

    expect(order).toEqual(["prepare", "reconcile"]);
    expect(prepared.createdFromCommit).toBe("d".repeat(40));
  });

  test("reserves workflow starts durably and keeps attachments outside the checkout", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const receipt = await storage.reserveCoordinatorWorkflowAssociation({
      id: "receipt-1",
      coordinatorId: snapshot.workspace.id,
      projectId: project.id,
      conversationId: conversation.id,
      kind: "multi-review",
      resourceId: "pending:request-1",
      requestId: "request-1",
      payloadHash: "hash-1",
      createdAt: new Date().toISOString(),
    });
    expect(receipt).toMatchObject({ claimed: true, association: { pending: true } });
    await storage.completeCoordinatorWorkflowAssociation("receipt-1", "review-1");
    expect(await storage.listCoordinatorWorkflowAssociations(project.id)).toMatchObject([
      { resourceId: "review-1", pending: false },
    ]);
    await expect(
      storage.reserveCoordinatorWorkflowAssociation({
        ...receipt.association,
        payloadHash: "different",
      }),
    ).rejects.toThrow("different payload");

    const attachment = await storage.writeCoordinatorAttachment(
      snapshot.workspace.id,
      conversation.id,
      "pixel.png",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );
    expect(attachment.startsWith(checkout)).toBe(false);
    expect((await fs.stat(attachment)).isFile()).toBe(true);
    const runtimeMarker = path.join(
      storage.getDataDir(),
      "coordinator-runtime",
      snapshot.workspace.id,
      "marker",
    );
    await fs.mkdir(path.dirname(runtimeMarker), { recursive: true });
    await fs.writeFile(runtimeMarker, "private transcript");
    await storage.deleteCoordinatorByProject(project.id);
    await expect(fs.access(attachment)).rejects.toThrow();
    await expect(fs.access(runtimeMarker)).rejects.toThrow();
  });

  test("does not adopt a workflow away from another open conversation", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const first = await coordinator.ensure(project.id);
    const second = await coordinator.createConversation(project.id, "Second");
    const firstConversation = first.workspace.conversations[0]!;
    const secondConversation = second.workspace.conversations.find(
      (item) => item.id !== firstConversation.id,
    )!;
    await storage.saveCoordinatorWorkflowAssociation({
      id: "owned-workflow",
      coordinatorId: first.workspace.id,
      projectId: project.id,
      conversationId: firstConversation.id,
      kind: "build-pipeline",
      resourceId: "pipeline-1",
      requestId: "request-1",
      createdAt: new Date().toISOString(),
    });
    await expect(
      storage.adoptCoordinatorWorkflowAssociation(
        project.id,
        first.workspace.id,
        "owned-workflow",
        secondConversation.id,
      ),
    ).rejects.toThrow("another open conversation");
    await coordinator.closeConversation(project.id, firstConversation.id);
    await expect(
      storage.adoptCoordinatorWorkflowAssociation(
        project.id,
        first.workspace.id,
        "owned-workflow",
        secondConversation.id,
      ),
    ).resolves.toMatchObject({ conversationId: secondConversation.id });
  });

  test("adoption re-delivers a terminal workflow notice to the new conversation", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const initial = await coordinator.ensure(project.id);
    const first = initial.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, first.id, "codex");
    await storage.synchronizeAgentMailboxes();
    const worker = createEnvironment(project.id, { name: "worker", environmentType: "local" });
    worker.status = "running";
    worker.setupPhase = "ready";
    worker.setupScriptsComplete = true;
    await storage.addEnvironment(worker);
    await storage.saveBuildPipeline("pipeline-1", project.id, worker.id, 1, {
      id: "pipeline-1",
      phase: "complete",
    });
    await storage.saveCoordinatorWorkflowAssociation({
      id: "adopted-workflow",
      coordinatorId: initial.workspace.id,
      projectId: project.id,
      conversationId: first.id,
      kind: "build-pipeline",
      resourceId: "pipeline-1",
      requestId: "request-1",
      createdAt: new Date().toISOString(),
    });
    await coordinator.reconcileWorkflowNotifications();
    // Scheduled, inside the short window that lets notices landing together
    // share one wake.
    expect(
      (
        await storage.getAgentMailMailbox(
          coordinatorRuntimeId(initial.workspace.id, first.id),
          first.tabId,
        )
      ).messages.map((message) => [message.placement, message.notice?.state]),
    ).toEqual([["pending-inject", "completed"]]);

    await coordinator.closeConversation(project.id, first.id);
    await storage.synchronizeAgentMailboxes();
    const created = await coordinator.createConversation(project.id, "Adopter");
    const adopter = created.workspace.conversations.find((item) => !item.closedAt)!;
    await storage.synchronizeAgentMailboxes();
    await storage.adoptCoordinatorWorkflowAssociation(
      project.id,
      initial.workspace.id,
      "adopted-workflow",
      adopter.id,
    );
    await coordinator.reconcileWorkflowNotifications();

    // The adopting conversation has no provider yet, so the notice is durable
    // but not yet injectable. Losing it here would mean a workflow that
    // finished while the user was still choosing an agent is never reported.
    expect(
      (await storage.listPendingAgentMailInjects()).some(
        ({ mailbox }) => mailbox.tabId === adopter.tabId,
      ),
    ).toBe(false);
    expect(
      (
        await storage.getAgentMailMailbox(
          coordinatorRuntimeId(initial.workspace.id, adopter.id),
          adopter.tabId,
        )
      ).messages.some((message) => message.placement === "stored"),
    ).toBe(true);

    await coordinator.assignConversationAgent(project.id, adopter.id, "codex");
    expect(
      (await storage.listPendingAgentMailInjects()).some(
        ({ mailbox }) => mailbox.tabId === adopter.tabId,
      ),
    ).toBe(true);
  });

  test("skips terminal workflow records that were already notified", async () => {
    const project = await storage.addProject(
      createProject("https://example.invalid/repo.git", checkout),
    );
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    await storage.saveCoordinatorWorkflowAssociation({
      id: "settled-workflow",
      coordinatorId: snapshot.workspace.id,
      projectId: project.id,
      conversationId: snapshot.workspace.conversations[0]!.id,
      kind: "build-pipeline",
      resourceId: "pipeline-1",
      requestId: "request-1",
      createdAt: new Date().toISOString(),
      lastNotifiedRevision: 5,
      terminalNotifiedAt: new Date().toISOString(),
    });
    const original = storage.getBuildPipeline.bind(storage);
    const read = mock(async () => {
      throw new Error("already-notified record should not be read");
    });
    storage.getBuildPipeline = read;
    try {
      await coordinator.reconcileWorkflowNotifications();
      expect(read).not.toHaveBeenCalled();
    } finally {
      storage.getBuildPipeline = original;
    }
  });

  test("seeds only regular Codex authentication into an isolated home", async () => {
    const source = path.join(root, "source-codex-home");
    const destination = path.join(root, "isolated-codex-home");
    await fs.mkdir(source);
    // An API key login: the access-only copy keeps it as is.
    await fs.writeFile(path.join(source, "auth.json"), '{"OPENAI_API_KEY":"secret"}\n');
    await fs.writeFile(path.join(source, "config.toml"), "developer_instructions='unsafe'\n");
    await prepareCoordinatorCodexHome(destination, source);
    expect(await fs.readFile(path.join(destination, "auth.json"), "utf8")).toContain("secret");
    expect(await fs.readFile(path.join(destination, "auth.json"), "utf8")).not.toContain(
      "private-refresh",
    );
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(destination, "auth.json"))).mode & 0o777).toBe(0o600);
    await expect(fs.access(path.join(destination, "config.toml"))).rejects.toThrow();
    const linkedSource = path.join(root, "linked-codex-home");
    await fs.mkdir(linkedSource);
    await fs.symlink(path.join(source, "auth.json"), path.join(linkedSource, "auth.json"));
    await expect(
      prepareCoordinatorCodexHome(path.join(root, "linked-destination"), linkedSource),
    ).rejects.toThrow("not a symbolic link");
  });
  describe("worker delegations", () => {
    /** A coordinator with one assigned conversation and one running worker. */
    async function delegationFixture(
      options: {
        requestedAt?: string;
        workerActivity?: () => Promise<"idle" | "working" | "waiting" | "unknown">;
        workerBackgroundWork?: () => Promise<boolean>;
        backgroundWorkHoldMs?: number;
        /** The worker was launched with its request as a not-yet-dispatched startup prompt. */
        pendingStartupPrompt?: boolean;
      } = {},
    ): Promise<{
      coordinator: CoordinatorService;
      projectId: string;
      coordinatorId: string;
      conversation: { id: string; tabId: string };
      workerId: string;
      associationId: string;
      runtimeId: string;
    }> {
      const project = await storage.addProject(
        createProject("https://example.invalid/repo.git", checkout),
      );
      const coordinator = new CoordinatorService(
        storage,
        () => ({
          enabled: true,
          running: true,
          error: null,
        }),
        undefined,
        options.workerActivity ? async () => options.workerActivity!() : undefined,
        {
          ...(options.workerBackgroundWork
            ? { workerBackgroundWork: async () => options.workerBackgroundWork!() }
            : {}),
          ...(options.backgroundWorkHoldMs !== undefined
            ? { backgroundWorkHoldMs: options.backgroundWorkHoldMs }
            : {}),
        },
      );
      const initial = await coordinator.ensure(project.id);
      const conversation = initial.workspace.conversations[0]!;
      await coordinator.assignConversationAgent(project.id, conversation.id, "codex");
      const worker = createEnvironment(project.id, { name: "worker", environmentType: "local" });
      worker.status = "running";
      worker.setupPhase = "ready";
      worker.setupScriptsComplete = true;
      if (options.pendingStartupPrompt) {
        worker.pendingAgentLaunch = true;
      }
      await storage.addEnvironment(worker);
      // The worker's addressable mailbox comes from its committed pane layout,
      // exactly as it would in a real environment.
      await storage.savePaneLayout(
        worker.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane",
          root: {
            kind: "leaf",
            id: "pane",
            tabs: [
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: { environmentId: worker.id, platform: "codex" },
              },
            ],
            activeTabId: "startup-agent",
          },
        },
        0,
      );
      await storage.synchronizeAgentMailboxes();
      const association = await storage.saveCoordinatorWorkflowAssociation({
        id: "delegation-association",
        coordinatorId: initial.workspace.id,
        projectId: project.id,
        conversationId: conversation.id,
        kind: "environment",
        resourceId: worker.id,
        requestId: "delegation-request",
        createdAt: new Date().toISOString(),
      });
      await storage.openCoordinatorDelegation(association.id, "startup-agent", options.requestedAt);
      return {
        coordinator,
        projectId: project.id,
        coordinatorId: initial.workspace.id,
        conversation: { id: conversation.id, tabId: conversation.tabId },
        workerId: worker.id,
        associationId: association.id,
        runtimeId: coordinatorRuntimeId(initial.workspace.id, conversation.id),
      };
    }

    async function openAdditionalDelegation(
      fixture: Awaited<ReturnType<typeof delegationFixture>>,
      requestId: string,
      workerTabId = "startup-agent",
    ): Promise<string> {
      const association = await storage.saveCoordinatorWorkflowAssociation({
        id: `association-${requestId}`,
        coordinatorId: fixture.coordinatorId,
        projectId: fixture.projectId,
        conversationId: fixture.conversation.id,
        kind: "environment",
        resourceId: fixture.workerId,
        requestId,
        createdAt: new Date().toISOString(),
      });
      await storage.openCoordinatorDelegation(association.id, workerTabId);
      return association.id;
    }

    async function workerSays(
      fixture: Awaited<ReturnType<typeof delegationFixture>>,
      requestId: string,
      body: string,
    ) {
      return storage.sendAgentMail(
        {
          kind: "tab",
          environmentId: fixture.workerId,
          projectId: fixture.projectId,
          tabId: "startup-agent",
        },
        {
          requestId,
          toEnvironmentId: fixture.runtimeId,
          toTabId: fixture.conversation.tabId,
          body,
        },
      );
    }

    for (const restart of [false, true])
      test(`held reports reach an already persisted replacement main (${restart ? "restart recovery" : "manual creation"})`, async () => {
        const fixture = await delegationFixture();
        const report = await workerSays(fixture, "held-before-close", "The actual worker report.");
        await fixture.coordinator.closeConversation(fixture.projectId, fixture.conversation.id);
        await storage.synchronizeAgentMailboxes();
        let service = fixture.coordinator;
        if (restart) {
          await storage.mutateCoordinatorWorkspace(fixture.projectId, (current) => {
            const old = current!.conversations[0]!;
            return {
              ...current!,
              conversations: [
                ...current!.conversations,
                {
                  ...old,
                  id: "persisted-main",
                  tabId: "persisted-main-tab",
                  logicalSessionKey: "persisted-main-key",
                  mailboxIncarnationId: "persisted-main-incarnation",
                  closedAt: undefined,
                  role: "main",
                  agent: "codex",
                },
              ],
            };
          });
          storage = new StorageService(path.join(root, "data"));
          await storage.init();
          service = new CoordinatorService(storage, () => ({
            enabled: true,
            running: true,
            error: null,
          }));
          await service.reconcileWorkerDelegations();
        } else {
          const snapshot = await service.createConversation(fixture.projectId);
          const main = snapshot.workspace.conversations.find(
            (item) => !item.closedAt && item.role === "main",
          )!;
          await service.assignConversationAgent(fixture.projectId, main.id, "codex");
        }
        await service.settleWorkerDelegations({
          environmentId: fixture.workerId,
          tabId: "startup-agent",
          state: "completed",
        });
        await service.reconcileWorkerDelegations();
        const pending = await storage.listPendingAgentMailInjects();
        expect(pending.map((item) => item.message.id)).toEqual([report.id]);
        expect(pending[0]!.message.from.kind).toBe("tab");
        expect(pending[0]!.mailbox.environmentId === fixture.runtimeId).toBe(false);
        expect(await storage.listUnwokenCoordinatorDelegations()).toHaveLength(0);
      });

    test("a launched worker reading idle before its startup prompt is accepted is not finished", async () => {
      // The startup tab's session exists and reads idle seconds before the
      // provider accepts the delegated prompt; the grace period since the
      // delegation opened has long passed because setup took minutes.
      const fixture = await delegationFixture({
        requestedAt: new Date(0).toISOString(),
        workerActivity: async () => "idle",
        pendingStartupPrompt: true,
      });

      await fixture.coordinator.reconcileWorkerDelegations();
      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        tabId: "startup-agent",
        state: "completed",
      });

      expect((await storage.listOpenCoordinatorDelegations()).map((item) => item.id)).toEqual([
        fixture.associationId,
      ]);
      expect(
        (await storage.listPendingAgentMailInjects()).some(
          ({ message }) => message.from.kind === "system",
        ),
      ).toBe(false);

      // Accepted, then the delegated turn ran and ended: now it has finished.
      await storage.updateEnvironment(fixture.workerId, { pendingAgentLaunch: false });
      await fixture.coordinator.reconcileWorkerDelegations();

      expect(await storage.listOpenCoordinatorDelegations()).toEqual([]);
      const notices = (await storage.listPendingAgentMailInjects()).filter(
        ({ message }) => message.from.kind === "system",
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]!.message.subject).toBe("Worker worker finished");
    });

    test("a worker paused on background work without a report stays delegated", async () => {
      let background = true;
      const fixture = await delegationFixture({
        requestedAt: new Date(0).toISOString(),
        workerActivity: async () => "idle",
        workerBackgroundWork: async () => background,
      });

      await fixture.coordinator.reconcileWorkerDelegations();
      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        tabId: "startup-agent",
        state: "completed",
      });
      expect(await storage.listOpenCoordinatorDelegations()).toHaveLength(1);
      expect(await storage.listPendingAgentMailInjects()).toEqual([]);

      // The background work reported, the worker resumed, and its turn ended.
      background = false;
      await fixture.coordinator.reconcileWorkerDelegations();
      expect(await storage.listOpenCoordinatorDelegations()).toEqual([]);
    });

    test("a report is released even while the worker's background work runs", async () => {
      const fixture = await delegationFixture({
        requestedAt: new Date(0).toISOString(),
        workerActivity: async () => "idle",
        workerBackgroundWork: async () => true,
      });
      const report = await workerSays(fixture, "background-report", "Done; dev server left up.");

      await fixture.coordinator.reconcileWorkerDelegations();

      expect(await storage.listOpenCoordinatorDelegations()).toEqual([]);
      expect((await storage.listPendingAgentMailInjects()).map((item) => item.message.id)).toEqual([
        report.id,
      ]);
    });

    test("a background-work pause is bounded and says why when it runs out", async () => {
      const fixture = await delegationFixture({
        requestedAt: new Date(0).toISOString(),
        workerActivity: async () => "idle",
        workerBackgroundWork: async () => true,
        backgroundWorkHoldMs: 0,
      });

      await fixture.coordinator.reconcileWorkerDelegations();

      expect(await storage.listOpenCoordinatorDelegations()).toEqual([]);
      const notices = (await storage.listPendingAgentMailInjects()).filter(
        ({ message }) => message.from.kind === "system",
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]!.message.body).toContain(
        "work it started in the background was still running",
      );
    });

    test("a stopped worker with an undelivered request remains delegated through startup", async () => {
      const fixture = await delegationFixture();
      await storage.updateEnvironment(fixture.workerId, { status: "stopped" });
      const request = await storage.sendAgentMail(
        {
          kind: "coordinator",
          projectId: fixture.projectId,
          coordinatorId: fixture.coordinatorId,
          conversationId: fixture.conversation.id,
          environmentId: fixture.runtimeId,
          tabId: fixture.conversation.tabId,
        },
        {
          requestId: "pending-start",
          toEnvironmentId: fixture.workerId,
          toTabId: "startup-agent",
          body: "Work after startup.",
        },
      );
      await fixture.coordinator.reconcileWorkerDelegations();
      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        state: "stopped",
      });
      expect(await storage.listOpenCoordinatorDelegations()).toHaveLength(1);
      expect((await storage.listPendingAgentMailInjects()).map((item) => item.message.id)).toEqual([
        request.id,
      ]);
      await storage.updateEnvironment(fixture.workerId, { status: "running" });
      const mailbox = (await storage.getAgentMailMailbox(fixture.workerId, "startup-agent"))
        .descriptor;
      await storage.beginAgentMailInject(mailbox.mailboxId, request.id, mailbox.incarnationId);
      await storage.finishAgentMailInject(mailbox.mailboxId, request.id, { outcome: "accepted" });
      await workerSays(fixture, "finished-after-start", "Finished requested work.");
      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        state: "completed",
      });
      expect(await storage.listOpenCoordinatorDelegations()).toHaveLength(0);
      expect(await storage.listPendingAgentMailInjects()).toHaveLength(1);
    });
    test("holds worker progress and releases it all on one completion", async () => {
      const fixture = await delegationFixture();
      const first = await workerSays(fixture, "progress-1", "Started reading the code.");
      const second = await workerSays(fixture, "progress-2", "Halfway through.");

      // Held, not delivered: neither wakes the coordinator while it waits.
      expect(first.placement).toBe("inject-held");
      expect(first.placementReason).toBe("delegation-running");
      expect(second.placement).toBe("inject-held");
      expect(await storage.listPendingAgentMailInjects()).toEqual([]);

      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        tabId: "startup-agent",
        state: "completed",
      });

      const pending = await storage.listPendingAgentMailInjects();
      expect(pending.map(({ message }) => message.id).toSorted()).toEqual(
        [first.id, second.id].toSorted(),
      );
      // The worker reported, so no synthesized notice is added on top of it.
      expect(pending.some(({ message }) => message.from.kind === "system")).toBe(false);
    });

    test("a silent worker still wakes its coordinator, exactly once", async () => {
      const fixture = await delegationFixture();
      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        tabId: "startup-agent",
        state: "completed",
      });

      const first = await storage.listPendingAgentMailInjects();
      expect(first).toHaveLength(1);
      expect(first[0]!.message.from.kind).toBe("system");
      expect(first[0]!.message.subject).toContain("finished");

      // A second observation of the same edge settles nothing new.
      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        tabId: "startup-agent",
        state: "completed",
      });
      await fixture.coordinator.deliverDelegationWakes();
      expect(await storage.listPendingAgentMailInjects()).toHaveLength(1);
    });

    test("a waiting worker is not a finished worker", async () => {
      const fixture = await delegationFixture();
      await workerSays(fixture, "progress-1", "Blocked on an approval.");
      // `waiting` is not a state settleWorkerDelegations accepts, and the sweep
      // only closes environments that can no longer finish. A running worker
      // asking for an approval is neither.
      await fixture.coordinator.reconcileWorkerDelegations();

      expect(await storage.listPendingAgentMailInjects()).toEqual([]);
      const open = await storage.listOpenCoordinatorDelegations();
      expect(open.map((item) => item.id)).toEqual([fixture.associationId]);
    });

    test("a stopped worker releases its coordinator", async () => {
      const fixture = await delegationFixture();
      await storage.updateEnvironment(fixture.workerId, { status: "stopped" });
      await fixture.coordinator.reconcileWorkerDelegations();

      const pending = await storage.listPendingAgentMailInjects();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.message.subject).toContain("stopped");
      expect(await storage.listOpenCoordinatorDelegations()).toEqual([]);
    });

    test("a wake lost between closing and delivering is retried, not duplicated", async () => {
      const fixture = await delegationFixture();
      // Exactly the durable state a crash between the two writes leaves behind.
      await storage.closeCoordinatorDelegation(fixture.associationId, "completed");
      expect(await storage.listPendingAgentMailInjects()).toEqual([]);

      await fixture.coordinator.deliverDelegationWakes();
      expect(await storage.listPendingAgentMailInjects()).toHaveLength(1);

      await fixture.coordinator.deliverDelegationWakes();
      expect(await storage.listPendingAgentMailInjects()).toHaveLength(1);
    });

    test("a follow-up message opens a fresh delegation, and earns one more wake", async () => {
      const fixture = await delegationFixture();
      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        tabId: "startup-agent",
        state: "completed",
      });
      expect(await storage.listOpenCoordinatorDelegations()).toEqual([]);

      await openAdditionalDelegation(fixture, "second-delegation");
      const report = await workerSays(fixture, "second-report", "Second round done.");
      expect(report.placement).toBe("inject-held");

      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        tabId: "startup-agent",
        state: "completed",
      });
      expect(
        (await storage.listPendingAgentMailInjects()).some(
          ({ message }) => message.id === report.id,
        ),
      ).toBe(true);
    });

    test("mail after the main was closed starts a new main that takes over the delegation", async () => {
      const fixture = await delegationFixture();
      await fixture.coordinator.closeConversation(fixture.projectId, fixture.conversation.id);
      await storage.synchronizeAgentMailboxes();

      // The worker still holds the old conversation's address.
      const report = await storage.sendAgentMail(
        {
          kind: "tab",
          environmentId: fixture.workerId,
          projectId: fixture.projectId,
          tabId: "startup-agent",
        },
        {
          requestId: "report-after-close",
          toEnvironmentId: fixture.runtimeId,
          toTabId: fixture.conversation.tabId,
          body: "Finished.",
        },
      );
      const workspace = (await storage.getCoordinatorWorkspace(fixture.projectId))!;
      const main = workspace.conversations.find((item) => item.role === "main" && !item.closedAt)!;
      expect(main.id).not.toBe(fixture.conversation.id);
      // Started with the project's default agent, nobody at the composer.
      expect(main.agent).toBe("codex");
      expect(report.toEnvironmentId).toBe(coordinatorRuntimeId(fixture.coordinatorId, main.id));
      // The delegation moved with it, so the report is held for one wake.
      expect(report).toMatchObject({
        placement: "inject-held",
        placementReason: "delegation-running",
      });
      expect(
        (await storage.listCoordinatorWorkflowAssociations(fixture.projectId)).find(
          (item) => item.id === fixture.associationId,
        )?.conversationId,
      ).toBe(main.id);

      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        tabId: "startup-agent",
        state: "completed",
      });
      expect(
        (await storage.getAgentMailMessage(report.toEnvironmentId, main.tabId, report.id))
          .placement,
      ).toBe("pending-inject");
    });

    test("a report held as its delegation was settled by a notice is still delivered", async () => {
      const fixture = await delegationFixture();
      const report = await storage.sendAgentMail(
        {
          kind: "tab",
          environmentId: fixture.workerId,
          projectId: fixture.projectId,
          tabId: "startup-agent",
        },
        {
          requestId: "late-report",
          toEnvironmentId: fixture.runtimeId,
          toTabId: fixture.conversation.tabId,
          body: "Done after all.",
        },
      );
      expect(report.placementReason).toBe("delegation-running");
      // The race: the delegation closes and its wake is settled as a notice
      // without ever seeing the report.
      await storage.closeCoordinatorDelegation(fixture.associationId, "completed");
      await storage.prepareCoordinatorDelegationWake(fixture.associationId, "notice");
      await storage.markCoordinatorDelegationWoken(fixture.associationId);

      await fixture.coordinator.reconcileWorkerDelegations();
      expect(
        (
          await storage.getAgentMailMessage(
            fixture.runtimeId,
            fixture.conversation.tabId,
            report.id,
          )
        ).placement,
      ).toBe("pending-inject");
    });

    test("a worker cannot reach a side agent; only the main coordinator can", async () => {
      const fixture = await delegationFixture();
      const second = await fixture.coordinator.createConversation(fixture.projectId);
      const side = second.workspace.conversations.find((item) => item.role === "side")!;
      expect(side.title).toBe("Side 1");
      await fixture.coordinator.assignConversationAgent(fixture.projectId, side.id, "codex");
      await storage.synchronizeAgentMailboxes();

      await expect(
        storage.sendAgentMail(
          {
            kind: "tab",
            environmentId: fixture.workerId,
            projectId: fixture.projectId,
            tabId: "startup-agent",
          },
          {
            requestId: "to-side",
            toEnvironmentId: coordinatorRuntimeId(fixture.coordinatorId, side.id),
            toTabId: side.tabId,
            body: "Unrelated.",
          },
        ),
      ).rejects.toMatchObject({ code: "policy-denied" });
    });

    test("a turn that ended before the request arrived does not report finished", async () => {
      const fixture = await delegationFixture();
      await storage.closeCoordinatorDelegation(fixture.associationId, "completed");
      await storage.markCoordinatorDelegationWoken(fixture.associationId);

      // The coordinator messages the worker. Delivery is pending because the
      // worker is mid-turn on something else.
      await storage.updateAgentMailboxPolicy(fixture.workerId, "startup-agent", {
        inject: "idle",
      });
      const request = await storage.sendAgentMail(
        {
          kind: "coordinator",
          projectId: fixture.projectId,
          coordinatorId: fixture.coordinatorId,
          conversationId: fixture.conversation.id,
          environmentId: fixture.runtimeId,
          tabId: fixture.conversation.tabId,
        },
        {
          requestId: "follow-up",
          toEnvironmentId: fixture.workerId,
          toTabId: "startup-agent",
          body: "Also update the changelog.",
        },
      );
      expect(request.placement).toBe("pending-inject");
      const followUpAssociationId = await openAdditionalDelegation(fixture, "follow-up-delegation");

      // That earlier turn now ends. It never saw the request, so calling it
      // finished would be a "done" for work that has not started.
      await fixture.coordinator.settleWorkerDelegations({
        environmentId: fixture.workerId,
        tabId: "startup-agent",
        state: "completed",
      });
      expect((await storage.listOpenCoordinatorDelegations()).map((item) => item.id)).toEqual([
        followUpAssociationId,
      ]);
      expect(
        (await storage.listPendingAgentMailInjects()).some(
          ({ mailbox }) => mailbox.tabId === fixture.conversation.tabId,
        ),
      ).toBe(false);
    });

    test("unsolicited worker mail is not held", async () => {
      const fixture = await delegationFixture();
      await storage.closeCoordinatorDelegation(fixture.associationId, "completed");
      await storage.markCoordinatorDelegationWoken(fixture.associationId);

      const message = await workerSays(fixture, "unsolicited", "One more thing.");
      expect(message.placement).toBe("pending-inject");
    });

    test("keeps different worker tabs independent and rejects overlap on one tab", async () => {
      const fixture = await delegationFixture();
      const second = await openAdditionalDelegation(fixture, "second-tab", "agent-two");
      expect(
        (await storage.listOpenCoordinatorDelegations()).map((item) => item.id).toSorted(),
      ).toEqual([fixture.associationId, second].toSorted());

      const conflicting = await storage.saveCoordinatorWorkflowAssociation({
        id: "same-tab-conflict",
        coordinatorId: fixture.coordinatorId,
        projectId: fixture.projectId,
        conversationId: fixture.conversation.id,
        kind: "environment",
        resourceId: fixture.workerId,
        requestId: "same-tab-conflict",
        createdAt: new Date().toISOString(),
      });
      await expect(
        storage.openCoordinatorDelegation(conflicting.id, "startup-agent"),
      ).rejects.toThrow("already has an outstanding");
      expect((await storage.listOpenCoordinatorDelegations()).map((item) => item.id)).not.toContain(
        conflicting.id,
      );
    });

    test("settles an old delivered delegation first observed idle after restart", async () => {
      const fixture = await delegationFixture({
        requestedAt: new Date(0).toISOString(),
        workerActivity: async () => "idle",
      });
      const report = await workerSays(fixture, "restart-report", "Finished during downtime.");

      await fixture.coordinator.reconcileWorkerDelegations();

      expect(await storage.listOpenCoordinatorDelegations()).toEqual([]);
      expect(
        (await storage.listPendingAgentMailInjects()).some(
          ({ message }) => message.id === report.id,
        ),
      ).toBe(true);
    });

    test("coalesces concurrent wake delivery without inventing a silent-worker notice", async () => {
      const fixture = await delegationFixture();
      const report = await workerSays(fixture, "concurrent-report", "Real report.");
      await storage.closeCoordinatorDelegation(fixture.associationId, "completed");

      await Promise.all([
        fixture.coordinator.deliverDelegationWakes(),
        fixture.coordinator.deliverDelegationWakes(),
      ]);

      const pending = await storage.listPendingAgentMailInjects();
      expect(pending.filter(({ message }) => message.id === report.id)).toHaveLength(1);
      expect(pending.some(({ message }) => message.from.kind === "system")).toBe(false);
    });

    test("retries a failed report release without stamping or synthesizing a wake", async () => {
      const fixture = await delegationFixture();
      const report = await workerSays(fixture, "retry-report", "Do not orphan me.");
      await storage.closeCoordinatorDelegation(fixture.associationId, "completed");
      const release = storage.releaseDelegationHeldAgentMail.bind(storage);
      let failRelease = true;
      storage.releaseDelegationHeldAgentMail = async (...args) => {
        if (failRelease) throw new Error("disk unavailable");
        return release(...args);
      };

      await expect(fixture.coordinator.deliverDelegationWakes()).rejects.toThrow(
        "disk unavailable",
      );
      let association = (await storage.listCoordinatorWorkflowAssociations(fixture.projectId)).find(
        (item) => item.id === fixture.associationId,
      );
      expect(association?.delegation?.wokenAt).toBeUndefined();
      expect(association?.delegation?.wakeKind).toBe("report");
      expect(await storage.listPendingAgentMailInjects()).toEqual([]);

      failRelease = false;
      await fixture.coordinator.deliverDelegationWakes();
      association = (await storage.listCoordinatorWorkflowAssociations(fixture.projectId)).find(
        (item) => item.id === fixture.associationId,
      );
      expect(association?.delegation?.wokenAt).toBeDefined();
      expect(
        (await storage.listPendingAgentMailInjects()).filter(
          ({ message }) => message.id === report.id,
        ),
      ).toHaveLength(1);
    });

    test("keeps a delegation running when request-delivery state cannot be read", async () => {
      const fixture = await delegationFixture();
      storage.hasUndeliveredCoordinatorRequest = async () => {
        throw new Error("mail store unavailable");
      };

      await expect(
        fixture.coordinator.settleWorkerDelegations({
          environmentId: fixture.workerId,
          tabId: "startup-agent",
          state: "completed",
        }),
      ).rejects.toThrow("mail store unavailable");
      expect((await storage.listOpenCoordinatorDelegations()).map((item) => item.id)).toEqual([
        fixture.associationId,
      ]);
    });
  });
});
