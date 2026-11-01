import { describe, expect, mock, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_HANDOFF_VERSION,
  createAgentHandoffSnapshot,
  parseAgentHandoffSnapshot,
  type AgentHandoffMessage,
} from "@orkestrator/protocol/agent-handoff";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  agentHandoffChangeSummaries,
  createAgentHandoff,
  parseCreateAgentHandoffInput,
  sweepAgentHandoffs,
  type CreateAgentHandoffInput,
} from "./agent-handoffs.js";
import type { ChangeTrackingService } from "./change-tracking/index.js";
import type { CommandContext } from "./commands-context.js";
import { AGENT_HANDOFF_PRUNE_GRACE_MS } from "./storage-shared-pane-layout.js";
import { StorageService } from "./storage.js";

const INPUT: CreateAgentHandoffInput = {
  handoffId: "handoff-new",
  environmentId: "e1",
  sourceAgent: "claude",
  logicalSessionKey: "env-e1:tab-source",
  sourceSessionId: "claude-session",
  destinationProvider: "codex",
};

const ROW: AgentHandoffMessage = {
  id: "row-1",
  role: "user",
  content: "Fix the failing build",
  parts: [{ type: "text", content: "Fix the failing build" }],
  createdAt: "2026-07-27T10:00:00.000Z",
};

async function withStorage(run: (storage: StorageService) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-agent-handoffs-create-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "e1",
    projectId: "proj-1",
    name: "e1",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
  });
  try {
    await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function contextFor(
  storage: StorageService,
  messages: unknown[],
  changeTracking: unknown = null,
): Pick<CommandContext, "storage" | "nativeAgents" | "runtime"> {
  return {
    storage,
    nativeAgents: {
      handoffs: {
        readSourceTranscript: mock(async () => ({
          providerSessionId: INPUT.sourceSessionId,
          messages,
        })),
      },
    } as never,
    runtime: { changeTracking } as never,
  };
}

describe("createAgentHandoff", () => {
  test("builds from the provider's whole transcript, keeping every row the window would drop", async () => {
    await withStorage(async (storage) => {
      const rows = Array.from({ length: 400 }, (_, index) => ({
        ...ROW,
        id: `row-${index}`,
        content: `message ${index}`,
        parts: [{ type: "text", content: `message ${index}` }],
      }));
      const record = await createAgentHandoff(contextFor(storage, rows), INPUT);
      expect(record).toMatchObject({
        id: "handoff-new",
        environmentId: "e1",
        version: AGENT_HANDOFF_VERSION,
      });
      const snapshot = parseAgentHandoffSnapshot(record.snapshot)!;
      expect(snapshot.stats.messageCount).toBe(400);
      expect(snapshot.messages[0]!.id).toBe("row-0");
      expect(snapshot.sourceProvider).toBe("claude");
      expect(snapshot.destinationProvider).toBe("codex");
      expect(await storage.getAgentHandoff("handoff-new")).toEqual(record);
    });
  });

  test("a row with a part kind the handoff does not carry keeps its other parts", async () => {
    await withStorage(async (storage) => {
      const record = await createAgentHandoff(
        contextFor(storage, [
          {
            ...ROW,
            parts: [...ROW.parts, { type: "status", content: "compacted" }],
          },
          "not a row",
        ]),
        INPUT,
      );
      const snapshot = parseAgentHandoffSnapshot(record.snapshot)!;
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0]!.parts).toEqual(ROW.parts);
    });
  });

  test("retrying the same id returns the committed record without reading again", async () => {
    await withStorage(async (storage) => {
      const context = contextFor(storage, [ROW]);
      const first = await createAgentHandoff(context, INPUT);
      const second = await createAgentHandoff(context, INPUT);
      expect(second).toEqual(first);
      expect(context.nativeAgents!.handoffs.readSourceTranscript).toHaveBeenCalledTimes(1);
    });
  });

  test("chaining composes the prior snapshot and removes its carrier from the provider row", async () => {
    await withStorage(async (storage) => {
      const prior = createAgentHandoffSnapshot({
        id: "handoff-prior",
        environmentId: "e1",
        sourceProvider: "codex",
        destinationProvider: "claude",
        sourceSessionId: "codex-session",
        messages: [ROW],
      });
      await storage.saveAgentHandoff(prior.id, "e1", AGENT_HANDOFF_VERSION, { ...prior });
      const record = await createAgentHandoff(
        contextFor(storage, [
          {
            ...ROW,
            id: "carrier-row",
            content: `${prior.bootstrapPrompt}\n\nThe handoff above is prior conversation history. Respond to the user's new message below as the latest message in that continued conversation:\n\nNext step`,
            parts: [],
          },
        ]),
        { ...INPUT, priorHandoffId: "handoff-prior" },
      );
      const snapshot = parseAgentHandoffSnapshot(record.snapshot)!;
      expect(snapshot.messages.map(({ id, content }) => ({ id, content }))).toEqual([
        { id: ROW.id, content: ROW.content },
        { id: "carrier-row", content: "Next step" },
      ]);
    });
  });

  test("refuses a prior transfer that is missing or belongs elsewhere", async () => {
    await withStorage(async (storage) => {
      await expect(
        createAgentHandoff(contextFor(storage, [ROW]), {
          ...INPUT,
          priorHandoffId: "no-such-handoff",
        }),
      ).rejects.toThrow("could not be loaded");
      const foreign = createAgentHandoffSnapshot({
        id: "handoff-foreign",
        environmentId: "e1",
        sourceProvider: "claude",
        // Delivered to Codex, so a Claude source cannot have continued from it.
        destinationProvider: "codex",
        sourceSessionId: "s",
        messages: [ROW],
      });
      await storage.saveAgentHandoff(foreign.id, "e1", AGENT_HANDOFF_VERSION, { ...foreign });
      await expect(
        createAgentHandoff(contextFor(storage, [ROW]), {
          ...INPUT,
          priorHandoffId: foreign.id,
        }),
      ).rejects.toThrow("does not belong to this session");
    });
  });

  test("refuses an empty conversation and a transfer to the same agent", async () => {
    await withStorage(async (storage) => {
      await expect(createAgentHandoff(contextFor(storage, []), INPUT)).rejects.toThrow(
        "no history to transfer",
      );
      await expect(
        createAgentHandoff(contextFor(storage, [ROW]), {
          ...INPUT,
          destinationProvider: "claude",
        }),
      ).rejects.toThrow("already running it");
      expect(await storage.getAgentHandoff("handoff-new")).toBeNull();
    });
  });

  test("a change-tracking failure costs the numbers, not the transfer", async () => {
    await withStorage(async (storage) => {
      const tracking = {
        getToolPresentations: () => {
          throw new Error("ledger closed");
        },
      };
      const warn = console.warn;
      console.warn = () => {};
      try {
        const record = await createAgentHandoff(
          contextFor(
            storage,
            [
              {
                ...ROW,
                role: "assistant",
                parts: [{ type: "tool-invocation", content: "", toolUseId: "call-1" }],
              },
            ],
            tracking,
          ),
          INPUT,
        );
        expect(parseAgentHandoffSnapshot(record.snapshot)?.changeSummaries).toBeUndefined();
      } finally {
        console.warn = warn;
      }
    });
  });
});

