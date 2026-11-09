import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import type { ProviderTranscriptSnapshot } from "../agent-provider-contract.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";

/**
 * Permission and question cards, the full transcript and history paging
 * against a real pinned 2.x server and a scripted local model (no
 * credentials, no remote calls). Shell is set to `ask`, so every shell call
 * parks a permission request; `CALL_TOOL:question {...}` makes the model call
 * the question tool, which parks a form. Run with RUN_LIVE_OPENCODE2=1 and
 * OPENCODE2_CLI_PATH set to the 2.x binary.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
let provider: OpenCode2Provider | undefined;

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!, {
    permissions: [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
    ],
  });
  provider = new OpenCode2Provider(
    new OpenCode2Client({
      baseUrl: fixture.baseUrl,
      password: fixture.password,
      directory: fixture.directory,
    }),
  );
}, 60_000);

afterAll(async () => {
  await provider?.dispose();
  await fixture?.stop();
});

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(150);
  }
}

async function pending(sessionId: string, kind: string): Promise<AgentInteractionRequest> {
  return until(async () =>
    (await provider!.interactions.listPendingInteractions(sessionId)).requests.find(
      (request) => request.kind === kind,
    ),
  );
}

function resolution(
  request: AgentInteractionRequest,
  action: AgentInteractionResolution["action"],
  answers?: Array<{ questionId: string; optionIds?: string[]; freeText?: string }>,
): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    sessionId: request.sessionId,
    action,
    ...(answers
      ? {
          answer: {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            interactionId: request.id,
            sessionId: request.sessionId,
            answers,
          },
        }
      : {}),
    resolvedAt: Date.now() + 1_000,
  };
}

async function idle(sessionId: string) {
  await until(async () => ((await provider!.activity(sessionId)) === "idle" ? true : undefined));
}

type Row = { id: string; role: string; content: string; parts: Array<Record<string, unknown>> };

async function transcript(sessionId: string): Promise<Row[]> {
  const window = (await provider!.transcriptSnapshot(sessionId, {
    limit: 50,
    targetBytes: 4_000_000,
  })) as ProviderTranscriptSnapshot;
  return window.messages as Row[];
}

liveTest(
  "a shell permission is an Allow once card; allowing it runs the tool and the transcript shows its output",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    await p.send(id, "RUN_BASH:echo live-permission-ok", { requestId: "perm-1" });
    const card = await pending(id, "permission");
    expect(await p.activity(id)).toBe("waiting");
    expect(card.presentation).toMatchObject({
      title: "OpenCode asks to run a command",
      confirmLabel: "Allow once",
      declineLabel: "Deny",
    });
    expect(card.presentation.approveForSessionLabel).toBeUndefined();
    expect(card.presentation.body).toContain("echo live-permission-ok");
    // A session grant is refused before anything reaches OpenCode.
    expect(
      (
        await p.interactions.resolveInteraction(
          id,
          card.id,
          resolution(card, "approve-for-session"),
        )
      ).result,
    ).toBe("rejected");
    expect(
      (await p.interactions.resolveInteraction(id, card.id, resolution(card, "answer", []))).result,
    ).toBe("applied");
    await idle(id);
    const rows = await transcript(id);
    const tool = rows
      .flatMap((row) => row.parts)
      .find((part) => part.type === "tool-invocation" && part.toolName === "shell");
    expect(tool).toMatchObject({
      toolState: "success",
      toolArgs: { command: "echo live-permission-ok" },
    });
    expect(String(tool!.toolOutput)).toContain("live-permission-ok");
    // One transcript row per model response: the tool call and the answer are separate rows.
    const assistants = rows.filter((row) => row.role === "assistant");
    expect(assistants.length).toBeGreaterThanOrEqual(2);
  },
  90_000,
);

liveTest(
  "denying a shell permission fails the call, and nothing ran",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    await p.send(id, "RUN_BASH:echo should-not-run", { requestId: "perm-2" });
    const card = await pending(id, "permission");
    expect(
      (await p.interactions.resolveInteraction(id, card.id, resolution(card, "deny"))).result,
    ).toBe("applied");
    await idle(id);
    const rows = await transcript(id);
    const tool = rows.flatMap((row) => row.parts).find((part) => part.toolName === "shell");
    expect(tool?.toolState).toBe("failure");
    expect(String(tool?.toolOutput ?? "")).not.toContain("should-not-run\n");
  },
  90_000,
);

liveTest(
  "an edit permission shows its diff and offers a file rule; the transcript carries the edit card",
  async () => {
    const p = provider!;
    await Bun.write(`${fixture!.directory}/notes.txt`, "alpha\nbeta\n");
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    const edit = { path: "notes.txt", oldString: "beta", newString: "gamma" };
    await p.send(id, `CALL_TOOL:edit ${JSON.stringify(edit)}`, { requestId: "edit-1" });
    const card = await pending(id, "permission");
    expect(card.presentation.title).toBe("OpenCode asks to change a file");
    expect(card.presentation.body).toContain("File: notes.txt");
    expect(card.presentation.body).toContain("+gamma");
    expect(p.interactions.permissionRuleDetail(id, card.id)).toEqual({
      subject: { kind: "file-change", paths: [`${fixture!.directory}/notes.txt`] },
      allowOnceAnswers: [],
    });
    expect(
      (await p.interactions.resolveInteraction(id, card.id, resolution(card, "answer", []))).result,
    ).toBe("applied");
    await idle(id);
    const tool = (await transcript(id))
      .flatMap((row) => row.parts)
      .find((part) => part.toolName === "edit");
    expect(tool).toMatchObject({
      toolState: "success",
      toolDiff: {
        filePath: "notes.txt",
        before: "beta",
        after: "gamma",
        additions: 1,
        deletions: 1,
      },
    });
    expect(await Bun.file(`${fixture!.directory}/notes.txt`).text()).toBe("alpha\ngamma\n");
  },
  90_000,
);

liveTest(
  "a question-tool form is a question card whose answer reaches the model",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    const questions = {
      questions: [
        {
          question: "Which colour should the button be?",
          header: "Colour",
          options: [
            { label: "Blue", description: "Matches the theme" },
            { label: "Red", description: "Stands out" },
          ],
        },
      ],
    };
    await p.send(id, `CALL_TOOL:question ${JSON.stringify(questions)}`, { requestId: "q-1" });
    const card = await pending(id, "question");
    expect(card.presentation.title).toBe("OpenCode needs input");
    const [question] = card.presentation.questions;
    expect(question).toMatchObject({
      prompt: "Which colour should the button be?",
      allowFreeText: true,
    });
    const red = question!.options.find((option) => option.label === "Red")!;
    expect(
      (
        await p.interactions.resolveInteraction(
          id,
          card.id,
          resolution(card, "answer", [{ questionId: question!.id, optionIds: [red.id] }]),
        )
      ).result,
    ).toBe("applied");
    await idle(id);
    const tool = (await transcript(id))
      .flatMap((row) => row.parts)
      .find((part) => part.toolName === "question");
    expect(tool?.toolState).toBe("success");
    expect(String(tool?.toolOutput)).toContain('"Which colour should the button be?"="Red"');
  },
  90_000,
);

liveTest(
  "stopping a turn rejects its parked request, and history pages back to the start",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    for (const [index, text] of ["one", "two", "three"].entries()) {
      await p.send(id, text, { requestId: `h-${index}` });
      await idle(id);
    }
    await p.send(id, "RUN_BASH:echo parked", { requestId: "h-stop" });
    await pending(id, "permission");
    await p.abort(id);
    await idle(id);
    expect((await p.interactions.listPendingInteractions(id)).requests).toEqual([]);
    const rows = await transcript(id);
    expect(rows.at(-1)).toMatchObject({ role: "system", content: "Interrupted by user" });
    const state = await p.sessionState(id);
    expect(state.notices).toEqual([expect.objectContaining({ kind: "stopped" })]);

    const window = (await p.transcriptSnapshot(id, {
      limit: 3,
      targetBytes: 4_000_000,
    })) as ProviderTranscriptSnapshot;
    expect(window.complete).toBe(false);
    const seen = (window.messages as Row[]).map((row) => row.id);
    let cursor = window.historyCursor;
    while (cursor) {
      const page = await p.transcriptPage(id, { cursor, limit: 2, targetBytes: 4_000_000 });
      if (page.status !== "page") throw new Error("history page expired");
      seen.unshift(...(page.messages as Row[]).map((row) => row.id));
      cursor = page.historyCursor;
    }
    expect(seen).toEqual(rows.map((row) => row.id));
  },
  120_000,
);
