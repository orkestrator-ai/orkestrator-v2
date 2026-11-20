/**
 * A leaf's environments under its command node, over the real node link on
 * the in-memory network: a leaf creating a container stages the command
 * node's manifest (artifacts transferred first), falls back to its last
 * manifest for that container or to nothing when the command node is away
 * (and required components then block with that reason); and an environment
 * card for a worktree or container on another machine is answered from the
 * command node's receipts, with the container's staged record read from the
 * machine that owns it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

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
import { containerPlanDigest, type ContainerCapabilityRecord } from "./container-staging.js";
import {
  COMMAND_NODE_UNREACHABLE_NOTICE,
  parseContainerPlanAnswer,
} from "./environment-authority.js";
import { CONTAINER_UNSTAGED_SUMMARY } from "./scoped-delivery.js";

afterEach(async () => {
  await stopTestNodeNetworks();
  await disposeCapabilityNodes();
});

function route(node: CapabilityNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.node.origin };
}

async function fleet() {
  const network = new TestNodeNetwork();
  const desktop = await addCapabilityNode(network, "desktop", { forceRegistration: true });
  const gram = await addCapabilityNode(network, "gram", {
    launchAnswerTimeoutMs: 2_000,
    leafRequestTimeoutMs: 2_000,
  });
  await desktop.node.service.addNode({ routes: [route(gram)], token: gram.node.token });
  await settle(40);
  return { network, desktop, gram };
}

const CONTAINER = { providers: ["claude"], stages: ["claude"] } as const;

/** Creates (or rebuilds) a container on the leaf: stages its inputs, labels it, records it. */
async function createContainer(
  gram: CapabilityNode,
  environmentId: string,
  containerId: string,
): Promise<{ record: ContainerCapabilityRecord; directory: string; digest: string }> {
  const staging = await gram.environmentsAuthority.prepareContainerStaging({
    environmentId,
    projectId: "proj-c",
    ...CONTAINER,
  });
  const directory = await fs.mkdtemp(path.join(gram.dir, "inputs-"));
  const record = await staging.stage(directory);
  gram.containers.set(environmentId, {
    containerId,
    inputsRevision: path.basename(directory),
    labelDigest: staging.plan.digest,
    record,
  });
  const environment = {
    id: environmentId,
    projectId: "proj-c",
    environmentType: "container",
    containerId,
  };
  gram.environments = [
    ...gram.environments.filter((entry) => entry.id !== environmentId),
    environment,
  ];
  return { record, directory, digest: staging.plan.digest };
}

const containerLaunch = (environmentId: string, containerId: string, sessionKey: string) => ({
  environmentId,
  projectId: "proj-c",
  environmentIncarnation: containerId,
  provider: "claude" as const,
  sessionKey,
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd })).stdout;
}

