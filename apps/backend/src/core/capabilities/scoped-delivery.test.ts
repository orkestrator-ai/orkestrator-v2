/**
 * Scoped deliveries over real files: a project setup written into a real Git
 * worktree (kept out of `git status`, never replacing a tracked file), the
 * manifest staged into a container's inputs revision (digest, label, stale
 * detection and launch verification), and added accounts whose directories
 * are linked to the host's or private.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";

import { readInputsManifest, stagePortableInputs } from "../portable-inputs.js";
import { runCommand } from "../shell.js";
import { StorageService } from "../storage.js";
import { stageContainerCapabilities } from "./container-staging.js";
import { testCapabilityHomes } from "./native-ownership.js";
import type {
  ContainerDeliveryEvidence,
  ScopedAccount,
  ScopedEnvironment,
} from "./scoped-delivery.js";
import { CapabilityService } from "./service.js";

const NODE = "bk_self";

interface Fixture {
  dir: string;
  home: string;
  storage: StorageService;
  service: CapabilityService;
  environments: ScopedEnvironment[];
  accounts: ScopedAccount[];
  container: { evidence: ContainerDeliveryEvidence | null };
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.service.dispose();
    fixture.storage.close?.();
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd })).stdout;
}

async function makeFixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capabilities-scoped-"));
  const home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  const storage = new StorageService(path.join(dir, "data"));
  await storage.init();
  const fixture = {
    dir,
    home,
    storage,
    environments: [],
    accounts: [],
    container: { evidence: null },
  } as unknown as Fixture;
  fixture.service = new CapabilityService({
    storage: { capabilities: storage.capabilities },
    dataDir: path.join(dir, "data"),
    selfId: async () => NODE,
    selfName: async () => "This machine",
    machines: async () => [],
    link: () => null,
    isAuthority: () => true,
    emit: () => undefined,
    homes: () => testCapabilityHomes(home),
    inventory: {
      providers: async () => AGENT_PLATFORMS.map((provider) => ({ provider, available: true })),
    },
    scoped: {
      environments: async () => fixture.environments,
      accounts: async () => fixture.accounts,
      containerDelivery: async () => fixture.container.evidence,
    },
  });
  await fixture.service.init();
  fixtures.push(fixture);
  return fixture;
}

/** A repository with tracked agent files and a linked worktree of it. */
async function repository(fixture: Fixture): Promise<{ main: string; worktree: string }> {
  const main = path.join(fixture.dir, "repo");
  await fs.mkdir(path.join(main, ".claude", "skills", "tracked-skill"), { recursive: true });
  await fs.writeFile(path.join(main, ".claude", "skills", "tracked-skill", "SKILL.md"), "Ours.\n");
  await fs.writeFile(path.join(main, "README.md"), "Repo.\n");
  await git(main, "init", "-q", "-b", "main");
  await git(main, "-c", "user.email=t@example.com", "-c", "user.name=T", "add", ".");
  await git(main, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "init");
  const worktree = path.join(fixture.dir, "worktree");
  await git(main, "worktree", "add", "-q", "-b", "feature", worktree);
  return { main, worktree };
}

async function addToSetup(
  fixture: Fixture,
  input: { kind: "skill" | "command"; name: string; content: string },
  setupId: string,
  required = false,
): Promise<string> {
  const inspection = await fixture.service.authorPackage({
    kind: input.kind,
    name: input.name,
    description: `${input.name} ${input.kind}`,
    content: input.content,
  });
  const preview = await fixture.service.previewChange({
    change: {
      kind: "add-to-setup",
      inspectionId: inspection.inspectionId,
      setupId,
      ...(required ? { required: true } : {}),
    },
  });
  await fixture.service.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await fixture.service.reconciler.idle();
  return inspection.packageId;
}

async function settle(fixture: Fixture): Promise<void> {
  await fixture.service.reconciler.reconcileAll("test");
  await fixture.service.reconciler.idle();
}

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );

describe("project setups in a local worktree", () => {
  test("are written into the worktree, kept out of Git and never replace a tracked file", async () => {
    const fixture = await makeFixture();
    const { main, worktree } = await repository(fixture);
    fixture.environments = [
      {
        id: "env-local",
        name: "feature",
        projectId: "proj-1",
        environmentType: "local",
        worktreePath: worktree,
      },
    ];
    const toolkit = await fixture.service.setSetup({ setup: { name: "Project tools" } });
    const review = await addToSetup(
      fixture,
      { kind: "skill", name: "review", content: "Review carefully." },
      toolkit.id,
    );
    await addToSetup(
      fixture,
      { kind: "skill", name: "tracked-skill", content: "Theirs." },
      toolkit.id,
    );
    await addToSetup(fixture, { kind: "command", name: "deploy", content: "Deploy." }, toolkit.id);
    await fixture.service.assignSetup({
      scope: "project",
      scopeId: "proj-1",
      setupIds: [toolkit.id],
    });
    await settle(fixture);

    // Delivered into the checkout's own directories, not the shared homes.
    expect(
      await fs.readFile(path.join(worktree, ".claude", "skills", "review", "SKILL.md"), "utf8"),
    ).toContain("Review carefully.");
    expect(await exists(path.join(worktree, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
    expect(
      await fs.readFile(path.join(worktree, ".claude", "commands", "deploy.md"), "utf8"),
    ).toContain("Deploy.");
    expect(await exists(path.join(fixture.home, ".claude", "skills", "review"))).toBe(false);

    // The tracked file is untouched and reported.
    expect(
      await fs.readFile(
        path.join(worktree, ".claude", "skills", "tracked-skill", "SKILL.md"),
        "utf8",
      ),
    ).toBe("Ours.\n");
    const state = await fixture.storage.capabilities.loadCapabilityState();
    const tracked = Object.values(state.receipts).find(
      (receipt) => receipt.environmentId === "env-local" && receipt.status === "failed",
    );
    expect(tracked?.locationId).toBe("project-claude-skills");
    expect(tracked?.status).toBe("failed");
    expect(tracked?.reason).toContain("tracked in this repository");

    // Git sees nothing: the managed paths are in the common info/exclude.
    expect(await git(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const exclude = await fs.readFile(path.join(main, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("# >>> orkestrator capabilities env-env-local >>>");
    expect(exclude).toContain("/.claude/skills/review/");
    expect(exclude).toContain("/.claude/commands/deploy.md");
    expect(await fs.readFile(path.join(worktree, ".gitignore"), "utf8").catch(() => null)).toBe(
      null,
    );

    // Receipts are per environment, honest about who else reads the directory.
    const claudeCopy = Object.values(state.receipts).find(
      (receipt) =>
        receipt.environmentId === "env-local" &&
        receipt.packageId === review &&
        receipt.locationId === "project-claude-skills",
    );
    expect(claudeCopy?.status).toBe("installed-next-session");
    expect(claudeCopy?.id).toContain("|env:env-local|");
    expect(claudeCopy?.alsoVisibleTo).toEqual(expect.arrayContaining(["opencode", "pi"]));
    const detail = await fixture.service.getPackage({ packageId: review });
    const cell = detail.availability.find(
      (entry) => entry.target.environmentId === "env-local" && entry.target.provider === "claude",
    );
    expect(cell?.status).toBe("installed-next-session");
    expect(cell?.nodeName).toContain("feature");
    const view = await fixture.service.getEnvironmentDelivery({ environmentId: "env-local" });
    expect(view.kind).toBe("worktree");
    expect(view.items.some((item) => item.locationLabel === ".claude/skills")).toBe(true);

    // A second pass writes nothing new and Git stays clean.
    const before = await fs.stat(path.join(worktree, ".claude", "skills", "review", "SKILL.md"));
    await settle(fixture);
    const after = await fs.stat(path.join(worktree, ".claude", "skills", "review", "SKILL.md"));
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // Removed when no reference remains; the exclude block goes with it.
    await fixture.service.assignSetup({ scope: "project", scopeId: "proj-1", setupIds: [] });
    await settle(fixture);
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
  });

  test("a local edit is kept as local changes, and a required project skill gates launch", async () => {
    const fixture = await makeFixture();
    const { worktree } = await repository(fixture);
    fixture.environments = [
      { id: "env-a", projectId: "proj-1", environmentType: "local", worktreePath: worktree },
    ];
    const toolkit = await fixture.service.setSetup({ setup: { name: "Project tools" } });
    await addToSetup(
      fixture,
      { kind: "skill", name: "docs", content: "Write docs." },
      toolkit.id,
      true,
    );
    await fixture.service.assignSetup({
      scope: "project",
      scopeId: "proj-1",
      setupIds: [toolkit.id],
    });
    await settle(fixture);
    const launch = {
      environmentId: "env-a",
      projectId: "proj-1",
      provider: "claude" as const,
      sessionKey: "s1",
    };
    const allowed = await fixture.service.preflightSession(launch);
    expect(allowed?.launchBlockers).toEqual([]);
    // Another project's environment does not get it.
    const other = await fixture.service.preflightSession({
      ...launch,
      environmentId: "env-b",
      projectId: "proj-2",
      sessionKey: "s2",
    });
    expect(other?.resolvedPackages).toEqual([]);

    const skill = path.join(worktree, ".claude", "skills", "docs", "SKILL.md");
    await fs.writeFile(skill, "Local changes.");
    await settle(fixture);
    expect(await fs.readFile(skill, "utf8")).toBe("Local changes.");
    const drift = await fixture.service.listDrift({});
    expect(drift.drift.some((entry) => entry.locationId === "project-claude-skills")).toBe(true);
    await expect(fixture.service.preflightSession({ ...launch, sessionKey: "s3" })).rejects.toThrow(
      "not verified",
    );
  });
});

describe("container staging", () => {
  test("stages the manifest into the inputs revision, records its digest and detects staleness", async () => {
    const fixture = await makeFixture();
    const toolkit = await fixture.service.setSetup({ setup: { name: "Container tools" } });
    await addToSetup(
      fixture,
      { kind: "skill", name: "lint", content: "Lint it." },
      toolkit.id,
      true,
    );
    await fixture.service.assignSetup({
      scope: "environment",
      scopeId: "env-c",
      setupIds: [toolkit.id],
    });
    fixture.environments = [
      { id: "env-c", projectId: "proj-1", environmentType: "docker", containerId: "ctr-1" },
    ];
    const staging = await fixture.service.prepareContainerStaging({
      environmentId: "env-c",
      projectId: "proj-1",
      providers: ["claude", "codex"],
      stages: ["claude", "codex", "agents-skills"],
    });
    expect(staging.plan.items.map((item) => item.locationId).sort()).toEqual([
      "agents-shared-skills",
      "claude-user-skills",
    ]);

    // Staged through the portable-inputs hook into a revision whose host has no ~/.claude.
    const inputsHome = path.join(fixture.dir, "inputs-home");
    await fs.mkdir(path.join(inputsHome, ".agents", "skills", "lint"), { recursive: true });
    await fs.writeFile(path.join(inputsHome, ".agents", "skills", "lint", "SKILL.md"), "Host's.");
    const staged = await stagePortableInputs(
      path.join(fixture.dir, "data"),
      "env-c",
      new Set(["claude", "shared-skills"] as const),
      { home: inputsHome, agentTest: false },
      undefined,
      undefined,
      { beforeCommit: async (partial) => ({ capabilities: await staging.stage(partial) }) },
    );
    expect(staged.mounts.some((mount) => mount.target === "/claude-config")).toBe(true);
    expect(
      await fs.readFile(
        path.join(staged.directory, "claude-config", "skills", "lint", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Lint it.");
    // The host's own item at that name was staged and kept.
    expect(
      await fs.readFile(path.join(staged.directory, "agents-skills", "lint", "SKILL.md"), "utf8"),
    ).toBe("Host's.");
    const manifest = await readInputsManifest(
      path.join(fixture.dir, "data"),
      "env-c",
      staged.revision,
    );
    const record = manifest?.extensions?.capabilities as {
      digest: string;
      items: Array<{ locationId: string; status: string }>;
    };
    expect(record.digest).toBe(staging.plan.digest);
    expect(record.items.find((item) => item.locationId === "agents-shared-skills")?.status).toBe(
      "collision",
    );

    // The container's label and record verify a required component at launch.
    fixture.container.evidence = {
      containerId: "ctr-1",
      inputsRevision: staged.revision,
      labelDigest: staging.plan.digest,
      record: record as never,
    };
    const launch = {
      environmentId: "env-c",
      projectId: "proj-1",
      environmentIncarnation: "ctr-1",
      provider: "claude" as const,
      sessionKey: "c1",
    };
    expect((await fixture.service.preflightSession(launch))?.launchBlockers).toEqual([]);
    // Codex reads only the shared root here, where the host's own item was kept.
    await expect(
      fixture.service.preflightSession({ ...launch, provider: "codex", sessionKey: "c2" }),
    ).rejects.toThrow("not staged");
    // A label that does not match its record proves nothing.
    fixture.container.evidence = { ...fixture.container.evidence, labelDigest: "sha256:other" };
    await expect(fixture.service.preflightSession({ ...launch, sessionKey: "c3" })).rejects.toThrow(
      "does not belong to this container",
    );
    fixture.container.evidence = {
      ...fixture.container.evidence,
      labelDigest: staging.plan.digest,
    };

    let view = await fixture.service.getEnvironmentDelivery({ environmentId: "env-c" });
    expect(view.kind).toBe("container");
    expect(view.stale).toBe(false);
    expect(view.installedDigest).toBe(staging.plan.digest);

    // A new revision makes the container stale until a rebuild re-stages it.
    await addToSetup(fixture, { kind: "skill", name: "format", content: "Format it." }, toolkit.id);
    view = await fixture.service.getEnvironmentDelivery({ environmentId: "env-c" });
    expect(view.stale).toBe(true);
    expect(view.currentDigest).not.toBe(view.installedDigest);
    expect(view.items.find((item) => item.name === "format")?.status).toBe("restart-required");
  });

  test("a container without a staged manifest refuses a required component", async () => {
    const fixture = await makeFixture();
    await addToSetup(
      fixture,
      { kind: "skill", name: "lint", content: "Lint it." },
      MY_SETUP_ID,
      true,
    );
    await expect(
      fixture.service.preflightSession({
        environmentId: "env-old",
        environmentIncarnation: "ctr-old",
        provider: "claude",
        sessionKey: "o1",
      }),
    ).rejects.toThrow("rebuild the container");
  });

  test("staging never follows a link the host staged and stays within its budget", async () => {
    const fixture = await makeFixture();
    const toolkit = await fixture.service.setSetup({ setup: { name: "Tools" } });
    await addToSetup(fixture, { kind: "skill", name: "lint", content: "Lint." }, toolkit.id);
    await fixture.service.assignSetup({
      scope: "environment",
      scopeId: "env-l",
      setupIds: [toolkit.id],
    });
    const staging = await fixture.service.prepareContainerStaging({
      environmentId: "env-l",
      providers: ["claude"],
      stages: ["claude"],
    });
    const revision = path.join(fixture.dir, "revision");
    await fs.mkdir(path.join(revision, "claude-config", "skills"), { recursive: true });
    await fs.symlink(fixture.home, path.join(revision, "claude-config", "skills", "lint"));
    const record = await stageContainerCapabilities(
      staging.plan,
      fixture.service.artifacts,
      revision,
    );
    expect(record.items[0]?.status).toBe("collision");
    expect(await exists(path.join(fixture.home, "SKILL.md"))).toBe(false);

    // The host's managed copy of the same package is replaced by the planned revision.
    const managed = path.join(fixture.dir, "revision-managed");
    const copy = path.join(managed, "claude-config", "skills", "lint");
    await fs.mkdir(copy, { recursive: true });
    await fs.writeFile(path.join(copy, "SKILL.md"), "Drifted on the host.");
    await fs.writeFile(
      path.join(copy, ".orkestrator-capability.json"),
      JSON.stringify({
        packageId: staging.plan.items[0]!.packageId,
        componentId: "x",
        digest: "y",
      }),
    );
    const replaced = await stageContainerCapabilities(
      staging.plan,
      fixture.service.artifacts,
      managed,
    );
    expect(replaced.items[0]?.status).toBe("staged");
    expect(await fs.readFile(path.join(copy, "SKILL.md"), "utf8")).toContain("Lint.");
  });
});

describe("added accounts", () => {
  test("a linked account uses the host copy; a private one gets its own, and no credential moves", async () => {
    const fixture = await makeFixture();
    await addToSetup(
      fixture,
      { kind: "skill", name: "review", content: "Review." },
      MY_SETUP_ID,
      true,
    );
    const hostSkills = path.join(fixture.home, ".claude", "skills");
    expect(await exists(path.join(hostSkills, "review", "SKILL.md"))).toBe(true);
    const accountHome = path.join(fixture.dir, "accounts", "claude", "acct-1");
    await fs.mkdir(accountHome, { recursive: true });
    await fs.writeFile(path.join(accountHome, ".credentials.json"), '{"token":"account-only"}');
    await fs.symlink(hostSkills, path.join(accountHome, "skills"));
    fixture.accounts = [{ provider: "claude", accountId: "acct-1", home: accountHome }];
    const launch = {
      environmentId: "env-1",
      accountHomeId: "acct-1",
      provider: "claude" as const,
      sessionKey: "a1",
    };

    // Linked: the host's receipt is what the account reads.
    await settle(fixture);
    expect((await fixture.service.preflightSession(launch))?.launchBlockers).toEqual([]);
    let state = await fixture.storage.capabilities.loadCapabilityState();
    expect(Object.values(state.receipts).some((receipt) => receipt.accountHomeId)).toBe(false);

    // Private: the CLI replaced the link with its own directory.
    await fs.unlink(path.join(accountHome, "skills"));
    await fs.mkdir(path.join(accountHome, "skills"));
    await expect(fixture.service.preflightSession({ ...launch, sessionKey: "a2" })).rejects.toThrow(
      "keeps its own copy",
    );
    await settle(fixture);
    expect(
      await fs.readFile(path.join(accountHome, "skills", "review", "SKILL.md"), "utf8"),
    ).toContain("Review.");
    state = await fixture.storage.capabilities.loadCapabilityState();
    const own = Object.values(state.receipts).find((receipt) => receipt.accountHomeId === "acct-1");
    expect(own?.id).toContain("|account:claude:acct-1|claude-user-skills|");
    expect(
      (await fixture.service.preflightSession({ ...launch, sessionKey: "a3" }))?.launchBlockers,
    ).toEqual([]);
    // Nothing of the account's login was read into or out of a provider home.
    expect(await fs.readFile(path.join(accountHome, ".credentials.json"), "utf8")).toBe(
      '{"token":"account-only"}',
    );
    expect(await exists(path.join(fixture.home, ".claude", ".credentials.json"))).toBe(false);

    // Linked again: the account's receipts are forgotten, the host copy is left alone.
    await fs.rm(path.join(accountHome, "skills"), { recursive: true });
    await fs.symlink(hostSkills, path.join(accountHome, "skills"));
    await settle(fixture);
    state = await fixture.storage.capabilities.loadCapabilityState();
    expect(Object.values(state.receipts).some((receipt) => receipt.accountHomeId)).toBe(false);
    expect(await exists(path.join(hostSkills, "review", "SKILL.md"))).toBe(true);
  });
});
