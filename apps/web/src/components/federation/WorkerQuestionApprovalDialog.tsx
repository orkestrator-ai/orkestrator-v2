import { useMemo, useState } from "react";
import { AlertCircle, Check, Loader2, MessageCircleQuestion } from "lucide-react";
import { toast } from "sonner";
import type { AgentInteractionQuestionAnswer } from "@orkestrator/protocol/agent-interactions";
import {
  workerQuestionAnswerProblem,
  type WorkerQuestionView,
} from "@orkestrator/protocol/worker-question-relay";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { resolveNodeActionRequest, type NodeActionRequestView } from "@/lib/portal/portal-store";
import { useFederation } from "./FederationProvider";

type Draft = Record<string, { optionIds: string[]; freeText: string }>;

function draftFrom(
  questions: readonly WorkerQuestionView[],
  answers: readonly AgentInteractionQuestionAnswer[],
): Draft {
  const draft: Draft = {};
  for (const question of questions) {
    const answer = answers.find((entry) => entry.questionId === question.id);
    draft[question.id] = {
      optionIds: answer?.optionIds ? [...answer.optionIds] : [],
      freeText: answer?.freeText ?? "",
    };
  }
  return draft;
}

/** The answers a draft sends, in question order; unanswered questions are left out. */
function answersFrom(
  questions: readonly WorkerQuestionView[],
  draft: Draft,
): AgentInteractionQuestionAnswer[] {
  return questions.flatMap((question) => {
    const entry = draft[question.id];
    const optionIds = entry?.optionIds ?? [];
    const freeText = question.allowFreeText ? (entry?.freeText ?? "") : "";
    if (optionIds.length === 0 && !freeText.trim()) return [];
    return [
      {
        questionId: question.id,
        ...(optionIds.length ? { optionIds } : {}),
        ...(freeText.trim() ? { freeText } : {}),
      },
    ];
  });
}

/**
 * A coordinator proposed an answer to a question a worker is waiting on. The
 * user sees the question, its options and the proposal (preselected), may
 * change it, and approves or declines. Nothing reaches the worker unless the
 * user approves; the answer sent is the one shown when they do.
 */
