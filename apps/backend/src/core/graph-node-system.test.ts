import { afterEach, describe, expect, test } from "bun:test";
import type { GraphRewind } from "@orkestrator/protocol/graphs/run";
import type { GraphActivationReport } from "./graph-run-executors.js";
import { graphNotifyRequestId } from "./graph-system-notify.js";
import { graphPushEffectKey } from "./graph-system-push.js";
import {
  SYSTEM_BRANCH,
  SYSTEM_REPO,
  systemWorld,
  type SystemWorld,
} from "./graph-system-test-support.js";

const worlds: SystemWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

async function world(): Promise<SystemWorld> {
  const created = await systemWorld();
  worlds.push(created);
  return created;
}

function outputsOf(report: GraphActivationReport): Record<string, string> {
  if (report.state !== "complete")
    throw new Error(`expected complete, got ${JSON.stringify(report)}`);
  return report.outputs;
}

async function valueOf(w: SystemWorld, id: string): Promise<unknown> {
  const artifact = await w.artifacts.requireVerified(w.run.id, id);
  return "value" in artifact.body ? artifact.body.value : undefined;
}

function codeRewind(id: string, dropped: number): GraphRewind {
  return {
    id,
    kind: "rewind-code",
    nodeId: "push",
    activation: "push#iter=1#attempt=1",
    iteration: 1,
    requestedAt: "2026-10-29T09:00:00.000Z",
    requestedBy: "user",
    superseded: { activations: [], artifacts: [] },
    code: {
      headRef: "c".repeat(40),
      backupRef: "refs/orkestrator/graph-rewinds/run-1/r1",
      from: "d".repeat(40),
      upstream: `origin/${SYSTEM_BRANCH}`,
      upstreamCommitsDropped: dropped,
    },
  };
}

