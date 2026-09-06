import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
import { ProjectGitService } from "./project-git-service.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";
import { runCommand } from "./shell.js";
import { prepareCoordinatorCodexHome } from "./commands-servers.js";

describe("project coordinator", () => {
  let root: string;
  let checkout: string;
  let storage: StorageService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-coordinator-"));
    checkout = path.join(root, "checkout");
    await fs.mkdir(checkout);
    await runCommand("git", ["init", "-b", "main"], { cwd: checkout });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
    await runCommand("git", ["config", "user.name", "Coordinator Test"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "README.md"), "initial\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: checkout });
    storage = new StorageService(path.join(root, "data"));
    await storage.init();
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      agentSettings: { ...config.global.agentSettings, defaultAgent: "codex" },
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

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

    for (let index = 0; index < 64; index += 1) {
      const created = await service.createConversation(project.id, `Temporary ${index}`);
      await service.closeConversation(project.id, created.workspace.selectedConversationId!);
    }

    const retained = await service.get(project.id);
    expect(retained!.workspace.conversations).toHaveLength(64);
    expect(
      retained!.workspace.conversations.some(
        (item) => item.id === originalConversationId && !item.closedAt,
      ),
    ).toBe(true);
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

  test("Git status blocks dirty mutations and detects external context changes", async () => {
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
      lastError: {
        operation: "fetch",
        retryable: false,
        message: "The current branch has no configured upstream remote.",
      },
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
    await runCommand("git", ["worktree", "remove", occupiedWorktree], { cwd: checkout });

    const gitDirectory = (
      await runCommand("git", ["rev-parse", "--git-dir"], { cwd: checkout })
    ).stdout.trim();
    await fs.writeFile(
      path.resolve(checkout, gitDirectory, "MERGE_HEAD"),
      `${first.headCommit!}\n`,
    );
    expect(await git.status(project.id)).toMatchObject({ mergeInProgress: true });
    await expect(git.switchBranch(project.id, "refs/heads/main")).rejects.toThrow("current merge");
    await fs.rm(path.resolve(checkout, gitDirectory, "MERGE_HEAD"));

    const rebaseMarker = path.resolve(checkout, gitDirectory, "rebase-merge");
    await fs.mkdir(rebaseMarker);
    expect(await git.status(project.id)).toMatchObject({ rebaseInProgress: true });
    await expect(git.switchBranch(project.id, "refs/heads/main")).rejects.toThrow("current rebase");
    await fs.rm(rebaseMarker, { recursive: true });

    await fs.writeFile(path.join(checkout, "untracked.txt"), "local\n");
    const dirty = await git.status(project.id);
    expect(dirty.untrackedChanges).toBe(1);
    await expect(git.switchBranch(project.id, "refs/heads/main")).rejects.toThrow(
      "Commit or discard",
    );

    await fs.rm(path.join(checkout, "untracked.txt"));
    await runCommand("git", ["switch", "-c", "external"], { cwd: checkout });
    const changed = await git.status(project.id);
    const snapshot = await coordinator.get(project.id);
    expect(changed.branch).toBe("external");
    expect(snapshot!.workspace.repositoryContextRevision).toBeGreaterThan(0);
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
    await fs.writeFile(
      path.join(storage.getDataDir(), "coordinators.json"),
      JSON.stringify({ version: 999, revision: 1, workspaces: {}, workflows: [] }),
    );
    await expect(storage.synchronizeAgentMailboxes()).resolves.toBeUndefined();
    await expect(storage.listAgentMailboxes()).resolves.toBeDefined();
    await expect(storage.listCoordinatorWorkspaces()).resolves.toEqual([]);

    await fs.writeFile(
      path.join(storage.getDataDir(), "coordinators.json"),
      JSON.stringify({
        version: 1,
        revision: 2,
        workspaces: { wrong: { projectId: "wrong" } },
        workflows: [],
      }),
    );
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
    await fs.writeFile(
      path.join(storage.getDataDir(), "coordinators.json"),
      JSON.stringify({ version: 1, revision: 1, workspaces: {}, workflows: associations }),
    );

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
    expect(
      (await storage.listPendingAgentMailInjects()).some(
        ({ mailbox }) => mailbox.tabId === first.tabId,
      ),
    ).toBe(true);

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
    await fs.writeFile(path.join(source, "auth.json"), '{"token":"secret"}\n');
    await fs.writeFile(path.join(source, "config.toml"), "developer_instructions='unsafe'\n");
    await prepareCoordinatorCodexHome(destination, source);
    expect(await fs.readFile(path.join(destination, "auth.json"), "utf8")).toContain("secret");
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
});
