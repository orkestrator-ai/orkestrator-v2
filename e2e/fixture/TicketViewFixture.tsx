import { useLayoutEffect, useState } from "react";
import type { BuildPipelineKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";

import { keyInformation as briefFixture } from "../../apps/web/src/components/build-pipeline/key-information-test-fixture";
import { KanbanTaskDialog } from "../../apps/web/src/components/kanban/KanbanTaskDialog";
import { useBuildPipelineStore } from "../../apps/web/src/stores/buildPipelineStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import type { KanbanStatus, KanbanTask } from "../../apps/web/src/stores/kanbanStore";
import { usePrMonitorStore } from "../../apps/web/src/stores/prMonitorStore";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";
import { buildPipelineFixture } from "../../apps/web/src/test/build-pipeline-fixture";

const ENVIRONMENT_ID = "ticket-view-environment";
const PIPELINE_ID = "ticket-view-pipeline";
const PR_URL = "https://github.com/acme/orkestrator/pull/2113";

/** A finished build's Notes, long enough that the column scrolls under its bar. */
const notes: BuildPipelineKeyInformation = {
  ...briefFixture,
  framing: "problem",
  summary:
    "Tickets built by a pipeline now move across the board on their own, on every machine.\n\nA ticket goes to In progress when its build starts, to Review when the build finishes with Notes, and to Done when its pull request merges.",
  statement:
    "Twelve tickets were stuck in In progress and thirty-one in Backlog although their builds had finished and their pull requests had merged weeks ago.",
  context:
    "Builds often run on another machine from the command node's board. The board the user looks at is the command node's.",
  solution:
    "Every lifecycle write keeps a done ticket done, deleting a build's environment ends its ticket's lifecycle, and a closed pull request returns the ticket to the backlog unless it was moved by hand.",
  workDone: [
    "Found the stuck tickets' cause in the board's own records",
    "Made Ship's re-detection of a merged pull request close the ticket instead of reopening it",
    "Ended an unfinished build's ticket lifecycle when its environment is deleted",
    "Returned a ticket to the backlog when its pull request closes without merging",
    "Rebuilt the ticket view as a tabbed Ticket / Notes view",
  ],
  tests: [
    ...briefFixture.tests,
    { name: "bun test build-pipeline-kanban-transitions", result: "passed" },
    { name: "bun test node-ticket-sync-lifecycle", result: "passed" },
  ],
};

function ticket(status: KanbanStatus): KanbanTask {
  return {
    id: "ticket-view-task",
    projectId: "project-1",
    title: "Tickets: reliable Backlog → In progress → Review → Done for pipeline builds",
    description: [
      "A ticket built by a pipeline moves through the board on its own: Backlog until a build starts, In progress while it builds, Review once it finishes with Notes, Done when its pull request merges.",
      "",
      "## Problem",
      "",
      "The lifecycle table already mapped build events to columns, but tickets did not follow it, above all when the build ran on another machine.",
      "",
      "## Context",
      "",
      "Builds run on leaves from tickets created on the command node and synced there. The command node's board is the one the user looks at.",
      "",
      "## Out of scope",
      "",
      "Auto-merging. Every merge is a user's click.",
    ].join("\n"),
    acceptanceCriteria: [
      "- [x] The cause of tickets not moving is identified with evidence and fixed.",
      "- Build start moves a ticket to In progress.",
      "- A merged PR moves it to Done, and a Done ticket is never reopened.",
      "- The ticket view has Ticket and Notes tabs with a section index.",
    ].join("\n"),
    kind: "feature",
    status,
    comments: [
      { id: "c1", text: "🔨 Build started", createdAt: "2026-11-10T23:51:00.000Z" },
      { id: "c2", text: "✅ Validation complete", createdAt: "2026-11-11T01:20:00.000Z" },
      { id: "c3", text: `🔗 PR raised: ${PR_URL}`, createdAt: "2026-11-11T01:21:00.000Z" },
    ],
    images: [],
    createdAt: "2026-11-10T23:50:00.000Z",
    order: 0,
    environmentId: ENVIRONMENT_ID,
    buildPipelineId: PIPELINE_ID,
    prUrl: PR_URL,
    prState: "open",
  };
}

/**
 * The ticket view. `?column=review` opens it from the Review column (on its
 * Notes); `?ready` makes the pull request ready to merge; `?nonotes` gives
 * the ticket no build.
 */
export function TicketViewFixture() {
  const params = new URLSearchParams(window.location.search);
  const column = (params.get("column") as KanbanStatus | null) ?? "in-progress";
  const ready = params.has("ready");
  const withNotes = !params.has("nonotes");
  const [open, setOpen] = useState(true);

  useLayoutEffect(() => {
    // No backend behind the fixture: every read answers nothing.
    window.orkestrator = {
      invoke: async () => null,
      listen: () => () => undefined,
    } as unknown as Window["orkestrator"];
    appCommandStore(useBuildPipelineStore.def).setState({
      pipelines: withNotes
        ? new Map([
            [
              PIPELINE_ID,
              buildPipelineFixture({
                id: PIPELINE_ID,
                taskId: "ticket-view-task",
                environmentId: ENVIRONMENT_ID,
                phase: "complete",
                keyInformation: notes,
              }),
            ],
          ])
        : new Map(),
      buildEnvironmentIds: new Set([ENVIRONMENT_ID]),
    });
    appCommandStore(useEnvironmentStore.def).setState({
      environments: [
        {
          id: ENVIRONMENT_ID,
          projectId: "project-1",
          name: "pipeline-tickets",
          branch: "pipeline-tickets",
          status: "running",
          environmentType: "local",
          prUrl: PR_URL,
          prState: "open",
          hasMergeConflicts: false,
          prMergeability: ready ? "clean" : "unstable",
        } as never,
      ],
    });
    appCommandStore(usePrMonitorStore.def).setState({
      syncStatus: "current",
      states: new Map([
        [
          ENVIRONMENT_ID,
          {
            environmentId: ENVIRONMENT_ID,
            mode: "normal",
            checkInProgress: false,
            consecutiveErrors: 0,
            lastCheckAt: "2026-11-11T01:30:00.000Z",
            lastSuccessfulCheckAt: "2026-11-11T01:30:00.000Z",
            prUrl: PR_URL,
            prState: "open",
            hasMergeConflicts: false,
            checkSummary: ready
              ? { passed: 6, total: 6, pending: 0 }
              : { passed: 4, total: 6, pending: 2 },
          } as never,
        ],
      ]),
    });
  }, [ready, withNotes]);

  const task = ticket(column);
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <button type="button" onClick={() => setOpen(true)}>
        Open ticket
      </button>
      <KanbanTaskDialog
        task={withNotes ? task : { ...task, buildPipelineId: undefined, environmentId: undefined }}
        open={open}
        onOpenChange={setOpen}
        openedFrom={column}
      />
    </main>
  );
}
