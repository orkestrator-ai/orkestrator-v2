import { useState } from "react";
import { WorkerQuestionApprovalDialog } from "../../apps/web/src/components/federation/WorkerQuestionApprovalDialog";
import type { NodeActionRequestView } from "../../apps/web/src/lib/portal/portal-store";
import type { WorkerQuestionView } from "@orkestrator/protocol/worker-question-relay";
import { Toaster } from "../../apps/web/src/components/ui/sonner";

const questions: WorkerQuestionView[] = [
  {
    id: "db",
    description: "Storage",
    prompt: "Which database should the service use for the session store and the audit log?",
    required: true,
    multiple: false,
    allowFreeText: true,
    options: [
      {
        id: "pg",
        label: "Postgres",
        description: "The default. Already provisioned in staging and backed up nightly.",
      },
      { id: "sqlite", label: "SQLite", description: "One file beside the service; no server." },
    ],
  },
  {
    id: "extras",
    prompt: "Which extras should ship with it?",
    required: false,
    multiple: true,
    allowFreeText: false,
    options: [
      { id: "cache", label: "Cache" },
      { id: "search", label: "Search" },
    ],
  },
  {
    id: "notes",
    prompt: "Anything else the worker should know?",
    required: false,
    multiple: false,
    allowFreeText: true,
    options: [],
  },
];

// `?many` adds questions until the question list has to scroll inside the dialog.
const many = new URLSearchParams(window.location.search).has("many");
const extraQuestions: WorkerQuestionView[] = many
  ? Array.from({ length: 8 }, (_, index) => ({
      id: `extra-${index + 1}`,
      prompt: `Extra question ${index + 1}: should the worker also cover this follow-up case?`,
      required: false,
      multiple: false,
      allowFreeText: false,
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    }))
  : [];

const request: NodeActionRequestView = {
  requestId: "worker-question-fixture",
  kind: "answer-worker-question",
  state: "pending",
  reason: "The ticket says Postgres.",
  targets: [
    {
      nodeId: "self",
      nodeName: "this machine",
      environmentId: "worker-1",
      environmentName: "auth-fix",
      projectId: "p1",
    },
  ],
  requestedBy: { projectId: "p1" },
  workerQuestion: {
    tabId: "agent-1",
    tabName: "Claude 1",
    interactionId: "q-1",
    revision: 2,
    title: "Database choice",
    questions: [...questions, ...extraQuestions],
    proposed: [
      { questionId: "db", optionIds: ["pg"] },
      { questionId: "extras", optionIds: ["cache"] },
    ],
  },
};

/**
 * The approval dialog for a coordinator's proposed answer to a worker's
 * question, over a fake backend that records the decision it receives.
 */
export function WorkerQuestionApprovalFixture() {
  const [decision, setDecision] = useState<unknown>(null);
  const [settled, setSettled] = useState(false);
  useState(() => {
    window.orkestrator = {
      ...window.orkestrator!,
      invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command !== "resolve_node_action_request")
          throw new Error(`Unexpected command: ${command}`);
        setDecision(args);
        return (
          args?.decision === "approve"
            ? { ...request, state: "executed", result: { code: "answered", message: "Answered." } }
            : { ...request, state: "rejected" }
        ) as T;
      },
    };
  });
  return (
    <main>
      <pre data-testid="decision">{JSON.stringify(decision)}</pre>
      {!settled && (
        <WorkerQuestionApprovalDialog request={request} onSettled={() => setSettled(true)} />
      )}
      <Toaster />
    </main>
  );
}
