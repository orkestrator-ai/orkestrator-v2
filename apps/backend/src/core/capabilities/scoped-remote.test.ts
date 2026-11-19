/**
 * Project setups in a worktree on another machine, over the real node link
 * on the in-memory network: the command node plans and records, the leaf's
 * executor resolves the environment to its own worktree and writes with the
 * same rules as a local worktree (kept out of Git, tracked files never
 * replaced, local changes kept), and a lost answer is observed before
 * anything is sent again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

import { graphBranchWorktreePath } from "@orkestrator/protocol/graphs/run";
import { EnvironmentMutationFence } from "../environment-replacement-fence.js";
import { GraphBranchWorktrees } from "../graph-branch-worktrees.js";
import type { Environment } from "../models.js";
import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";

import {
  settle,
  stopTestNodeNetworks,
  TestNodeNetwork,
} from "../nodes/node-network-test-support.js";
import { runCommand } from "../shell.js";
import {
  addCapabilityNode,
  addSkill,
  disposeCapabilityNodes,
  type CapabilityNode,
} from "./capability-network-test-support.js";

afterEach(async () => {
  await stopTestNodeNetworks();
  await disposeCapabilityNodes();
});

function route(node: CapabilityNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.node.origin };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd })).stdout;
}

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );

/** A repository on the leaf with a tracked agent skill, and a linked worktree of it. */
async function leafWorktree(gram: CapabilityNode): Promise<{ main: string; worktree: string }> {
  const main = path.join(gram.dir, "repo");
  await fs.mkdir(path.join(main, ".claude", "skills", "tracked-skill"), { recursive: true });
  await fs.writeFile(path.join(main, ".claude", "skills", "tracked-skill", "SKILL.md"), "Ours.\n");
  await fs.writeFile(path.join(main, "README.md"), "Repo.\n");
  await git(main, "init", "-q", "-b", "main");
  await git(main, "-c", "user.email=t@example.com", "-c", "user.name=T", "add", ".");
  await git(main, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "init");
  const worktree = path.join(gram.dir, "worktree");
  await git(main, "worktree", "add", "-q", "-b", "feature", worktree);
  return { main, worktree };
}

/** A command node, a leaf with one local worktree of project `proj-g`, and a project toolkit. */
async function fleet() {
  const network = new TestNodeNetwork();
  const desktop = await addCapabilityNode(network, "desktop", { forceRegistration: true });
  const gram = await addCapabilityNode(network, "gram");
  await desktop.node.service.addNode({ routes: [route(gram)], token: gram.node.token });
  await settle(40);
  const { main, worktree } = await leafWorktree(gram);
  gram.environments = [
    {
      id: "env-g",
      name: "feature",
      projectId: "proj-g",
      environmentType: "local",
      worktreePath: worktree,
    },
  ];
  // The command node knows the environment from its read model: no path.
  desktop.remoteEnvironments.set(gram.id, [
    { id: "env-g", name: "feature", projectId: "proj-g", environmentType: "local" },
  ]);
  const toolkit = await desktop.cap.setSetup({ setup: { name: "Project tools" } });
  return { desktop, gram, main, worktree, toolkit };
}

async function addToSetup(
  command: CapabilityNode,
  input: { kind: "skill" | "command"; name: string; content: string; managedId?: string },
  setupId: string,
): Promise<string> {
  const inspection = await command.cap.authorPackage({
    kind: input.kind,
    name: input.name,
    description: `${input.name} ${input.kind}`,
    content: input.content,
    ...(input.managedId ? { managedId: input.managedId } : {}),
  });
  const preview = await command.cap.previewChange({
    change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, setupId },
  });
  await command.cap.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await command.cap.reconciler.idle();
  return inspection.packageId;
}

async function reconcile(command: CapabilityNode): Promise<void> {
  await command.cap.reconciler.reconcileAll("test");
  await command.cap.reconciler.idle();
}