describe("push-branch", () => {
  test("pushes the commit once and passes the workspace through", async () => {
    const w = await world();
    const report = await w.executor().start(w.context(w.activation("push")));
    const outputs = outputsOf(report);
    expect(w.shell.pushes).toEqual([["origin", `${w.head}:refs/heads/${SYSTEM_BRANCH}`]]);
    expect(await valueOf(w, outputs.code!)).toEqual({
      branch: SYSTEM_BRANCH,
      headRef: w.head,
      baseRef: null,
    });
    // The run's effect journal holds the push, done.
    const effect = await w.storage.graphEffects.getGraphEffect(
      "run-1",
      graphPushEffectKey(SYSTEM_BRANCH, w.head),
    );
    expect(effect).toMatchObject({ state: "done", attempts: 1, action: "push-branch" });
    expect(w.observations).toEqual([`run-1 push#iter=1#attempt=1`]);
  });

  test("a retry and a restart replay the push instead of pushing again", async () => {
    const w = await world();
    const first = outputsOf(await w.executor().start(w.context(w.activation("push"))));
    // Attempt 2 (a retry) in the same process, then a new process (restart) recovering attempt 3.
    outputsOf(await w.executor().start(w.context(w.activation("push", { attempt: 2 }))));
    const restarted = w.executor({ owner: "process-2" });
    const recovered = outputsOf(
      await restarted.recover(w.context(w.activation("push", { attempt: 3 }))),
    );
    expect(w.shell.pushes).toHaveLength(1);
    expect(await valueOf(w, recovered.code!)).toEqual(await valueOf(w, first.code!));
  });

  test("a crash after recording the intent, before the push: pushes once on recovery", async () => {
    const w = await world();
    await w.storage.graphEffects.beginGraphEffect({
      runId: "run-1",
      key: graphPushEffectKey(SYSTEM_BRANCH, w.head),
      action: "push-branch",
      nodeId: "push",
      activation: "push#iter=1#attempt=1",
      owner: "crashed-process",
    });
    outputsOf(await w.executor().recover(w.context(w.activation("push", { state: "running" }))));
    expect(w.shell.pushes).toHaveLength(1);
    expect(
      await w.storage.graphEffects.getGraphEffect(
        "run-1",
        graphPushEffectKey(SYSTEM_BRANCH, w.head),
      ),
    ).toMatchObject({ state: "done", attempts: 2, owner: "process-1" });
  });

  test("a crash after the push, before recording it: the remote is asked and nothing is pushed", async () => {
    const w = await world();
    await w.storage.graphEffects.beginGraphEffect({
      runId: "run-1",
      key: graphPushEffectKey(SYSTEM_BRANCH, w.head),
      action: "push-branch",
      nodeId: "push",
      activation: "push#iter=1#attempt=1",
      owner: "crashed-process",
    });
    w.shell.remote.set(SYSTEM_BRANCH, w.head);
    outputsOf(await w.executor().recover(w.context(w.activation("push", { state: "running" }))));
    expect(w.shell.pushes).toEqual([]);
    const effect = await w.storage.graphEffects.getGraphEffect(
      "run-1",
      graphPushEffectKey(SYSTEM_BRANCH, w.head),
    );
    expect(effect).toMatchObject({ state: "done", data: { alreadyPushed: true } });
  });

  test("a branch that moved is refused, never force-pushed, without a code rewind", async () => {
    const w = await world();
    w.shell.remote.set(SYSTEM_BRANCH, "e".repeat(40));
    w.shell.diverged = true;
    const report = await w.executor().start(w.context(w.activation("push")));
    expect(report).toMatchObject({ state: "failed", cause: "system-error" });
    expect((report as { error: string }).error).toContain("force-pushed only after a code rewind");
    expect(w.shell.pushes).toEqual([["origin", `${w.head}:refs/heads/${SYSTEM_BRANCH}`]]);
    // A plain restart does not allow a force either.
    await w.setRewinds([{ ...codeRewind("r1", 0), kind: "restart", code: undefined }]);
    await w.executor().start(w.context(w.activation("push", { attempt: 2 })));
    expect(w.shell.pushes.every((args) => !args.some((arg) => arg.startsWith("--force")))).toBe(
      true,
    );
  });

  test("force-with-lease only after a code rewind that dropped upstream commits, once", async () => {
    const w = await world();
    const upstreamTip = "e".repeat(40);
    w.shell.remote.set(SYSTEM_BRANCH, upstreamTip);
    w.shell.tracking.set(SYSTEM_BRANCH, upstreamTip);
    w.shell.diverged = true;
    // A rewind that dropped nothing upstream still pushes plainly.
    await w.setRewinds([codeRewind("r0", 0)]);
    expect((await w.executor().start(w.context(w.activation("push")))).state).toBe("failed");
    expect(w.shell.pushes.at(-1)).toEqual(["origin", `${w.head}:refs/heads/${SYSTEM_BRANCH}`]);

    await w.setRewinds([codeRewind("r0", 0), codeRewind("r1", 2)]);
    outputsOf(await w.executor().start(w.context(w.activation("push", { attempt: 2 }))));
    expect(w.shell.pushes.at(-1)).toEqual([
      `--force-with-lease=refs/heads/${SYSTEM_BRANCH}:${upstreamTip}`,
      "origin",
      `${w.head}:refs/heads/${SYSTEM_BRANCH}`,
    ]);
    expect(
      await w.storage.graphEffects.getGraphEffect(
        "run-1",
        graphPushEffectKey(SYSTEM_BRANCH, w.head),
      ),
    ).toMatchObject({ state: "done", data: { forcedForRewind: "r1" } });

    // The next commit after that push is a plain push again.
    const next = "f".repeat(40);
    w.shell.commits.add(next);
    const workspace = await w.artifacts.putValue({
      runId: "run-1",
      type: "workspace@1",
      producer: { nodeId: "$input", activation: "$input", port: "later" },
      value: { branch: SYSTEM_BRANCH, headRef: next, baseRef: null },
    });
    const activation = {
      ...w.activation("push", { iteration: 2 }),
      inputs: { code: workspace.id },
    };
    outputsOf(await w.executor().start(w.context(activation)));
    expect(w.shell.pushes.at(-1)).toEqual(["origin", `${next}:refs/heads/${SYSTEM_BRANCH}`]);
  });

  test("errors are one bounded line without credentials", async () => {
    const w = await world();
    w.shell.remote.set(SYSTEM_BRANCH, "e".repeat(40));
    w.shell.diverged = true;
    await w.setRewinds([codeRewind("r1", 2)]);
    w.shell.remoteGit = async (_environment, command) => {
      if (command === "ls-remote") return `${"e".repeat(40)}\trefs/heads/${SYSTEM_BRANCH}\n`;
      throw new Error(
        "Command failed: git push\nfatal: unable to access 'https://user:ghp_secret123@github.com/acme/widgets/': timeout",
      );
    };
    const report = await w.executor().start(w.context(w.activation("push")));
    expect(report).toMatchObject({ state: "failed", cause: "provider-error" });
    const error = (report as { error: string }).error;
    expect(error).not.toContain("ghp_secret123");
    expect(error).not.toContain("user:");
    expect(error.length).toBeLessThan(400);
  });

  test("a workspace on another branch, or a commit the repository lacks, is refused", async () => {
    const w = await world();
    const other = await w.artifacts.putValue({
      runId: "run-1",
      type: "workspace@1",
      producer: { nodeId: "$input", activation: "$input", port: "other" },
      value: { branch: "main", headRef: w.head, baseRef: null },
    });
    const report = await w
      .executor()
      .start(w.context({ ...w.activation("push"), inputs: { code: other.id } }));
    expect((report as { error: string }).error).toContain("not the run's branch");
    expect(w.shell.pushes).toEqual([]);
  });
});

