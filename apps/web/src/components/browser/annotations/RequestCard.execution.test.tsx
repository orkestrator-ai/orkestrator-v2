import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import type {
  WebAnnotationDestinationOption,
  WebAnnotationFollowUpCandidates,
  WebAnnotationRequest,
  WebAnnotationRequestState,
} from "@orkestrator/protocol/web-annotations";
import { fixtureDestination, fixtureRequest } from "@orkestrator/protocol/web-annotations-fixtures";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import {
  resetConversationScrollTargets,
  useConversationScrollTargetStore,
} from "@/stores/conversationScrollTargetStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { usePromptDraftStore } from "@/stores/promptDraftStore";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import {
  AnnotationHarness,
  seedBrowserLayout,
  useAnnotationUiTestBudget,
} from "@/test/web-annotation-harness";

let backend: FakeWebAnnotationBackend;
let bus: ReturnType<typeof installFakeOrkestrator>;

const OTHER_SESSION: WebAnnotationDestinationOption = {
  destination: {
    ...fixtureDestination,
    tabId: "tab-agent-2",
    logicalSessionKey: "env-env-1:tab-agent-2",
    label: "Codex review",
    agent: "codex",
  },
  title: "Codex review",
  model: null,
  activity: "idle",
  images: true,
  imageSupport: "agent",
  planMode: false,
  resultTools: true,
  holds: [],
  isDefault: false,
};

function seed(state: WebAnnotationRequestState, overrides: Partial<WebAnnotationRequest> = {}) {
  const request = fixtureRequest(state, { id: `request-${state}`, ...overrides });
  backend.requests.set(request.id, request);
  backend.seed({
    id: "annotation-1",
    title: "Save button",
    currentCaptureId: "capture-element",
    requestIds: [request.id],
    activeRequestId: request.reservation ? request.id : null,
  });
  seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-1" }, [
    {
      id: "tab-agent-1",
      type: "agent-native",
      nativeAgentData: { environmentId: "env-1", platform: "claude" },
    },
  ]);
  return request;
}

async function card() {
  return screen.findByRole("article", { name: /with Claude Code/ });
}

function interaction(): AgentInteractionRequest {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id: "interaction-1",
    provider: "claude",
    kind: "question",
    origin: "interactive-native",
    sessionId: "session-1",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    presentation: {
      title: "Claude needs input",
      questions: [
        {
          id: "q0",
          prompt: "Which padding value?",
          required: true,
          multiple: false,
          secret: false,
          allowFreeText: true,
          options: [],
        },
      ],
    },
  };
}