describe("agentHandoffChangeSummaries", () => {
  test("serializes each measured call's selected measurements, primary first", () => {
    const serialize = mock((ids: readonly string[]) => ({
      text: `measured ${ids.join("+")}`,
      measurementIds: [...ids],
      truncated: false,
    }));
    const tracking = {
      getToolPresentations: ({ callIds }: { callIds: readonly string[] }) => ({
        presentations: Object.fromEntries(
          callIds.map((callId) => [
            callId,
            callId === "measured"
              ? {
                  changes: [
                    { resourceKey: "secondary", prominence: "secondary" },
                    { resourceKey: "primary", prominence: "primary" },
                  ],
                }
              : null,
          ]),
        ),
        projections: {
          primary: { measurementId: "m-primary" },
          secondary: { measurementId: "m-secondary" },
        },
      }),
      handoff: { serialize },
    } as unknown as ChangeTrackingService;
    const summaries = agentHandoffChangeSummaries(
      tracking,
      { environmentId: "e1", provider: "claude", conversationId: "s" },
      [
        {
          ...ROW,
          parts: [
            { type: "tool-invocation", content: "", toolUseId: "measured" },
            { type: "tool-invocation", content: "", toolUseId: "unmeasured" },
          ],
        },
      ],
    );
    // An unmeasured call is absent, and the carrier then says "not measured".
    expect(summaries).toEqual({ measured: "measured m-primary+m-secondary" });
  });
});

describe("parseCreateAgentHandoffInput", () => {
  test("accepts a complete request and drops blank optional fields", () => {
    expect(
      parseCreateAgentHandoffInput({ ...INPUT, sourceTitle: "", priorHandoffId: undefined }),
    ).toEqual(INPUT);
  });

  test("refuses unknown platforms and blank identifiers", () => {
    expect(() => parseCreateAgentHandoffInput({ ...INPUT, sourceAgent: "gpt" })).toThrow(
      "provider is invalid",
    );
    expect(() => parseCreateAgentHandoffInput({ ...INPUT, handoffId: " " })).toThrow("handoffId");
  });
});