describe("open-pull-request", () => {
  test("pushes, opens the pull request and reports its merge state", async () => {
    const w = await world();
    w.shell.unknownMergeabilityReads = 2;
    const outputs = outputsOf(await w.executor().start(w.context(w.activation("pr"))));
    expect(w.shell.pushes).toHaveLength(1);
    expect(w.shell.creates).toHaveLength(1);
    expect(w.shell.creates[0]).toEqual(
      expect.arrayContaining(["--repo", SYSTEM_REPO, "--head", SYSTEM_BRANCH, "--base", "main"]),
    );
    const url = `https://github.com/${SYSTEM_REPO}/pull/1`;
    expect(await valueOf(w, outputs.pr!)).toEqual({
      status: "created",
      url,
      summary: "Opened the pull request against main.",
    });
    expect(await valueOf(w, outputs.state!)).toEqual({
      url,
      state: "open",
      hasMergeConflicts: false,
    });
    const environment = await w.storage.getEnvironment("e1");
    expect(environment).toMatchObject({ prUrl: url, prState: "open", hasMergeConflicts: false });
    expect(w.monitor.watches).toBe(1);
  });

  test("idempotent per run and branch: a retry or restart never opens a second one", async () => {
    const w = await world();
    outputsOf(await w.executor().start(w.context(w.activation("pr"))));
    outputsOf(
      await w
        .executor({ owner: "process-2" })
        .recover(w.context(w.activation("pr", { attempt: 2 }))),
    );
    expect(w.shell.creates).toHaveLength(1);
    expect(w.shell.pushes).toHaveLength(1);
    expect(w.shell.edits).toHaveLength(0);
  });

  test("a failed create is retried without pushing again", async () => {
    const w = await world();
    w.shell.failNextCreate = true;
    const failed = await w.executor().start(w.context(w.activation("pr")));
    expect(failed).toMatchObject({ state: "failed", cause: "provider-error" });
    outputsOf(await w.executor().start(w.context(w.activation("pr", { attempt: 2 }))));
    expect(w.shell.pushes).toHaveLength(1);
    expect(w.shell.creates).toHaveLength(2);
    expect(w.shell.pulls).toHaveLength(1);
  });

  test("a crash after GitHub opened it: the open pull request is adopted, not duplicated", async () => {
    const w = await world();
    await w.storage.graphEffects.beginGraphEffect({
      runId: "run-1",
      key: `pr:${SYSTEM_BRANCH}`,
      action: "open-pull-request",
      nodeId: "pr",
      activation: "pr#iter=1#attempt=1",
      owner: "crashed-process",
    });
    const url = w.shell.addPull("OPEN", {
      title: "Add CSV export",
      body: "## Summary\n\nExports reports as CSV.",
    });
    const outputs = outputsOf(
      await w.executor().recover(w.context(w.activation("pr", { state: "running" }))),
    );
    expect(w.shell.creates).toEqual([]);
    expect(((await valueOf(w, outputs.pr!)) as { url: string }).url).toBe(url);
  });

  test("updates an open pull request the branch already has, setting the description", async () => {
    const w = await world();
    const url = w.shell.addPull("OPEN");
    const outputs = outputsOf(await w.executor().start(w.context(w.activation("pr"))));
    expect(w.shell.creates).toEqual([]);
    expect(w.shell.edits).toHaveLength(1);
    expect(w.shell.pulls[0]).toMatchObject({ title: "Add CSV export" });
    expect(await valueOf(w, outputs.pr!)).toMatchObject({
      url,
      summary: "Updated the branch's pull request, set its title and description.",
    });
  });

  test("Ship's rule: the run's closed pull request is reopened and updated, a merged one replaced", async () => {
    const w = await world();
    outputsOf(await w.executor().start(w.context(w.activation("pr"))));
    w.shell.pulls[0]!.state = "CLOSED";
    w.shell.pulls[0]!.title = "Changed elsewhere";
    const second = outputsOf(
      await w.executor().start(w.context(w.activation("pr", { iteration: 2 }))),
    );
    expect(w.shell.reopens).toEqual([`https://github.com/${SYSTEM_REPO}/pull/1`]);
    expect(w.shell.creates).toHaveLength(1);
    expect(await valueOf(w, second.pr!)).toMatchObject({
      summary: "Updated the branch's pull request, reopened it, set its title and description.",
    });

    w.shell.pulls[0]!.state = "MERGED";
    const third = outputsOf(
      await w.executor().start(w.context(w.activation("pr", { iteration: 3 }))),
    );
    expect(w.shell.creates).toHaveLength(2);
    expect(((await valueOf(w, third.pr!)) as { url: string }).url).toBe(
      `https://github.com/${SYSTEM_REPO}/pull/2`,
    );
  });

  test("reports merge conflicts for 108's conflict gate", async () => {
    const w = await world();
    const url = w.shell.addPull("OPEN", { mergeable: "CONFLICTING" });
    const outputs = outputsOf(await w.executor().start(w.context(w.activation("pr"))));
    expect(await valueOf(w, outputs.state!)).toEqual({
      url,
      state: "open",
      hasMergeConflicts: true,
    });
  });
});