export function WorkerQuestionApprovalDialog({
  request,
  onSettled,
}: {
  request: NodeActionRequestView;
  onSettled: () => void;
}) {
  const { portalState } = useFederation();
  const target = request.targets[0];
  const relay = request.workerQuestion;
  const questions = useMemo(() => relay?.questions ?? [], [relay]);
  const proposedDraft = useMemo(
    () => draftFrom(questions, relay?.proposed ?? []),
    [questions, relay],
  );
  const [draft, setDraft] = useState<Draft>(proposedDraft);
  const [busy, setBusy] = useState(false);

  const answers = useMemo(() => answersFrom(questions, draft), [questions, draft]);
  const edited = useMemo(
    () => JSON.stringify(answers) !== JSON.stringify(answersFrom(questions, proposedDraft)),
    [answers, questions, proposedDraft],
  );
  const problem = !relay
    ? "This request carries no question."
    : answers.length === 0
      ? "Pick or write an answer."
      : workerQuestionAnswerProblem(questions, answers);

  const update = (
    question: WorkerQuestionView,
    change: (current: Draft[string]) => Draft[string],
  ) =>
    setDraft((current) => ({
      ...current,
      [question.id]: change(current[question.id] ?? { optionIds: [], freeText: "" }),
    }));

  const toggleOption = (question: WorkerQuestionView, optionId: string) =>
    update(question, (current) => {
      if (question.multiple) {
        const optionIds = current.optionIds.includes(optionId)
          ? current.optionIds.filter((id) => id !== optionId)
          : [...current.optionIds, optionId];
        return { ...current, optionIds };
      }
      // One choice: an option replaces any written answer, as in the worker's tab.
      return current.optionIds.includes(optionId)
        ? { ...current, optionIds: [] }
        : { optionIds: [optionId], freeText: "" };
    });

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      const resolved = await resolveNodeActionRequest(
        request.requestId,
        decision,
        // Unchanged, the backend sends the proposal it stored.
        decision === "approve" && edited ? { answers } : undefined,
      );
      if (decision === "approve") {
        if (resolved.state === "executed") toast.success(resolved.result?.message ?? "Answered.");
        else
          toast.warning(
            resolved.state === "stale" ? "Not sent: the question had gone" : "Answer not sent",
            { description: resolved.result?.message },
          );
      }
    } catch (error) {
      toast.error("Could not resolve the request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      onSettled();
    }
  };

  const worker = target?.environmentName ?? target?.environmentId ?? "a worker";
  const tab = relay?.tabName ?? relay?.tabId ?? "an agent tab";
  // The coordinator's own node names itself "this machine"; another node is named.
  const local =
    !target || target.nodeId === portalState.selfId || target.nodeName === "this machine";
  const remote = local ? "" : ` on ${target.nodeName}`;

  return (
    // Like the other coordinator requests, it stays until approved or declined.
    <Dialog open>
      <DialogContent size="xl" data-testid="worker-question-request" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Answer the question in “{tab}” of “{worker}”{remote}?
          </DialogTitle>
          <DialogDescription>
            The project coordinator proposes the answer below to a question this worker is waiting
            on. Change it if you like; nothing is sent to the worker unless you approve.
            {request.reason ? ` Its reason: “${request.reason}”` : ""}
          </DialogDescription>
        </DialogHeader>

        {!relay ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> This request carries no question.
          </p>
        ) : (
          <section
            role="group"
            aria-label={relay.title}
            className="max-h-[60vh] overflow-y-auto rounded-lg border border-border/70 bg-zinc-900/90"
          >
            <div className="flex items-center gap-2 border-b border-border/60 bg-white/[0.02] px-3 py-2">
              <MessageCircleQuestion
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="min-w-0 truncate text-xs font-medium text-foreground">
                {relay.title}
              </span>
              {edited ? (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  Edited by you
                </span>
              ) : (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  Coordinator&apos;s proposal
                </span>
              )}
            </div>
            {questions.map((question) => {
              const entry = draft[question.id] ?? { optionIds: [], freeText: "" };
              const proposed = proposedDraft[question.id];
              return (
                <div
                  key={question.id}
                  className="border-b border-border/40 px-3 py-3 last:border-b-0"
                  data-testid="worker-question"
                >
                  {question.description ? (
                    <div className="mb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                      {question.description}
                    </div>
                  ) : null}
                  <p className="text-sm leading-relaxed text-foreground">
                    {question.prompt}
                    {question.multiple ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        (select all that apply)
                      </span>
                    ) : null}
                    {question.required ? null : (
                      <span className="ml-1.5 text-xs text-muted-foreground">(optional)</span>
                    )}
                  </p>
                  {question.options.length ? (
                    <div className="mt-3 flex flex-col gap-1.5">
                      {question.options.map((option) => {
                        const selected = entry.optionIds.includes(option.id);
                        return (
                          <button
                            key={option.id}
                            type="button"
                            disabled={busy}
                            aria-pressed={selected}
                            onClick={() => toggleOption(question, option.id)}
                            className={cn(
                              "flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                              selected
                                ? "border-primary/50 bg-primary/10"
                                : "border-border/60 hover:bg-white/[0.03]",
                              busy && "cursor-not-allowed opacity-60 hover:bg-transparent",
                            )}
                          >
                            <span
                              className={cn(
                                "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                                question.multiple ? "rounded-[4px]" : "rounded-full",
                                selected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-muted-foreground/40",
                              )}
                              aria-hidden
                            >
                              {selected ? <Check className="size-3" /> : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm text-foreground">{option.label}</span>
                              {option.description ? (
                                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                                  {option.description}
                                </span>
                              ) : null}
                            </span>
                            {proposed?.optionIds.includes(option.id) ? (
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                proposed
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {question.allowFreeText ? (
                    <Textarea
                      className="mt-2"
                      aria-label={
                        question.options.length
                          ? `Other answer: ${question.prompt.slice(0, 80)}`
                          : `Answer: ${question.prompt.slice(0, 80)}`
                      }
                      placeholder={question.options.length ? "Or write another answer" : "Answer"}
                      value={entry.freeText}
                      disabled={busy}
                      maxLength={16_384}
                      onChange={(event) => {
                        const freeText = event.target.value;
                        update(question, (current) => ({
                          freeText,
                          // One choice: a written answer replaces the picked option.
                          optionIds: question.multiple || !freeText.trim() ? current.optionIds : [],
                        }));
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </section>
        )}
        {relay && problem ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {problem}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void decide("reject")}
          >
            Decline
          </Button>
          <Button
            type="button"
            disabled={busy || Boolean(problem)}
            onClick={() => void decide("approve")}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Approve and send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
