import { useMemo, useState } from "react";
import type { NativeAgentSuborkBatchView } from "@orkestrator/protocol/suborks";
import { SuborkGroup } from "../../apps/web/src/components/chat/SuborkGroup";
import { SuborkGroupActionsContext } from "../../apps/web/src/components/chat/subork-context";

const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

/** One working, one done and one failed row: every state a row can settle through. */
const BATCH: NativeAgentSuborkBatchView = {
  id: "batch-1",
  createdAt: ago(294),
  status: "running",
  delivery: "waiting",
  suborks: [
    {
      id: "opus",
      name: "Council r12: Opus review",
      agent: "claude",
      model: "opus",
      modelLabel: "Opus 5.5",
      status: "finished",
      line: "I'd ship it as is, scored 9.5 overall. Every round 11 fix landed, the syntax tests pass (4 of 4), and every syntax column renders as expected in both themes, so nothing here should hold the release back.",
      startedAt: ago(294),
      endedAt: ago(38),
      tokens: 48_210,
      readOnly: "enforced",
      transcriptRevision: 3,
    },
    {
      id: "sol",
      name: "Council r12: Sol review",
      agent: "codex",
      model: "gpt-6.1-sol",
      status: "running",
      line: "Read src/components/chat/SuborkGroup.tsx",
      startedAt: ago(292),
      readOnly: "provider-configured",
    },
    {
      id: "grok",
      name: "grok 4.9",
      status: "failed",
      line: 'No enabled model matches "grok 4.9". Close options: Grok grok-4.7, Grok grok-4.6, Cursor grok-4.7.',
    },
  ],
};

/** The transcript group on the transcript's own background. `?settled=1` ends the call. */
export function SuborkGroupFixture() {
  const settled = new URLSearchParams(window.location.search).get("settled") === "1";
  const [opened, setOpened] = useState<string>("");
  const [stopped, setStopped] = useState(false);
  const batch = useMemo<NativeAgentSuborkBatchView>(() => {
    if (!settled && !stopped) return BATCH;
    return {
      ...BATCH,
      status: stopped ? "stopped" : "settled",
      settledAt: ago(0),
      delivery: "sent",
      suborks: BATCH.suborks.map((subork) =>
        subork.status === "running"
          ? { ...subork, status: stopped ? "stopped" : "finished", endedAt: ago(0) }
          : subork,
      ),
    };
  }, [settled, stopped]);
  const actions = useMemo(
    () => ({
      openTranscript: (_batchId: string, suborkId: string) => setOpened(suborkId),
      stop: async () => setStopped(true),
    }),
    [],
  );
  return (
    <SuborkGroupActionsContext.Provider value={actions}>
      <main
        data-testid="subork-fixture"
        className="@container min-h-screen bg-background py-4 text-foreground"
      >
        <SuborkGroup batch={batch} expansionKey="subork-group-collapsed:fixture" />
        <output data-testid="opened-transcript" className="sr-only">
          {opened}
        </output>
      </main>
    </SuborkGroupActionsContext.Provider>
  );
}
