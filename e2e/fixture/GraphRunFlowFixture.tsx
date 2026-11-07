import { useLayoutEffect, useRef, useState } from "react";
import { GraphRunTab } from "../../apps/web/src/components/graph-run/GraphRunTab";
import {
  act,
  agentSession,
  FIXTURE_AT,
  runOf,
} from "../../apps/web/src/components/graph-run/graph-run.test-fixtures";
import { useGraphRunStore } from "../../apps/web/src/stores/graphRunStore";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

function transcriptEntries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `plan-${index + 1}`,
    role: "assistant",
    parts: [
      {
        type: "text",
        content: `Transcript entry ${index + 1}. ${"This line gives the transcript enough height to scroll. ".repeat(6)}`,
      },
    ],
  }));
}

/** What the run record holds for a stored transcript of `count` messages. */
function transcriptReference(count: number) {
  return {
    version: 1 as const,
    sdkSessionId: "provider-session-1",
    manifestRevision: count,
    revision: count,
    messageCount: count,
    bytes: 1,
    complete: true,
    committedAt: FIXTURE_AT,
  };
}

/**
 * Real run view and renderer; only snapshot transport is replaced.
 * `?longTranscript` gives the running node a transcript that overflows its inspector.
 * `?waiting` leaves the run waiting for an answer from the person.
 */
export function GraphRunFlowFixture() {
  const [isActive, setIsActive] = useState(true);
  const [longTranscript] = useState(() =>
    new URLSearchParams(window.location.search).has("longTranscript"),
  );
  const transcriptLength = useRef(40);
  const [waiting] = useState(() => new URLSearchParams(window.location.search).has("waiting"));
  const [initialRun] = useState(() =>
    runOf("multi-review", {
      ...(waiting ? { status: "waiting" as const } : {}),
      activations: [
        act(
          { nodeId: "plan" },
          {
            state: waiting ? "awaiting-human" : "running",
            ...(longTranscript
              ? { session: agentSession({ transcript: transcriptReference(40) }) }
              : {}),
          },
        ),
      ],
    }),
  );
  useLayoutEffect(() => {
    const original = window.orkestrator;
    window.orkestrator = {
      invoke: async <T,>(command: string) => {
        if (command === "graph_run_get") {
          return {
            status: "changed",
            run:
              appCommandStore(useGraphRunStore.def).getState().runs.get(initialRun.id)?.run ??
              initialRun,
          } as T;
        }
        if (command === "graph_run_transcript") {
          return {
            status: "found",
            messages: transcriptEntries(transcriptLength.current),
            startIndex: 0,
            messageCount: transcriptLength.current,
            revision: transcriptLength.current,
            complete: true,
          } as T;
        }
        return undefined as T;
      },
      listen: () => () => undefined,
    } as unknown as Window["orkestrator"];
    return () => {
      window.orkestrator = original;
    };
  }, [initialRun]);
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <div className="shrink-0">
        <button onClick={() => setIsActive(!isActive)}>
          {isActive ? "Activate other pane" : "Activate graph pane"}
        </button>
        <button
          onClick={() =>
            appCommandStore(useGraphRunStore.def)
              .getState()
              .applyRun({
                ...initialRun,
                revision: initialRun.revision + 1,
                activations: [
                  act({ nodeId: "plan" }),
                  act({ nodeId: "package" }),
                  act({ nodeId: "review", branchKey: "panel.1" }),
                  act({ nodeId: "review", branchKey: "panel.2" }),
                  act({ nodeId: "consolidate" }, { state: "running" }),
                ],
              })
          }
        >
          Advance graph run
        </button>
        {longTranscript ? (
          <button
            onClick={() => {
              transcriptLength.current += 1;
              const run =
                appCommandStore(useGraphRunStore.def).getState().runs.get(initialRun.id)?.run ??
                initialRun;
              appCommandStore(useGraphRunStore.def)
                .getState()
                .applyRun({
                  ...run,
                  revision: run.revision + 1,
                  activations: run.activations.map((activation) => ({
                    ...activation,
                    session: agentSession({
                      transcript: transcriptReference(transcriptLength.current),
                    }),
                  })),
                });
            }}
          >
            Append transcript entry
          </button>
        ) : null}
      </div>
      <div hidden={!isActive} className="relative flex min-h-0 flex-1 flex-col">
        <GraphRunTab
          environmentId="env-1"
          data={{ runId: initialRun.id, title: "Multi Review" }}
          isActive={isActive}
        />
      </div>
    </main>
  );
}
