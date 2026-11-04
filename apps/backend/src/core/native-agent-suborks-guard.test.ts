/**
 * The read-only guard on suborks whose provider cannot enforce read-only itself
 * (Grok, and every other tier below `enforced`): the workspace's Git state is
 * recorded before the call, a change refuses the answer at submit time, and a
 * change still there when the answer is consumed fails that subork. Provider
 * fakes and a scripted probe only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { ReviewWorktreeSnapshot } from "./build-pipeline-prompts.js";
import type { FakeAgentScript } from "./graph-agent-test-support.js";
import {
  answering,
  suborkWorld,
  type SuborkWorld,
  type SuborkWorldOptions,
} from "./native-agent-suborks-test-support.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";

const HEAD = "a".repeat(40);
const SESSION_KEY = nativeAgentSessionStorageKey("e1", "claude", "env-e1:agent");
const worlds: SuborkWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

type Handle = {
  batchId: string;
  next: string;
  suborks: { name: string; agent?: string; status: string; error?: string; guarded?: boolean }[];
};

/** A probe whose answer the test moves, recording which environment it was asked about. */
function scriptedProbe() {
  const state = {
    snapshot: { status: "clean", head: HEAD } as ReviewWorktreeSnapshot,
    asked: [] as string[],
  };
  return {
    state,
    probe: async (environmentId: string) => {
      state.asked.push(environmentId);
      return state.snapshot;
    },
  };
}

async function world(
  probe: (environmentId: string) => Promise<ReviewWorktreeSnapshot>,
  options: SuborkWorldOptions = {},
): Promise<SuborkWorld> {
  const created = await suborkWorld({ ...options, workspaceProbe: probe });
  worlds.push(created);
  return created;
}

describe("the read-only guard", () => {
  test("guards a Grok subork and leaves an enforced one alone; an unchanged tree keeps the answer", async () => {
    const { state, probe } = scriptedProbe();
    const w = await world(probe);
    const started = (await w.ask({
      targets: [{ agent: "grok" }, { agent: "codex" }],
      prompt: "Review.",
    })) as unknown as Handle;
    expect(started.suborks.map((entry) => [entry.agent, entry.guarded === true])).toEqual([
      ["grok", true],
      ["codex", false],
    ]);
    expect(started.next).toContain("Do not change files in this workspace");
    await w.drive(started.batchId);
    const view = w.service.views(SESSION_KEY)![0]!;
    expect(view.suborks.map((entry) => [entry.status, entry.guarded === true])).toEqual([
      ["finished", true],
      ["finished", false],
    ]);
    // The baseline and the certification both read the caller's environment.
    expect(new Set(state.asked)).toEqual(new Set(["e1"]));
    expect((await w.mail())[0]!.body).toContain("grok says hi");
  });

  test("a write at submit time is refused as correctable, and the repaired answer is kept", async () => {
    const { state, probe } = scriptedProbe();
    const refusals: string[] = [];
    const script =
      (agent: AgentPlatform): FakeAgentScript =>
      async (turn, tools) => {
        if (agent !== "grok") return answering()(agent)(turn, tools, undefined as never);
        const capability = turn.options.agentMcp?.workflowResultCapability;
        const submit = () =>
          tools.call("submit_subork_answer", {
            resultKey: turn.options.workflowResultKey,
            ...(capability ? { capability } : {}),
            result: { answer: "grok rates it 7" },
          });
        state.snapshot = { status: "dirty", head: HEAD, paths: ["scratch.txt"] };
        const refused = await submit();
        const content = refused.content as { text?: string }[] | undefined;
        if (refused.isError) refusals.push(content?.[0]?.text ?? "");
        state.snapshot = { status: "clean", head: HEAD };
        await submit();
        return "idle";
      };
    const w = await world(probe, { script });
    const started = (await w.ask({
      targets: [{ agent: "grok" }],
      prompt: "Rate.",
    })) as unknown as Handle;
    await w.drive(started.batchId);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("scratch.txt");
    const view = w.service.views(SESSION_KEY)![0]!;
    expect(view.suborks[0]!.status).toBe("finished");
    expect((await w.mail())[0]!.body).toContain("grok rates it 7");
  });

  test("a change still there when the answer is consumed fails that subork and names it; the others return", async () => {
    const { state, probe } = scriptedProbe();
    const script =
      (agent: AgentPlatform): FakeAgentScript =>
      async (turn, tools, provider) => {
        const end = await answering()(agent)(turn, tools, provider);
        // Written after the answer passed its submit-time check.
        if (agent === "grok") state.snapshot = { status: "dirty", head: HEAD, paths: ["notes.md"] };
        return end;
      };
    const w = await world(probe, { script });
    const started = (await w.ask({
      targets: [{ agent: "codex" }, { agent: "grok" }],
      prompt: "Review.",
    })) as unknown as Handle;
    await w.drive(started.batchId);
    const view = w.service.views(SESSION_KEY)![0]!;
    expect(view.suborks.map((entry) => entry.status)).toEqual(["finished", "failed"]);
    expect(view.suborks[1]!.line).toContain("notes.md");
    const [mail] = await w.mail();
    expect(mail!.body).toContain("codex says hi");
    expect(mail!.body).not.toContain("grok says hi");
    expect(mail!.body).toContain("notes.md");
  });

  test("a guarded target whose starting state cannot be read never starts; the others still run", async () => {
    const w = await world(async () => ({ status: "unknown", reason: "not a Git worktree" }));
    const started = (await w.ask({
      targets: [{ agent: "grok" }, { agent: "codex" }],
      prompt: "Review.",
    })) as unknown as Handle;
    expect(started.suborks[0]).toMatchObject({ name: "Grok Build · Grok Code", status: "failed" });
    expect(started.suborks[0]!.error).toContain("not a Git worktree");
    expect(started.suborks[0]!.error).toContain("Grok Build cannot be stopped from writing");
    expect(started.suborks[1]).toMatchObject({ agent: "codex", status: "starting" });
    await w.drive(started.batchId);
    expect(w.provider("grok").sessions.size).toBe(0);
    expect(w.service.views(SESSION_KEY)![0]!.suborks.map((entry) => entry.status)).toEqual([
      "failed",
      "finished",
    ]);
  });

  test("a restart between the answer and its certification still certifies it", async () => {
    const { state, probe } = scriptedProbe();
    const w = await world(probe);
    const started = (await w.ask({
      targets: [{ agent: "grok" }],
      prompt: "Review.",
    })) as unknown as Handle;
    // One pass sends the turn; the fake's answer lands before the next look.
    await w.service.advanceNow(started.batchId);
    await w.settleProviders();
    state.snapshot = { status: "dirty", head: HEAD, paths: ["left-behind.txt"] };
    await w.restart();
    await w.drive(started.batchId);
    const view = w.service.views(SESSION_KEY)![0]!;
    expect(view.suborks[0]!.status).toBe("failed");
    expect(view.suborks[0]!.line).toContain("left-behind.txt");
  });
});