describe("notify", () => {
  test("mails the coordinator once per slot, with the text input appended", async () => {
    const w = await world();
    outputsOf(await w.executor().start(w.context(w.activation("notify"))));
    outputsOf(
      await w
        .executor({ owner: "process-2" })
        .recover(w.context(w.activation("notify", { attempt: 2 }))),
    );
    expect(w.mail.delivered.size).toBe(1);
    expect(w.mail.sent[0]).toEqual({
      sender: { kind: "system", projectId: "p1", source: "workflow", resourceId: "run-1" },
      input: {
        requestId: graphNotifyRequestId("run-1", "notify#iter=1"),
        toEnvironmentId: "coordinator",
        toTabId: "",
        subject: "Graph run",
        body: "The run reached notify.\n\nExtra detail.",
      },
    });
    // The retry replayed the journal; agent mail was not even asked again.
    expect(w.mail.sent).toHaveLength(1);
  });

  test("a crash after sending: the same request id makes the resend a replay", async () => {
    const w = await world();
    await w.storage.graphEffects.beginGraphEffect({
      runId: "run-1",
      key: "notify:notify#iter=1",
      action: "notify",
      nodeId: "notify",
      activation: "notify#iter=1#attempt=1",
      owner: "crashed-process",
    });
    w.mail.delivered.set(graphNotifyRequestId("run-1", "notify#iter=1"), {
      id: "message-1",
    } as never);
    outputsOf(await w.executor().recover(w.context(w.activation("notify", { state: "running" }))));
    expect(w.mail.delivered.size).toBe(1);
  });

  test("another iteration is another message", async () => {
    const w = await world();
    outputsOf(await w.executor().start(w.context(w.activation("notify"))));
    outputsOf(await w.executor().start(w.context(w.activation("notify", { iteration: 2 }))));
    expect(w.mail.delivered.size).toBe(2);
  });
});

describe("the executor's job lifecycle", () => {
  test("a slow job is reported running, wakes its activation when it settles, then completes", async () => {
    const w = await world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = w.shell.remoteGit.bind(w.shell);
    w.shell.remoteGit = async (...args) => {
      if (args[1] === "push") await gate;
      return original(...args);
    };
    const executor = w.executor({ inlineWaitMs: 5 });
    const started = await executor.start(w.context(w.activation("push")));
    expect(started).toMatchObject({ state: "running" });
    expect(executor.runningJobs()).toBe(1);
    // Observing again neither starts a second job nor pushes.
    expect(
      await executor.observe(w.context(w.activation("push", { state: "running" }))),
    ).toMatchObject({
      state: "unchanged",
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.observations).toEqual(["run-1 push#iter=1#attempt=1"]);
    outputsOf(await executor.observe(w.context(w.activation("push", { state: "running" }))));
    expect(w.shell.pushes).toHaveLength(1);
    expect(executor.runningJobs()).toBe(0);
  });

  test("cancel stops a running job and reports cancelled once it settled", async () => {
    const w = await world();
    w.shell.remoteGit = (_environment, _command, _args, options) =>
      new Promise<string>((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const executor = w.executor({ inlineWaitMs: 5 });
    const activation = w.activation("push");
    expect(await executor.start(w.context(activation))).toMatchObject({ state: "running" });
    const running = { ...activation, state: "running" as const };
    expect(await executor.cancel(w.context(running), "run-cancelled")).toEqual({
      state: "unchanged",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await executor.cancel(w.context(running), "run-cancelled")).toEqual({
      state: "cancelled",
    });
    expect(executor.runningJobs()).toBe(0);
    expect(w.shell.pushes).toEqual([]);
  });

  test("a node of another kind is refused", async () => {
    const w = await world();
    const context = w.context(w.activation("push"));
    const report = w
      .executor()
      .start({ ...context, node: { ...context.node, kind: "gate" } as never });
    await expect(report).rejects.toThrow("non-system node");
  });
});
