/**
 * Representative `public_action` responses. They pin the documented JSON
 * shapes for success, rejection, unknown dispatch, partial creation, waiting
 * for input, and expired history, and are shared by the protocol, backend and
 * CLI tests so the three cannot drift.
 */
import {
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicActionResponse,
  type PublicReceipt,
} from "./public-api.js";

const NAMESPACE = "ns-1790000000000-0a1b2c3d";
const CREATED = "2026-09-26T12:00:00.000Z";
const RETAINED = "2026-11-02T12:00:00.000Z";

function receipt(overrides: Partial<PublicReceipt>): PublicReceipt {
  return {
    operationId: "op_00000000000000000000000001",
    namespace: NAMESPACE,
    requestId: "scenario-1:create",
    action: "environment.create",
    state: "succeeded",
    stage: "completed",
    replayed: false,
    resources: {},
    createdAt: CREATED,
    updatedAt: CREATED,
    completedAt: CREATED,
    retainedUntil: RETAINED,
    ...overrides,
  };
}

export const PUBLIC_API_FIXTURES = {
  environmentCreated: publicSuccessEnvelope(
    "environment.create",
    { environmentId: "11111111-1111-4111-8111-111111111111" },
    receipt({
      resources: {
        projectId: "22222222-2222-4222-8222-222222222222",
        environmentId: "11111111-1111-4111-8111-111111111111",
      },
    }),
  ),
  replayedCreate: publicSuccessEnvelope(
    "environment.create",
    { environmentId: "11111111-1111-4111-8111-111111111111" },
    receipt({
      replayed: true,
      resources: { environmentId: "11111111-1111-4111-8111-111111111111" },
    }),
  ),
  requestConflict: publicErrorEnvelope("environment.create", {
    code: "request-conflict",
    message: "Request key was already used with a different intent.",
    details: { operationId: "op_00000000000000000000000001" },
  }),
  promptRejected: publicErrorEnvelope(
    "session.prompt",
    { code: "busy", message: "The session is busy; steer it or wait for the turn to end." },
    receipt({
      action: "session.prompt",
      requestId: "scenario-1:followup",
      state: "failed",
      stage: "dispatching",
      dispatch: { state: "rejected", error: "Session is busy" },
    }),
  ),
  promptUnknown: publicErrorEnvelope(
    "session.prompt",
    {
      code: "dispatch-unknown",
      message: "The provider may have received the prompt. Retry with the same key or discard.",
      retryable: true,
    },
    receipt({
      action: "session.prompt",
      requestId: "scenario-1:followup",
      state: "unknown",
      stage: "dispatching",
      completedAt: undefined,
      resources: {
        environmentId: "11111111-1111-4111-8111-111111111111",
        sessionId: "ses_MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExCnN0YXJ0dXAtYWdlbnQ",
        dispatchRequestId: "public-3c9a",
      },
      dispatch: { state: "unknown", origin: "transport", recoverable: true },
      execution: { state: "unknown", reason: "Dispatch was not confirmed." },
    }),
  ),
  partialLaunch: publicErrorEnvelope(
    "environment.launch",
    {
      code: "partial-failure",
      message: "Environment was created but could not be started.",
      details: { stage: "starting" },
    },
    receipt({
      action: "environment.launch",
      requestId: "scenario-1:launch",
      state: "partial",
      stage: "starting",
      resources: { environmentId: "11111111-1111-4111-8111-111111111111" },
      dispatch: { state: "not-sent" },
      error: { code: "setup-failed", message: "Setup script exited with 1" },
    }),
  ),
  runWaitingForInput: publicSuccessEnvelope(
    "run.get",
    null,
    receipt({
      action: "session.start",
      requestId: "scenario-1:prompt",
      state: "running",
      stage: "executing",
      completedAt: undefined,
      dispatch: { state: "accepted" },
      execution: {
        state: "waiting-for-input",
        interactions: [{ id: "q-1", kind: "question", revision: 2, blocking: true }],
      },
    }),
  ),
  runCompleted: publicSuccessEnvelope(
    "run.get",
    null,
    receipt({
      action: "session.start",
      requestId: "scenario-1:prompt",
      state: "succeeded",
      stage: "completed",
      dispatch: { state: "accepted" },
      execution: { state: "completed", evidence: "observed-turn-end" },
    }),
  ),
  historyExpired: publicErrorEnvelope("run.get", {
    code: "history-expired",
    message: "This request key's namespace has been retired; its outcome is no longer retained.",
    details: { namespace: NAMESPACE },
  }),
} satisfies Record<string, PublicActionResponse>;
