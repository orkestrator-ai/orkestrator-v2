/**
 * The bridge request that answers a question the ACP bridge parked: Grok's
 * `ask_user_question` or Antigravity's `interaction_*` permission request,
 * which the bridge keeps in one shape. Each chosen option is sent as the
 * provider's own value; free text only where the card allowed it.
 */
import type {
  AgentInteractionRequest,
  AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";

export function acpQuestionAnswerRequest(
  base: string,
  providerRequestId: string,
  request: AgentInteractionRequest,
  resolution: AgentInteractionResolution,
): { path: string; method: "POST"; body: string } {
  const byQuestion = new Map(
    resolution.answer?.answers.map((answer) => [answer.questionId, answer]),
  );
  const answers = Object.fromEntries(
    request.presentation.questions.map((question) => {
      const answer = byQuestion.get(question.id);
      const options = new Map(question.options.map((option) => [option.id, option.providerValue]));
      return [
        question.id,
        [
          ...(answer?.optionIds ?? []).map((id) => options.get(id)!),
          ...(answer?.freeText === undefined ? [] : [answer.freeText]),
        ],
      ];
    }),
  );
  return {
    path: `${base}/interactions/${encodeURIComponent(providerRequestId)}`,
    method: "POST",
    body: JSON.stringify({
      action: resolution.action === "answer" ? "accept" : "cancel",
      ...(resolution.action === "answer" ? { answers } : {}),
    }),
  };
}