describe("project setups in a worktree on another machine", () => {
  test("are written by that machine into its own worktree, kept out of Git, and removed with the last reference", async () => {
    const { desktop, gram, main, worktree, toolkit } = await fleet();
    const review = await addToSetup(
      desktop,
      { kind: "skill", name: "review", content: "Review carefully." },
      toolkit.id,
    );
    await addToSetup(
      desktop,
      { kind: "skill", name: "tracked-skill", content: "Theirs." },
      toolkit.id,
    );
    await addToSetup(desktop, { kind: "command", name: "deploy", content: "Deploy." }, toolkit.id);
    await desktop.cap.assignSetup({
      scope: "project",
      scopeId: "proj-g",
      setupIds: [toolkit.id],
    });
    await reconcile(desktop);

    expect(
      await fs.readFile(path.join(worktree, ".claude", "skills", "review", "SKILL.md"), "utf8"),
    ).toContain("Review carefully.");
    expect(await exists(path.join(worktree, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
    expect(
      await fs.readFile(path.join(worktree, ".claude", "commands", "deploy.md"), "utf8"),
    ).toContain("Deploy.");
    // Neither machine's shared homes received the project's toolkit.
    expect(await exists(path.join(gram.home, ".claude", "skills", "review"))).toBe(false);
    expect(await exists(path.join(desktop.home, ".claude", "skills", "review"))).toBe(false);

    // The tracked file is untouched and reported on the command node.
    expect(
      await fs.readFile(
        path.join(worktree, ".claude", "skills", "tracked-skill", "SKILL.md"),
        "utf8",
      ),
    ).toBe("Ours.\n");
    const state = await desktop.storage.capabilities.loadCapabilityState();
    const scoped = Object.values(state.receipts).filter(
      (receipt) => receipt.environmentId === "env-g",
    );
    expect(scoped.every((receipt) => receipt.nodeId === gram.id)).toBe(true);
    expect(scoped.find((receipt) => receipt.status === "failed")?.reason ?? "").toContain(
      "tracked in this repository",
    );
    const claudeCopy = scoped.find(
      (receipt) => receipt.packageId === review && receipt.locationId === "project-claude-skills",
    );
    expect(claudeCopy?.id).toStartWith(`${gram.id}|env:env-g|project-claude-skills|`);
    expect(claudeCopy?.status).toBe("installed-next-session");
    // The leaf's executor recorded the same key; its own store holds no receipts.
    const applied = (await gram.storage.capabilities.loadCapabilityExecutorState()).applied;
    expect(applied[claudeCopy!.id]?.digest).toBe(claudeCopy!.digest);
    expect(Object.keys((await gram.storage.capabilities.loadCapabilityState()).receipts)).toEqual(
      [],
    );
    // The "Where available" row names the worktree.
    const detail = await desktop.cap.getPackage({ packageId: review });
    expect(
      detail.availability.find(
        (entry) => entry.target.environmentId === "env-g" && entry.target.provider === "claude",
      )?.status,
    ).toBe("installed-next-session");

    // Git sees nothing: the managed paths are in the leaf repository's info/exclude.
    expect(await git(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const exclude = await fs.readFile(path.join(main, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("# >>> orkestrator capabilities env-env-g >>>");
    expect(exclude).toContain("/.claude/skills/review/");
    expect(exclude).toContain("/.claude/commands/deploy.md");

    // A second pass writes nothing.
    const calls = gram.environmentApplyCalls.length;
    await reconcile(desktop);
    expect(gram.environmentApplyCalls.length).toBe(calls);

    // Removed when no reference remains; the exclude block goes with it.
    await desktop.cap.assignSetup({ scope: "project", scopeId: "proj-g", setupIds: [] });
    await reconcile(desktop);
    expect(await exists(path.join(worktree, ".claude", "skills", "review"))).toBe(false);
    expect(await exists(path.join(worktree, ".claude", "commands", "deploy.md"))).toBe(false);
    expect(
      await fs.readFile(
        path.join(worktree, ".claude", "skills", "tracked-skill", "SKILL.md"),
        "utf8",
      ),
    ).toBe("Ours.\n");
    expect(await fs.readFile(path.join(main, ".git", "info", "exclude"), "utf8")).not.toContain(
      "orkestrator capabilities",
    );
    expect(await git(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(
      Object.values((await desktop.storage.capabilities.loadCapabilityState()).receipts).filter(
        (receipt) => receipt.environmentId === "env-g",
      ),
    ).toEqual([]);
  });

  test("a busy remote worktree keeps its current revision", async () => {
    const { desktop, gram, worktree, toolkit } = await fleet();
    await addToSetup(
      desktop,
      { kind: "skill", name: "review", content: "Original.", managedId: "test-held-review" },
      toolkit.id,
    );
    await desktop.cap.assignSetup({ scope: "project", scopeId: "proj-g", setupIds: [toolkit.id] });
    await reconcile(desktop);
    const skill = path.join(worktree, ".claude/skills/review/SKILL.md");
    gram.busyWorktrees = new Set(["env-g"]);
    await addToSetup(
      desktop,
      { kind: "skill", name: "review", content: "Latest.", managedId: "test-held-review" },
      toolkit.id,
    );
    await reconcile(desktop);
    expect(await fs.readFile(skill, "utf8")).toContain("Original.");
    gram.busyWorktrees = new Set();
    await reconcile(desktop);
    expect(await fs.readFile(skill, "utf8")).toContain("Latest.");
  });

  test("local changes are kept, and a lost answer is observed before anything is sent again", async () => {
    const { desktop, gram, worktree, toolkit } = await fleet();
    await addToSetup(desktop, { kind: "skill", name: "docs", content: "Write docs." }, toolkit.id);
    await desktop.cap.assignSetup({
      scope: "environment",
      scopeId: "env-g",
      setupIds: [toolkit.id],
    });
    await reconcile(desktop);
    const skill = path.join(worktree, ".claude", "skills", "docs", "SKILL.md");
    await fs.writeFile(skill, "Edited on the leaf.");
    await reconcile(desktop);
    expect(await fs.readFile(skill, "utf8")).toBe("Edited on the leaf.");
    const drift = await desktop.cap.listDrift({});
    expect(drift.drift.find((entry) => entry.locationId === "project-claude-skills")?.nodeId).toBe(
      gram.id,
    );

    // The leaf writes the next copy but its answer is lost.
    gram.loseNextEnvironmentAnswer = true;
    const lint = await addToSetup(
      desktop,
      { kind: "skill", name: "lint", content: "Lint it." },
      toolkit.id,
    );
    await desktop.cap.reconciler.idle();
    const lintFile = path.join(worktree, ".claude", "skills", "lint", "SKILL.md");
    expect(await fs.readFile(lintFile, "utf8")).toContain("Lint it.");
    let state = await desktop.storage.capabilities.loadCapabilityState();
    const pending = Object.values(state.receipts).find(
      (receipt) => receipt.packageId === lint && receipt.locationId === "project-claude-skills",
    );
    expect(pending?.outcomeUnknown).toBe(true);
    expect(pending?.status).toBe("outcome-unknown");

    // The next pass reads the bytes back and confirms them without sending the write again.
    const calls = gram.environmentApplyCalls.length;
    await reconcile(desktop);
    state = await desktop.storage.capabilities.loadCapabilityState();
    const confirmed = state.receipts[pending!.id];
    expect(confirmed?.outcomeUnknown).toBeUndefined();
    expect(confirmed?.status).toBe("installed-next-session");
    expect(confirmed?.digest).toBe(
      (await gram.storage.capabilities.loadCapabilityExecutorState()).applied[pending!.id]?.digest,
    );
    expect(
      gram.environmentApplyCalls.slice(calls).some((call) => call.keys.includes(pending!.id)),
    ).toBe(false);
    // The local change is still kept.
    expect(await fs.readFile(skill, "utf8")).toBe("Edited on the leaf.");
  });

  test("the machine resolves the environment itself and refuses anything outside it", async () => {
    const { desktop, gram, worktree, toolkit } = await fleet();
    await addToSetup(desktop, { kind: "skill", name: "docs", content: "Write docs." }, toolkit.id);
    await desktop.cap.assignSetup({
      scope: "project",
      scopeId: "proj-g",
      setupIds: [toolkit.id],
    });
    await reconcile(desktop);
    expect(await exists(path.join(worktree, ".claude", "skills", "docs", "SKILL.md"))).toBe(true);
    const epoch = (await desktop.storage.capabilities.loadCapabilityState()).epoch;
    const target = {
      action: "install",
      kind: "skill",
      packageId: "p",
      componentId: "p#skill:docs",
      componentName: "docs",
      pathOrKey: "",
      artifactDigest: "sha256:x",
    };
    const plan = (environmentId: string, key: string, locationId: string) => ({
      controllerId: desktop.id,
      epoch,
      environmentId,
      targets: [{ ...target, key, locationId }],
    });
    // A key of another environment, or a machine-wide location, is refused.
    await expect(
      gram.cap.executorApplyEnvironmentPlan(
        plan("env-g", `${gram.id}|env:env-other|project-claude-skills|x`, "project-claude-skills"),
      ),
    ).rejects.toThrow("does not belong to this environment");
    await expect(
      gram.cap.executorApplyEnvironmentPlan(
        plan("env-g", `${gram.id}|env:env-g|claude-user-skills|x`, "claude-user-skills"),
      ),
    ).rejects.toThrow("location is not valid");
    // An environment this machine does not have is not written.
    expect(
      await gram.cap.executorApplyEnvironmentPlan(
        plan("env-x", `${gram.id}|env:env-x|project-claude-skills|x`, "project-claude-skills"),
      ),
    ).toEqual({ found: false, results: [] });
    // A stale controller is refused.
    await gram.cap.executorObserve({ controllerId: "bk_newer", epoch: epoch + 5 });
    await expect(
      gram.cap.executorObserveEnvironments({ controllerId: desktop.id, epoch, environments: [] }),
    ).rejects.toThrow("newer command node");
  });

  test("an environment the machine no longer has releases its receipts", async () => {
    const { desktop, gram, toolkit } = await fleet();
    await addToSetup(desktop, { kind: "skill", name: "docs", content: "Write docs." }, toolkit.id);
    await desktop.cap.assignSetup({
      scope: "project",
      scopeId: "proj-g",
      setupIds: [toolkit.id],
    });
    await reconcile(desktop);
    const receipts = async () =>
      Object.values((await desktop.storage.capabilities.loadCapabilityState()).receipts).filter(
        (receipt) => receipt.environmentId === "env-g",
      );
    expect((await receipts()).length).toBeGreaterThan(0);
    // The command node's own pass never forgets another machine's worktree copies.
    await desktop.cap.scoped.runAll();
    expect((await receipts()).length).toBeGreaterThan(0);

    gram.environments = [];
    desktop.remoteEnvironments.set(gram.id, []);
    await reconcile(desktop);
    expect(await receipts()).toEqual([]);
  });
});

describe("a launch in a worktree on a leaf", () => {
  test("a required project copy is verified from the leaf's report, and a local edit blocks the next launch", async () => {
    const { desktop, gram, worktree, toolkit } = await fleet();
    const inspection = await desktop.cap.authorPackage({
      kind: "skill",
      name: "docs",
      description: "docs skill",
      content: "Write docs.",
    });
    const preview = await desktop.cap.previewChange({
      change: {
        kind: "add-to-setup",
        inspectionId: inspection.inspectionId,
        setupId: toolkit.id,
        required: true,
      },
    });
    await desktop.cap.applyChange({
      operationId: preview.operation.id,
      approvedDigest: preview.operation.planDigest,
    });
    await desktop.cap.assignSetup({
      scope: "project",
      scopeId: "proj-g",
      setupIds: [toolkit.id],
    });
    await reconcile(desktop);
    const skill = path.join(worktree, ".claude", "skills", "docs", "SKILL.md");
    expect(await exists(skill)).toBe(true);
    // Nothing machine-wide: only the worktree's copy can satisfy it.
    expect(await exists(path.join(gram.home, ".claude", "skills", "docs"))).toBe(false);

    const launch = {
      environmentId: "env-g",
      projectId: "proj-g",
      provider: "claude" as const,
      sessionKey: "s1",
    };
    const effective = await gram.cap.preflightSession(launch);
    expect(effective?.launchBlockers).toEqual([]);
    const recorded = Object.values(
      (await desktop.storage.capabilities.loadCapabilityState()).launches,
    ).find((row) => row.sessionKey === "s1" && row.target.nodeId === gram.id);
    expect(recorded?.deliveries).toEqual([
      expect.objectContaining({
        packageId: inspection.packageId,
        locationId: "project-claude-skills",
      }),
    ]);

    const componentId = recorded!.deliveries![0]!.componentId;
    const target = { nodeId: gram.id, environmentId: "env-g", sessionId: "s1", provider: "claude" };
    const checked = await desktop.cap.verify({
      target,
      componentIds: [componentId],
      consent: true,
    });
    expect(checked.checks).toContainEqual(
      expect.objectContaining({ componentId, level: "present" }),
    );
    const wrong = await desktop.cap.verify({
      target: { ...target, environmentId: "another-worktree" },
      componentIds: [componentId],
      consent: true,
    });
    expect(wrong.checks).toContainEqual(
      expect.objectContaining({ componentId, level: "requested" }),
    );

    await fs.writeFile(skill, "Edited on the leaf.");
    await expect(gram.cap.preflightSession({ ...launch, sessionKey: "s2" })).rejects.toThrow(
      "cannot have",
    );
  });
});

test("a leaf stages required project and graph-only skills into the isolated branch and retires its excludes", async () => {
  const { desktop, gram, toolkit, worktree, main } = await fleet();
  await addSkill(desktop, "project-only", "Project skill.", {
    setupId: toolkit.id,
    required: true,
  });
  await desktop.cap.assignSetup({ scope: "project", scopeId: "proj-g", setupIds: [toolkit.id] });
  const graph = await desktop.cap.setSetup({ setup: { name: "Graph tools" } });
  await addSkill(desktop, "graph-only", "Graph skill.", { setupId: graph.id, required: true });
  await desktop.cap.assignSetup({
    scope: "graph-node",
    scopeId: "template/node",
    setupIds: [graph.id],
  });
  await reconcile(desktop);
  const relativeWorktree = graphBranchWorktreePath("leaf-run", {
    nodeId: "node",
    iteration: 1,
    branchKey: "branch",
  });
  const branch = path.join(worktree, relativeWorktree);
  await git(main, "worktree", "add", "--detach", branch, "HEAD");
  const launch = {
    environmentId: "env-g",
    projectId: "proj-g",
    provider: "pi" as const,
    templateId: "template",
    graphNode: "template/node",
    relativeWorktree,
    sessionKey: "branch-session",
  };
  await expect(gram.cap.preflightSession(launch)).resolves.toBeTruthy();
  const exclude = path.join(main, ".git/info/exclude");
  expect(await fs.readFile(exclude, "utf8")).toContain("/.pi/skills/graph-only/");
  expect(await git(branch, "status", "--porcelain", "--untracked-files=all")).toBe("");
  const receipts = Object.values(
    (await gram.storage.capabilities.loadCapabilityState()).launches,
  ).find((entry) => entry.sessionKey === launch.sessionKey)?.deliveries;
  expect(receipts).toHaveLength(2);
  const environment = { ...gram.environments[0] } as unknown as Environment;
  const worktrees = new GraphBranchWorktrees({
    storage: { getEnvironment: async () => environment },
    fence: new EnvironmentMutationFence(),
  });
  expect(await worktrees.removeWorktrees(environment, [relativeWorktree])).toBe(0);
  expect(await exists(branch)).toBe(false);
  expect(await fs.readFile(exclude, "utf8")).not.toContain("graph-only");
});
