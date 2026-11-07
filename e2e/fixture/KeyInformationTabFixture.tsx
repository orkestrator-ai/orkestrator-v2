import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { BuildPipelineKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import { BuildChatTab } from "../../apps/web/src/components/build-pipeline/BuildChatTab";
import { PipelineKeyInformationTab } from "../../apps/web/src/components/build-pipeline/PipelineKeyInformationTab";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "../../apps/web/src/contexts/TerminalContext";
import { buildPipelineFixture } from "../../apps/web/src/test/build-pipeline-fixture";
import {
  BUILD_PIPELINE_VERSION,
  useBuildPipelineStore,
  type BuildPipeline,
} from "../../apps/web/src/stores/buildPipelineStore";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

const ENVIRONMENT_ID = "key-info-environment";
const PIPELINE_ID = "key-info-pipeline";

/** A brief shaped like a real pipeline's, long enough to need the tab's space. */
const keyInformation: BuildPipelineKeyInformation = {
  framing: "problem",
  summary:
    "Agents that run for a long time slowed down as their conversations grew, because each small update made the app recheck the whole conversation. Now it only looks at what changed, so long sessions stay responsive, and what you see in the conversation is exactly the same as before.",
  statement:
    "The Pi, Cursor and ACP bridges each had their own copy of the transcript helpers, and every bound re-measured or re-serialised whole transcripts and tool cards: BR-4 (each dirty read serialised every row), BR-5 (each tool-card update serialised the whole card), BR-6 (each delta re-measured the whole buffer) and BR-15 (duplicated helpers).",
  context:
    "To-do 1202 task 6 follows the 2026-10-27 efficiency report. The decided order was to move the helpers into packages/protocol/src/node first, then fix BR-4 to BR-6 there once. Other builds are editing the same to-do file at the same time, so only task 6's status line and section were changed. Transcript output had to stay exactly the same.",
  solution:
    "New shared modules in packages/protocol/src/node: bridge-transcript-text.ts (sliceUtf8, boundUtf8Text and BoundedTextAppender) and bridge-transcript-bounds.ts (createBridgeTranscriptBounds). A bound now re-measures only the newest row and the rows noted since the last pass, and every remembered size is checked against a fresh measurement under bun test.",
  workDone: [
    "Added bridge-transcript-text.ts and bridge-transcript-bounds.ts, and TranscriptRowSizes and EncodedObjectSizes in transcript-budget.ts, with export map entries",
    "Moved Pi and Cursor transcript.ts onto the shared modules, and ACP's text helpers and boundTranscript too",
    "Tool-card changes in Pi translate, Cursor translate and ACP commitToolPartMutation now use EncodedObjectSizes",
  ],
  decisions: [
    {
      decision: "Where the shared helpers live",
      options: [
        {
          option: "packages/protocol/src/node",
          pros: [
            "Every bridge already depends on the protocol package",
            "Node-only code stays out of the browser bundle",
          ],
          cons: ["Protocol grows a little"],
        },
        {
          option: "A new bridge-common package",
          pros: ["Clear ownership"],
          cons: ["Another package to version and lock", "Every bridge manifest changes"],
        },
      ],
      chosen: "packages/protocol/src/node",
      rationale:
        "The to-do already decided on the protocol package, and it avoids a new versioned manifest.",
    },
    {
      decision: "How a bound learns which rows changed",
      options: [
        {
          option: "Rows report their own edits",
          pros: ["No full pass on each update"],
          cons: ["Every write site must remember to report"],
        },
        {
          option: "Diff the transcript on each bound",
          pros: ["Nothing to forget"],
          cons: ["Still a whole-transcript pass, which is the cost being removed"],
        },
      ],
      chosen: "Rows report their own edits",
      rationale:
        "Tests check every remembered size against a fresh measurement, so a forgotten report fails loudly.",
    },
  ],
  notDone: [
    "OpenCode still bounds its transcript the old way; it does not use these helpers.",
    "No live-agent run was done; behaviour is covered by the bridge unit suites only.",
  ],
  tests: [
    {
      name: "bun test packages/protocol/src/node/bridge-transcript-bounds.test.ts",
      result: "passed",
    },
    {
      name: "bun test packages/protocol/src/node/bridge-transcript-text.test.ts",
      result: "passed",
    },
    { name: "bun test bridges/pi-bridge --parallel=2", result: "passed" },
    {
      name: "bun test bridges/cursor-bridge --parallel=2",
      result: "failed",
      details: "translate.test.ts: one snapshot differed by a trailing newline; fixed in round 2.",
    },
    {
      name: "mise run test:agent:browser:isolated",
      result: "not-run",
      details: "Not needed for a bridge-internal change.",
    },
  ],
  issues: [
    {
      round: 0,
      issue: "BoundedTextAppender can split a surrogate pair at the bound",
      severity: "P1",
      resolution:
        "sliceUtf8 now backs off to the previous code point boundary; covered by a new test.",
      status: "resolved",
    },
    {
      round: 0,
      issue: "Remembered sizes are not cleared when a row is removed",
      severity: "P2",
      resolution: "Removal now drops the entry, and the stale-size check covers removal.",
      status: "resolved",
    },
    {
      round: 1,
      issue: "ACP still imports its old helper in one test",
      severity: "P3",
      resolution: "",
      status: "open",
    },
  ],
  verifications: [
    {
      round: 0,
      passed: false,
      summary: "The Cursor translate snapshot differed by one trailing newline.",
      checks: [
        {
          check: "Transcript output is byte-for-byte unchanged",
          passed: false,
          details: "Cursor translate snapshot.",
        },
        { check: "Only task 6 of the to-do was changed", passed: true },
      ],
    },
    {
      round: 1,
      passed: true,
      summary: "Every criterion passes.",
      checks: [
        { check: "Transcript output is byte-for-byte unchanged", passed: true },
        { check: "Only task 6 of the to-do was changed", passed: true },
        { check: "Bridges keep their exported function names", passed: true },
      ],
    },
  ],
  updatedAt: "2026-11-02T04:41:28.000Z",
  updates: [
    {
      at: "2026-11-02T03:10:00.000Z",
      author: "build",
      round: 0,
      sections: ["statement", "context", "solution", "workDone", "decisions", "tests"],
    },
    { at: "2026-11-02T03:55:00.000Z", author: "address", round: 0, sections: ["issues", "tests"] },
    { at: "2026-11-02T04:20:00.000Z", author: "verify", round: 0, sections: ["verification"] },
    { at: "2026-11-02T04:41:28.000Z", author: "verify", round: 1, sections: ["verification"] },
  ],
};

const pipeline: BuildPipeline = buildPipelineFixture({
  id: PIPELINE_ID,
  environmentId: ENVIRONMENT_ID,
  phase: "complete",
  taskTitle: "To-do 1202 task 6: bridges re-measure whole transcripts per update",
  keyInformation,
});

/** Stands in for the terminal container: a `key-information` tab replaces the build view. */
function TabHost({ onOpen }: { onOpen: (options?: CreateTabOptions) => void }) {
  const { setCreateTab } = useTerminalContext();
  useEffect(() => {
    setCreateTab((type: CreatableTabType, options?: CreateTabOptions) => {
      if (type !== "key-information") return false;
      onOpen(options);
      return true;
    });
    return () => setCreateTab(null);
  }, [onOpen, setCreateTab]);
  return null;
}

/**
 * The build tab with its Key information panel, and the tab the panel pops
 * out into. `?view=tab` opens straight on the tab; `?empty=1` has no brief.
 */
export function KeyInformationTabFixture() {
  const params = new URLSearchParams(window.location.search);
  const [view, setView] = useState<"build" | "tab">(params.get("view") === "tab" ? "tab" : "build");
  const [openedWith, setOpenedWith] = useState<string>("");
  const empty = params.get("empty") === "1";
  const hydration = params.get("hydration");

  useLayoutEffect(() => {
    let reads = 0;
    if (hydration) {
      window.orkestrator = {
        invoke: async () => {
          reads++;
          if (hydration === "loading") return new Promise(() => {});
          if (hydration === "error" && reads === 1) throw new Error("Fixture read unavailable");
          if (hydration === "missing") return null;
          return {
            id: pipeline.id,
            projectId: pipeline.projectId,
            environmentId: pipeline.environmentId,
            version: BUILD_PIPELINE_VERSION,
            revision: pipeline.backendRevision,
            updatedAt: pipeline.createdAt,
            snapshot: pipeline,
          };
        },
        listen: () => () => undefined,
      } as unknown as Window["orkestrator"];
    }
    appCommandStore(useBuildPipelineStore.def).setState({
      pipelines: hydration
        ? new Map()
        : new Map([[PIPELINE_ID, empty ? { ...pipeline, keyInformation: undefined } : pipeline]]),
      buildEnvironmentIds: new Set([ENVIRONMENT_ID]),
    });
    appCommandStore(usePaneLayoutStore.def).setState({
      environments: new Map([
        [
          ENVIRONMENT_ID,
          {
            root: {
              kind: "leaf",
              id: "pane-1",
              activeTabId: "build",
              tabs: [
                {
                  id: "build",
                  type: "claude-build",
                  buildTabData: {
                    environmentId: ENVIRONMENT_ID,
                    pipelineId: PIPELINE_ID,
                    taskId: "task-1",
                  },
                },
              ],
            },
            activePaneId: "pane-1",
            containerId: null,
          },
        ],
      ]),
    });
  }, [empty, hydration]);

  const onOpen = useCallback(
    (options?: CreateTabOptions) => {
      setOpenedWith(JSON.stringify(options?.keyInformation ?? null));
      setView("tab");
    },
    [setOpenedWith, setView],
  );

  return (
    <TerminalProvider>
      <TabHost onOpen={onOpen} />
      <main className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex shrink-0 gap-2 border-b border-border/40 px-2 py-1 text-xs">
          <button type="button" onClick={() => setView("build")}>
            Build tab
          </button>
          <span data-testid="opened-with">{openedWith}</span>
        </div>
        <div className="relative min-h-0 flex-1">
          {view === "build" ? (
            <BuildChatTab
              data={{
                pipelineId: PIPELINE_ID,
                environmentId: ENVIRONMENT_ID,
                taskId: "task-1",
                isLocal: true,
              }}
              isActive
            />
          ) : (
            <PipelineKeyInformationTab
              data={{ environmentId: ENVIRONMENT_ID, pipelineId: PIPELINE_ID }}
            />
          )}
        </div>
      </main>
    </TerminalProvider>
  );
}