describe("backend handoff pruning", () => {
  const layoutWith = (handoffIds: string[]) => ({
    version: PANE_LAYOUT_VERSION,
    containerId: null,
    activePaneId: "default",
    root: {
      kind: "leaf",
      id: "default",
      tabs: handoffIds.map((id) => ({
        id: `tab-${id}`,
        type: "agent-native",
        agentHandoffId: id,
      })),
      activeTabId: handoffIds[0] ? `tab-${handoffIds[0]}` : null,
    },
  });

  const save = (storage: StorageService, id: string) =>
    storage.saveAgentHandoff(id, "e1", AGENT_HANDOFF_VERSION, { id });

  test("a new handoff survives a layout written before its tab, until the grace passes", async () => {
    await withStorage(async (storage) => {
      await save(storage, "handoff-new");
      const now = Date.now();
      expect(await sweepAgentHandoffs(storage, { e1: layoutWith([]) as never }, now)).toBe(0);
      expect(await storage.getAgentHandoff("handoff-new")).not.toBeNull();

      const later = now + AGENT_HANDOFF_PRUNE_GRACE_MS + 1_000;
      expect(await sweepAgentHandoffs(storage, { e1: layoutWith([]) as never }, later)).toBe(1);
      expect(await storage.getAgentHandoff("handoff-new")).toBeNull();
    });
  });

  test("the sweep does its work at most once per grace window", async () => {
    await withStorage(async (storage) => {
      await save(storage, "handoff-stale");
      const list = spyOn(storage.agentHandoffs, "agentHandoffEnvironmentIds");
      const now = Date.now() + AGENT_HANDOFF_PRUNE_GRACE_MS + 1_000;
      expect(await sweepAgentHandoffs(storage, { e1: layoutWith([]) as never }, now)).toBe(1);
      expect(await sweepAgentHandoffs(storage, { e1: layoutWith([]) as never }, now + 1)).toBe(0);
      expect(list).toHaveBeenCalledTimes(1);
      list.mockRestore();
    });
  });

  test("the sweep keeps what a layout references", async () => {
    await withStorage(async (storage) => {
      await save(storage, "handoff-live");
      const later = Date.now() + AGENT_HANDOFF_PRUNE_GRACE_MS + 1_000;
      expect(
        await sweepAgentHandoffs(storage, { e1: layoutWith(["handoff-live"]) as never }, later),
      ).toBe(0);
      expect(await storage.getAgentHandoff("handoff-live")).not.toBeNull();
    });
  });

  test("a layout write dropping a reference inside the grace window leaves it for the sweep", async () => {
    await withStorage(async (storage) => {
      await save(storage, "handoff-recent");
      const withTab = await storage.savePaneLayout(
        "e1",
        layoutWith(["handoff-recent"]) as never,
        0,
      );
      await storage.savePaneLayout("e1", layoutWith([]) as never, withTab.revision);
      expect(await storage.getAgentHandoff("handoff-recent")).not.toBeNull();
    });
  });

  test("a layout write dropping a reference past the grace window prunes it", async () => {
    await withStorage(async (storage) => {
      await save(storage, "handoff-old");
      const withTab = await storage.savePaneLayout("e1", layoutWith(["handoff-old"]) as never, 0);
      const later = spyOn(Date, "now").mockReturnValue(
        Date.now() + AGENT_HANDOFF_PRUNE_GRACE_MS + 1_000,
      );
      try {
        await storage.savePaneLayout("e1", layoutWith([]) as never, withTab.revision);
      } finally {
        later.mockRestore();
      }
      expect(await storage.getAgentHandoff("handoff-old")).toBeNull();
    });
  });

  test("a write that keeps every reference never touches the handoff store", async () => {
    await withStorage(async (storage) => {
      await save(storage, "handoff-kept");
      const first = await storage.savePaneLayout("e1", layoutWith(["handoff-kept"]) as never, 0);
      const prune = spyOn(storage.agentHandoffs, "pruneAgentHandoffs");
      await storage.savePaneLayout("e1", layoutWith(["handoff-kept"]) as never, first.revision);
      expect(prune).not.toHaveBeenCalled();
      prune.mockRestore();
    });
  });

  test("a client's stale copy of a layout cannot prune another client's new tab", async () => {
    await withStorage(async (storage) => {
      // Client A opens a transfer; client B, holding the older tree, writes next.
      await save(storage, "handoff-from-a");
      const base = layoutWith([]) as never;
      const first = await storage.savePaneLayout("e1", base, 0);
      const withTab = await storage.applyPaneLayoutIntent(
        "e1",
        base,
        layoutWith(["handoff-from-a"]) as never,
      );
      expect(withTab.revision).toBe(first.revision + 1);
      const fromB = await storage.applyPaneLayoutIntent("e1", base, {
        ...(layoutWith([]) as object),
        activePaneId: "default",
      } as never);
      expect(JSON.stringify(fromB.root)).toContain("handoff-from-a");
      expect(await storage.getAgentHandoff("handoff-from-a")).not.toBeNull();
    });
  });

  test("marking a tab consumed is idempotent and ignores a tab that moved on", async () => {
    await withStorage(async (storage) => {
      await storage.savePaneLayout("e1", layoutWith(["handoff-a"]) as never, 0);
      const before = (await storage.getPaneLayout("e1"))!.revision;
      expect(
        await storage.markTabAgentHandoffConsumed("e1", "tab-handoff-a", "handoff-other"),
      ).toBe(false);
      expect(await storage.markTabAgentHandoffConsumed("e1", "tab-handoff-a", "handoff-a")).toBe(
        true,
      );
      expect(await storage.markTabAgentHandoffConsumed("e1", "tab-handoff-a", "handoff-a")).toBe(
        false,
      );
      const after = (await storage.getPaneLayout("e1"))!;
      expect(after.revision).toBe(before + 1);
      expect(JSON.stringify(after.root)).toContain('"consumedAgentHandoffId":"handoff-a"');
    });
  });
});