describe("a leaf's containers", () => {
  test("are staged from the command node's manifest, and the command node's card shows them", async () => {
    const { desktop, gram } = await fleet();
    const { inspection } = await addSkill(desktop, "docs", "Write docs.", { required: true });
    // The leaf's own store holds no setups: only the command node can plan this container.
    expect(Object.keys((await gram.storage.capabilities.loadCapabilityState()).packages)).toEqual(
      [],
    );

    const created = await createContainer(gram, "env-c", "ctr-1");
    expect(
      await fs.readFile(
        path.join(created.directory, "claude-config", "skills", "docs", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Write docs.");
    expect(created.record.items).toEqual([
      expect.objectContaining({
        packageId: inspection.packageId,
        locationId: "claude-user-skills",
        status: "staged",
      }),
    ]);
    expect(created.record.source).toEqual(
      expect.objectContaining({ kind: "command-node", controllerId: desktop.id }),
    );

    // A required component verifies at launch on the leaf against that record.
    const effective = await gram.cap.preflightSession(containerLaunch("env-c", "ctr-1", "s1"));
    expect(effective?.launchBlockers).toEqual([]);
    expect(
      Object.values((await desktop.storage.capabilities.loadCapabilityState()).launches).find(
        (row) => row.sessionKey === "s1" && row.target.nodeId === gram.id,
      )?.deliveries,
    ).toEqual([
      expect.objectContaining({
        packageId: inspection.packageId,
        locationId: "container:claude-user-skills",
      }),
    ]);

    // The command node's card for the leaf's container: its plan, the leaf's record.
    desktop.remoteEnvironments.set(gram.id, [
      { id: "env-c", projectId: "proj-c", environmentType: "container" },
    ]);
    const card = await desktop.environmentsAuthority.getEnvironmentDelivery({
      environmentId: "env-c",
    });
    expect(card).toEqual(
      expect.objectContaining({
        kind: "container",
        nodeId: gram.id,
        stale: false,
        installedDigest: created.digest,
        currentDigest: created.digest,
      }),
    );
    expect(card.items).toEqual([
      expect.objectContaining({ name: "docs", status: "installed-next-session" }),
    ]);

    // The leaf's own window asks its command node for the same card.
    const own = await gram.environmentsAuthority.getEnvironmentDelivery({ environmentId: "env-c" });
    expect(own).toEqual(expect.objectContaining({ kind: "container", stale: false }));
    expect(own.items.map((item) => item.name)).toEqual(["docs"]);
    expect(own.notice).toBeUndefined();

    // A new revision makes the card stale until a rebuild stages it again.
    await addSkill(desktop, "notes", "Take notes.");
    const stale = await desktop.environmentsAuthority.getEnvironmentDelivery({
      environmentId: "env-c",
    });
    expect(stale.stale).toBe(true);
    expect(stale.items.find((item) => item.name === "notes")?.status).toBe("restart-required");
    const rebuilt = await createContainer(gram, "env-c", "ctr-2");
    expect(rebuilt.record.items.map((item) => item.status)).toEqual(["staged", "staged"]);
    expect(
      (await desktop.environmentsAuthority.getEnvironmentDelivery({ environmentId: "env-c" }))
        .stale,
    ).toBe(false);
  });

  test("a cached plan from the previous executor epoch cannot stage", async () => {
    const { desktop, gram } = await fleet();
    await addSkill(desktop, "docs", "Write docs.");
    await createContainer(gram, "env-c", "ctr-1");
    gram.reachable = false;
    gram.cap.executor.admitEpoch("new-controller", 2);
    const rebuilt = await createContainer(gram, "env-c", "ctr-2");
    expect(rebuilt.record.items).toEqual([]);
    expect(rebuilt.record.unstaged?.reason).toBe("command-node-unreachable");
  });

  test("without the command node: the last manifest for that container if its files are here, otherwise nothing, and required components block", async () => {
    const { desktop, gram } = await fleet();
    const { inspection } = await addSkill(desktop, "docs", "Write docs.", { required: true });
    const first = await createContainer(gram, "env-c", "ctr-1");
    await expect(
      gram.cap.preflightSession(containerLaunch("env-c", "ctr-1", "s1")),
    ).resolves.toBeTruthy();

    gram.reachable = false;
    // A rebuild of the same container target stages the cached manifest from local artifacts.
    const cached = await createContainer(gram, "env-c", "ctr-2");
    expect(cached.digest).toBe(first.digest);
    expect(cached.record.items.map((item) => item.status)).toEqual(["staged"]);
    expect(cached.record.source?.kind).toBe("cached");

    // A container never planned before: nothing is staged, and the record says why.
    const fresh = await createContainer(gram, "env-d", "ctr-3");
    expect(fresh.record.items).toEqual([]);
    expect(fresh.record.unstaged).toEqual({ reason: "command-node-unreachable" });
    await expect(fs.readdir(fresh.directory)).resolves.toEqual([]);
    // Its required components block, with that reason, while the command node is away...
    await expect(
      gram.cap.preflightSession(containerLaunch("env-d", "ctr-3", "s2")),
    ).rejects.toThrow(CONTAINER_UNSTAGED_SUMMARY);
    // ...and once it is back, until the container is rebuilt.
    gram.reachable = true;
    await expect(
      gram.cap.preflightSession(containerLaunch("env-d", "ctr-3", "s3")),
    ).rejects.toThrow(CONTAINER_UNSTAGED_SUMMARY);
    desktop.remoteEnvironments.set(gram.id, [
      { id: "env-d", projectId: "proj-c", environmentType: "container" },
    ]);
    const card = await desktop.environmentsAuthority.getEnvironmentDelivery({
      environmentId: "env-d",
    });
    expect(card.notStagedReason).toBe(CONTAINER_UNSTAGED_SUMMARY);
    expect(card.stale).toBe(true);
    expect(card.items[0]?.reason).toContain(CONTAINER_UNSTAGED_SUMMARY);
    const rebuilt = await createContainer(gram, "env-d", "ctr-4");
    expect(rebuilt.record.unstaged).toBeUndefined();
    await expect(
      gram.cap.preflightSession(containerLaunch("env-d", "ctr-4", "s4")),
    ).resolves.toBeTruthy();

    // A cached manifest whose files are gone is not staged.
    gram.reachable = false;
    await gram.cap.artifacts.remove(inspection.artifactDigest);
    const missing = await createContainer(gram, "env-c", "ctr-5");
    expect(missing.record.unstaged).toEqual({ reason: "command-node-unreachable" });

    // The leaf's own card says what it holds, and that it may not be current.
    const own = await gram.environmentsAuthority.getEnvironmentDelivery({ environmentId: "env-c" });
    expect(own.notice).toBe(COMMAND_NODE_UNREACHABLE_NOTICE);
    expect(own.notStagedReason).toBe(CONTAINER_UNSTAGED_SUMMARY);
  });

  test("a stale controller's answer is refused, and a peer cannot name a directory", async () => {
    const { desktop, gram } = await fleet();
    await addSkill(desktop, "docs", "Write docs.");
    await createContainer(gram, "env-c", "ctr-1");
    await gram.cap.executorObserve({ controllerId: "bk_newer", epoch: 7 });
    await expect(
      gram.environmentsAuthority.receiveAnswer({
        controllerId: desktop.id,
        epoch: 1,
        requestId: "cap_leaf_x",
        answer: {},
      }),
    ).resolves.toEqual({ accepted: false });
    await expect(
      gram.environmentsAuthority.containerDeliveryForController({
        controllerId: desktop.id,
        epoch: 1,
        environmentId: "env-c",
      }),
    ).rejects.toThrow();
  });
});

describe("the environment card for another machine's worktree", () => {
  test("is answered from the command node's receipts, also when the leaf's own window asks", async () => {
    const { desktop, gram } = await fleet();
    const main = path.join(gram.dir, "repo");
    await fs.mkdir(main, { recursive: true });
    await fs.writeFile(path.join(main, "README.md"), "Repo.\n");
    await git(main, "init", "-q", "-b", "main");
    await git(main, "-c", "user.email=t@example.com", "-c", "user.name=T", "add", ".");
    await git(main, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "init");
    const worktree = path.join(gram.dir, "worktree");
    await git(main, "worktree", "add", "-q", "-b", "feature", worktree);
    gram.environments = [
      { id: "env-g", projectId: "proj-g", environmentType: "local", worktreePath: worktree },
    ];
    desktop.remoteEnvironments.set(gram.id, [
      { id: "env-g", name: "feature", projectId: "proj-g", environmentType: "local" },
    ]);
    const toolkit = await desktop.cap.setSetup({ setup: { name: "Project tools" } });
    await addSkill(desktop, "review", "Review carefully.", { setupId: toolkit.id });
    await desktop.cap.assignSetup({ scope: "project", scopeId: "proj-g", setupIds: [toolkit.id] });
    await desktop.cap.reconciler.reconcileAll("test");
    await desktop.cap.reconciler.idle();
    expect(
      await fs.readFile(path.join(worktree, ".claude", "skills", "review", "SKILL.md"), "utf8"),
    ).toContain("Review carefully.");

    const card = await desktop.environmentsAuthority.getEnvironmentDelivery({
      environmentId: "env-g",
    });
    expect(card.kind).toBe("worktree");
    expect(card.nodeId).toBe(gram.id);
    expect(card.items.length).toBeGreaterThan(0);
    expect(card.items.every((item) => item.name === "review" && item.status !== "pending")).toBe(
      true,
    );
    expect(card.items.map((item) => item.locationLabel)).toContain(".claude/skills");

    const own = await gram.environmentsAuthority.getEnvironmentDelivery({ environmentId: "env-g" });
    expect(own.kind).toBe("worktree");
    expect(own.items.map((item) => item.locationId).sort()).toEqual(
      card.items.map((item) => item.locationId).sort(),
    );

    // An environment no machine has is nothing; a container whose machine does not answer says so.
    expect(
      (await desktop.environmentsAuthority.getEnvironmentDelivery({ environmentId: "env-x" })).kind,
    ).toBe("none");
    desktop.remoteEnvironments.set(gram.id, [
      { id: "env-g", projectId: "proj-g", environmentType: "local" },
      { id: "env-c", projectId: "proj-g", environmentType: "container" },
    ]);
    gram.answersContainerReads = false;
    const unknown = await desktop.environmentsAuthority.getEnvironmentDelivery({
      environmentId: "env-c",
    });
    expect(unknown.kind).toBe("container");
    expect(unknown.notice).toContain("could not be asked");
  });
});

test("a leaf preserves command items in a shared prompt location and digest", () => {
  const providers = ["pi"] as const;
  const stages = ["pi"];
  const item = {
    key: "pi-user-prompts|component",
    locationId: "pi-user-prompts",
    packageId: "managed:tool",
    packageDigest: `sha256:${"e".repeat(64)}`,
    componentId: "component",
    componentName: "Check",
    kind: "command",
    pathOrKey: "commands/check.md",
    providers: [...providers],
  };
  const digest = containerPlanDigest(providers, stages, [item]);
  const answer = parseContainerPlanAnswer(
    { plan: { digest, items: [item] } },
    { providers, stages },
  );
  expect(answer?.items).toContainEqual(expect.objectContaining({ key: item.key, kind: "command" }));
  expect(answer?.digest).toBe(digest);
});
