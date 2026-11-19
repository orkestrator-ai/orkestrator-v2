import { useState } from "react";
import type {
  AgentPendingInteractionSummary,
  AgentRegistrySnapshot,
} from "@orkestrator/protocol/agent-registry";
import type { AgentSummarySource } from "../../apps/web/src/components/environments/EnvironmentAgentSummary";
import { EnvironmentRow } from "../../apps/web/src/components/environments/EnvironmentRow";
import type { EnvironmentRowFacts } from "../../apps/web/src/components/environments/environment-row-model";
import { activityRowClassName } from "../../apps/web/src/components/sidebar/EnvironmentRowFrame";
import { useHoverTooltip } from "../../apps/web/src/components/ui/hover-tooltip";

const MINUTE = 60_000;

function facts(id: string, overrides: Partial<EnvironmentRowFacts>): EnvironmentRowFacts {
  return {
    environmentId: id,
    name: id,
    projectHome: false,
    environmentType: "local",
    status: "running",
    deleting: false,
    deleteFailure: null,
    deletingSince: null,
    deletingStep: null,
    deletionRetryable: false,
    buildPipeline: false,
    prState: null,
    autoMerge: false,
    activity: "idle",
    running: true,
    live: true,
    busy: false,
    hasUnreadWork: false,
    unreadReason: null,
    lastActivityAt: new Date(Date.now() - 12 * MINUTE).toISOString(),
    prMergeState: null,
    machine: null,
    writable: true,
    dockerAvailable: true,
    localCheckoutAvailable: true,
    ...overrides,
  };
}

/** Each row's waiting tab and request, as its machine's registry reports it. */
const PENDING: Record<string, AgentPendingInteractionSummary> = {
  "deps-upgrade": {
    interactionId: "approval-1",
    kind: "command-approval",
    label: "Needs approval",
    detail: "Claude wants to run bun install",
    since: Date.now() - 8 * MINUTE,
    count: 1,
  },
  "api-client": {
    interactionId: "question-1",
    kind: "question",
    label: "Question",
    detail: "Which API should this use: REST or GraphQL?",
    since: Date.now() - 3 * MINUTE,
    count: 2,
  },
  "sign-in-flow": {
    interactionId: "form-1",
    kind: "mcp-form",
    label: "Needs input",
    since: Date.now() - 41 * MINUTE,
    count: 1,
  },
};

const source: AgentSummarySource = {
  read: async (environmentId): Promise<AgentRegistrySnapshot> => ({
    generatedAt: new Date().toISOString(),
    environments: [],
    entries: PENDING[environmentId]
      ? [
          {
            projectId: "p",
            environmentId,
            environmentName: environmentId,
            tabId: `${environmentId}-agent`,
            ownerKind: "environment",
            kind: "native",
            agent: "claude",
            displayName: "Claude",
            tabOrdinal: 1,
            state: "waiting",
            pending: PENDING[environmentId],
          },
        ]
      : [],
  }),
  subscribe: () => () => {},
};

const ROWS: EnvironmentRowFacts[] = [
  facts("deps-upgrade", {
    activity: "waiting",
    hasUnreadWork: true,
    unreadReason: "agent_waiting",
  }),
  facts("api-client", { activity: "waiting", hasUnreadWork: true, unreadReason: "agent_question" }),
  facts("sign-in-flow", {
    environmentType: "containerized",
    activity: "waiting",
    hasUnreadWork: true,
    unreadReason: "agent_waiting",
  }),
  facts("docs-refresh", { activity: "working" }),
  facts("billing-export", { hasUnreadWork: true, unreadReason: "agent_finished", prState: "open" }),
  facts("flaky-ci", { hasUnreadWork: true, unreadReason: "agent_failed" }),
  facts("search-index", {
    environmentType: "containerized",
    hasUnreadWork: true,
    unreadReason: "setup_approval",
  }),
  facts("settings-page", {}),
];

function Row({
  rowFacts,
  onOpen,
}: {
  rowFacts: EnvironmentRowFacts;
  onOpen: (text: string) => void;
}) {
  const tooltip = useHoverTooltip();
  return (
    <div className={activityRowClassName(false)}>
      <span aria-hidden="true" className="h-6 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <EnvironmentRow
          facts={rowFacts}
          selected={false}
          onActivate={() => onOpen(`${rowFacts.environmentId}: row`)}
          actions={{
            openSettings: () => {},
            fork: () => {},
            start: () => {},
            stop: () => {},
            restart: () => {},
            confirmDelete: () => {},
          }}
          changes={null}
          tooltip={tooltip}
          tooltipDetails={{}}
          agentSummary={null}
          attentionSource={source}
          onOpenAttention={(tabId) =>
            onOpen(`${rowFacts.environmentId}: ${tabId ?? "environment"}`)
          }
        />
      </div>
    </div>
  );
}

/**
 * Sidebar rows in every attention state: waiting with a named approval, a
 * question and a sensitive form; working; finished, failed and setup unread;
 * idle and seen. `?before` hides the attention lines, as rows were drawn
 * before them.
 */
export function EnvironmentAttentionFixture() {
  const [opened, setOpened] = useState<string>("");
  const before = new URLSearchParams(location.search).has("before");
  return (
    <main className="flex min-h-screen gap-8 bg-background p-6 text-foreground">
      {before && (
        <style>{`[data-testid="environment-attention-line"] { display: none !important; }`}</style>
      )}
      <section
        data-testid="attention-sidebar"
        aria-label="Environments"
        className="flex w-[280px] max-w-full flex-col self-start gap-0.5 rounded-lg border border-border bg-sidebar py-2"
      >
        {ROWS.map((rowFacts) => (
          <Row key={rowFacts.environmentId} rowFacts={rowFacts} onOpen={setOpened} />
        ))}
      </section>
      <output data-testid="attention-opened" className="sr-only">
        {opened}
      </output>
    </main>
  );
}