describe("request card execution details", () => {
  useAnnotationUiTestBudget();
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    resetWebAnnotationAssetsForTests();
    resetConversationScrollTargets();
    useNativeAgentProjectionStore.setState({ projections: new Map() });
    window.localStorage.clear();
    bus = installFakeOrkestrator({ capture: createFakeCaptureApi().api });
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    cleanup();
    resetWebAnnotationSyncForTests();
    usePromptDraftStore.getState().reset();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("a failed turn shows the provider error, mode and how a cancel landed", async () => {
    seed("failed", {
      turnOutcome: "failed",
      turnError: "Rate limit exceeded",
      dispatchMode: "session",
      cancelArrivedLate: true,
    });
    render(<AnnotationHarness />);
    const article = await card();
    expect(within(article).getByText("The agent's turn failed: Rate limit exceeded")).toBeTruthy();
    expect(within(article).getByText(/Sent with the session's own mode/)).toBeTruthy();
    expect(
      within(article).getByText(/Stop arrived after the agent had already finished/),
    ).toBeTruthy();
  });

  test("a cancelled request names its cancel source", async () => {
    seed("cancelled", { cancelSource: "chat-queue" });
    render(<AnnotationHarness />);
    const article = await card();
    expect(
      within(article).getByText("Removed from the chat queue before it was sent"),
    ).toBeTruthy();
  });

  test("a failed stop is a visible state and a refused cancel explains why", async () => {
    seed("running", {
      cancelRefusal: { code: "stop-failed", message: "bridge timeout", at: "2026-09-21T12:00:00Z" },
    });
    backend.overrides.set("web_annotation_request_cancel", () => ({
      request: backend.requests.get("request-running"),
      outcome: "not-cancellable",
      refusal: "newer-turn",
    }));
    render(<AnnotationHarness />);
    const article = await card();
    expect(within(article).getByText("Stop failed — may still be running")).toBeTruthy();
    fireEvent.click(within(article).getByRole("button", { name: "Try stopping again" }));
    expect(
      await within(article).findByText(/A newer turn is running in that session/),
    ).toBeTruthy();
  });

  test("a rejected dispatch offers explicit Retry and Cancel", async () => {
    seed("queued", { blockedReason: "dispatch-rejected", stateReason: "Prompt too long" });
    // The retried request stays held until the drain sends it again.
    backend.overrides.set("web_annotation_request_recover", () => ({
      request: backend.requests.get("request-queued"),
    }));
    render(<AnnotationHarness />);
    const article = await card();
    const alert = within(article).getByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(backend.callsOf("web_annotation_request_recover")[0]?.args).toMatchObject({
        requestId: "request-queued",
        action: "retry",
      }),
    );
    fireEvent.click(within(alert).getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(backend.callsOf("web_annotation_request_cancel")).toHaveLength(1));
  });

  test("a deleted destination is retargeted with the same selections", async () => {
    seed("queued", {
      blockedReason: "destination-unavailable",
      destinationMissingAt: "2026-09-21T12:00:00Z",
    });
    backend.destinations = [...backend.destinations, OTHER_SESSION];
    render(<AnnotationHarness />);
    const article = await card();
    expect(within(article).getByText(/no longer exists/)).toBeTruthy();
    fireEvent.click(within(article).getByRole("button", { name: "Send to another session…" }));
    const composer = await screen.findByRole("region", { name: "Ask an agent" });
    // The missing session is not offered again; the other one is labelled.
    const option = await within(composer).findByRole("radio", { name: /Codex review/ });
    expect(within(composer).queryByRole("radio", { name: /Claude Code/ }) === null).toBe(true);
    fireEvent.click(option);
    expect(
      within(composer).getByText(/Images supported by the agent \(model not verified\)/),
    ).toBeTruthy();
    fireEvent.click(within(composer).getByRole("button", { name: /Request changes from/ }));
    await waitFor(() => expect(backend.callsOf("web_annotation_request_prepare")).toHaveLength(1));
    expect(backend.callsOf("web_annotation_request_prepare")[0]!.args).toMatchObject({
      retargetOf: "request-queued",
      annotations: [],
      destination: { tabId: "tab-agent-2" },
    });
    expect(backend.callsOf("web_annotation_request_cancel")).toHaveLength(0);
  });

  test("Discuss is labelled advisory for a session without per-turn plan mode", async () => {
    seed("completed");
    backend.destinations = [OTHER_SESSION];
    render(<AnnotationHarness />);
    await card();
    fireEvent.click(screen.getByRole("button", { name: "Discuss…" }));
    const composer = await screen.findByRole("region", { name: "Ask an agent" });
    fireEvent.click(await within(composer).findByRole("radio", { name: /Codex review/ }));
    expect(
      await within(composer).findByRole("button", {
        name: /Discuss with Codex review \(advisory\)/,
      }),
    ).toBeTruthy();
    expect(composer.querySelector("[data-discuss-advisory]")).toBeTruthy();
  });

  test("pending questions are answered from the panel through the native interaction command", async () => {
    seed("needs-input", {
      interactions: [{ id: "interaction-1", kind: "question", state: "pending", blocking: true }],
    });
    backend.overrides.set("get_native_agent_projection", () => ({
      platform: "claude",
      environmentId: "env-1",
      interactions: [interaction()],
    }));
    backend.overrides.set("resolve_native_agent_interaction", () => ({
      result: "applied",
      interactionId: "interaction-1",
      sessionId: "session-1",
      revision: 2,
    }));
    render(<AnnotationHarness />);
    const article = await card();
    const waiting = within(article).getByRole("region", { name: "Waiting for your answer" });
    const input = await within(waiting).findByLabelText("Which padding value? response");
    fireEvent.change(input, { target: { value: "16px" } });
    fireEvent.click(within(waiting).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(backend.callsOf("resolve_native_agent_interaction")[0]?.args).toMatchObject({
        environmentId: "env-1",
        agent: "claude",
        interactionId: "interaction-1",
        logicalSessionKey: fixtureDestination.logicalSessionKey,
      }),
    );
    fireEvent.click(within(waiting).getByRole("button", { name: "Answer in chat" }));
    const layout = usePaneLayoutStore.getState().environments.get("env-1")!;
    expect((layout.root as { activeTabId: string }).activeTabId).toBe("tab-agent-1");
  });

  test("Open full conversation scrolls the chat to this request's message", async () => {
    seed("completed", {
      transcript: {
        ...fixtureRequest("completed").transcript,
        messageId: "message-42",
        turnId: "turn-7",
      },
    });
    render(<AnnotationHarness />);
    const article = await card();
    fireEvent.click(await within(article).findByRole("button", { name: "Open full conversation" }));
    expect(
      useConversationScrollTargetStore.getState().peek("env-1", fixtureDestination.tabId),
    ).toMatchObject({ messageId: "message-42", turnId: "turn-7" });
  });

  test("linked requests open the thread of a request outside this one", async () => {
    seed("completed", { followUpOf: "request-earlier" });
    backend.requests.set("request-earlier", fixtureRequest("completed", { id: "request-earlier" }));
    render(<AnnotationHarness />);
    const article = await card();
    fireEvent.click(within(article).getByRole("button", { name: "Follows up an earlier request" }));
    await waitFor(() =>
      expect(backend.callsOf("web_annotation_request_get")[0]?.args).toMatchObject({
        requestId: "request-earlier",
      }),
    );
  });

  test("a settled batch sends its remaining work as a follow-up", async () => {
    const base = fixtureRequest("awaiting-review");
    seed("awaiting-review", {
      selections: [
        base.selections[0]!,
        { ...base.selections[0]!, annotationId: "annotation-2", reference: 2 },
      ],
    });
    backend.seed({ id: "annotation-2", title: "Cancel link" });
    const candidates: WebAnnotationFollowUpCandidates = {
      requestId: "request-awaiting-review",
      remaining: [
        {
          annotationId: "annotation-2",
          reference: 2,
          reason: "not-addressed",
          previousOutcome: "not-addressed",
        },
      ],
      excluded: [{ annotationId: "annotation-1", reference: 1, reason: "accepted" }],
      resultId: null,
    };
    backend.overrides.set("web_annotation_request_follow_up", () => candidates);
    render(<AnnotationHarness />);
    const article = await card();
    fireEvent.click(within(article).getByRole("button", { name: "Send remaining work…" }));
    const preview = await within(article).findByRole("region", { name: "Send remaining work" });
    expect(await within(preview).findByText(/not addressed yet/)).toBeTruthy();
    expect(within(preview).getByText(/left out: accepted/)).toBeTruthy();
    fireEvent.click(within(preview).getByRole("button", { name: "Continue with 1 note" }));
    const composer = await screen.findByRole("region", { name: "Ask an agent" });
    expect(composer.querySelector('[data-composer-reference="follow-up"]')).toBeTruthy();
    fireEvent.click(await within(composer).findByRole("radio", { name: /Claude Code/ }));
    fireEvent.click(within(composer).getByRole("button", { name: /Request changes from/ }));
    await waitFor(() => expect(backend.callsOf("web_annotation_request_prepare")).toHaveLength(1));
    const args = backend.callsOf("web_annotation_request_prepare")[0]!.args as {
      followUpOf?: string;
      annotations: Array<{ annotationId: string }>;
    };
    expect(args.followUpOf).toBe("request-awaiting-review");
    expect(args.annotations.map((item) => item.annotationId)).toEqual(["annotation-2"]);
  });
});
