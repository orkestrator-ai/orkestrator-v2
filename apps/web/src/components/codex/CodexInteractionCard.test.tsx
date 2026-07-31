import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCodexStore } from "@/stores/codexStore";
import {
  codexInteractionDraftKey,
  usePromptDraftStore,
} from "@/stores/promptDraftStore";
import type {
  CodexApprovalResponseResult,
  CodexInteraction,
  CodexInteractionAnswer,
} from "@/lib/codex-client";
import { mockToastError } from "../../../../../tests/mocks/sonner";

// `respondToInteraction` is the only thing this card talks to, and its *return
// value* (never a throw) is the whole point of the error handling under test.
// Everything else in `@/lib/codex-client` stays real so no sibling suite loses
// the genuine module.
import * as realCodexClient from "@/lib/codex-client";
import * as realBackend from "@/lib/backend";
const realCodexClientSnapshot = { ...realCodexClient };
const realBackendSnapshot = { ...realBackend };

const mockRespondToInteraction = mock<
  (
    _client: unknown,
    _sessionId: string,
    _interactionId: string,
    _answer: CodexInteractionAnswer,
  ) => Promise<CodexApprovalResponseResult>
>(async () => "applied");
const mockOpenInBrowser = mock(async (_url: string) => undefined);
const mockFetchPendingInteractions = mock(async () => [] as CodexInteraction[]);

mock.module("@/lib/codex-client", () => ({
  ...realCodexClientSnapshot,
  respondToInteraction: mockRespondToInteraction,
  fetchPendingInteractions: mockFetchPendingInteractions,
}));
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  openInBrowser: mockOpenInBrowser,
}));

const { CodexInteractionCard } = await import("./CodexInteractionCard");

afterAll(() => {
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const CLIENT = { baseUrl: "http://127.0.0.1:9999" } as never;
const SESSION_ID = "session-1";
const SESSION_KEY = "env-env-1:tab-1";

function createInteraction(overrides: Partial<CodexInteraction> = {}): CodexInteraction {
  return {
    interactionId: "interaction-1",
    kind: "question",
    method: "item/question/request",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
    questions: [
      {
        id: "q1",
        header: "Deployment",
        question: "Which environment should I target?",
        isOther: false,
        isSecret: false,
        options: [
          { label: "staging", description: "Safe" },
          { label: "production" },
        ],
      },
    ],
    ...overrides,
  };
}

function renderCard(interaction: CodexInteraction) {
  return render(
    <CodexInteractionCard
      interaction={interaction}
      client={CLIENT}
      sessionId={SESSION_ID}
      sessionKey={SESSION_KEY}
    />,
  );
}

function seedPending(interaction: CodexInteraction) {
  useCodexStore.setState({
    pendingInteractions: new Map([[SESSION_KEY, [interaction]]]),
  });
}

beforeEach(() => {
  mockRespondToInteraction.mockClear();
  mockRespondToInteraction.mockImplementation(async () => "applied");
  mockOpenInBrowser.mockClear();
  mockOpenInBrowser.mockImplementation(async () => undefined);
  mockFetchPendingInteractions.mockReset();
  mockFetchPendingInteractions.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  useCodexStore.setState({ pendingInteractions: new Map() });
  // Drafts persist across unmount by design and this suite reuses interaction
  // ids; the setState above bypasses the store actions that would clear them.
  usePromptDraftStore.getState().reset();
});

describe("CodexInteractionCard question branch", () => {
  test("submits the label of the selected option and clears the pending card", async () => {
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    expect(screen.getByText("Codex has a question")).toBeTruthy();
    // Nothing is selected yet, so submission is impossible.
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /production/ }));
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]).toEqual([
      CLIENT,
      SESSION_ID,
      "interaction-1",
      { action: "accept", answers: { q1: ["production"] } },
    ]);
    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );
  });

  test("keeps two options with the same label independently selectable", async () => {
    // `parseInteractionQuestion` does not de-duplicate labels and the labels are
    // MCP-supplied. Keyed/selected by label these rendered as one control and
    // produced an ambiguous answer.
    const interaction = createInteraction({
      questions: [
        {
          id: "q1",
          header: "Pick",
          question: "Which deploy target?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "deploy", description: "the staging cluster" },
            { label: "deploy", description: "the production cluster" },
          ],
        },
      ],
    });
    seedPending(interaction);
    renderCard(interaction);

    const options = screen.getAllByRole("button", { name: /deploy/ });
    expect(options).toHaveLength(2);

    fireEvent.click(options[1]!);
    expect(options[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(options[1]!.getAttribute("aria-pressed")).toBe("true");

    // Selecting the second one must not also light up the first, and the
    // submitted answer is still the label.
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]?.[3]).toEqual({
      action: "accept",
      answers: { q1: ["deploy"] },
    });
  });

  test("offers a free-text field for an isOther question and submits what was typed", async () => {
    const interaction = createInteraction({
      questions: [
        {
          id: "q1",
          header: "Other",
          question: "Anything else?",
          isOther: true,
          isSecret: false,
          options: [{ label: "no" }],
        },
      ],
    });
    seedPending(interaction);
    renderCard(interaction);

    const input = screen.getByPlaceholderText("Type your answer") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("text");

    fireEvent.change(input, { target: { value: "roll back first" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]?.[3]).toEqual({
      action: "accept",
      answers: { q1: ["roll back first"] },
    });
  });

  test("custom text replaces a selected option for a mutually-exclusive question", async () => {
    const interaction = createInteraction({
      questions: [
        {
          id: "q1",
          header: "Other",
          question: "Anything else?",
          isOther: true,
          isSecret: false,
          options: [{ label: "no" }],
        },
      ],
    });
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /^no/ }));
    fireEvent.change(screen.getByPlaceholderText("Type your answer"), {
      target: { value: "actually yes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]?.[3]).toEqual({
      action: "accept",
      answers: { q1: ["actually yes"] },
    });
  });

  test("renders a secret question as a password field", () => {
    const interaction = createInteraction({
      questions: [
        {
          id: "q1",
          header: "Token",
          question: "Paste the deploy token",
          isOther: false,
          isSecret: true,
        },
      ],
    });
    seedPending(interaction);
    renderCard(interaction);

    const input = screen.getByPlaceholderText("Type your answer");
    expect(input.getAttribute("type")).toBe("password");
    // A question with no options still needs the free-text escape hatch.
    expect(screen.queryAllByRole("button", { name: /Submit|Cancel/ })).toHaveLength(2);
  });

  test("keeps a secret answer out of drafts and loses it on unmount", () => {
    const interaction = createInteraction({
      questions: [
        {
          id: "q1",
          header: "Token",
          question: "Paste the deploy token",
          isOther: false,
          isSecret: true,
        },
      ],
    });
    seedPending(interaction);
    const { unmount } = renderCard(interaction);

    const input = screen.getByPlaceholderText("Type your answer") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sensitive-value" } });
    expect(input.value).toBe("sensitive-value");
    expect(
      usePromptDraftStore.getState().drafts.has(
        codexInteractionDraftKey(SESSION_KEY, interaction.interactionId),
      ),
    ).toBe(false);

    unmount();
    renderCard(interaction);
    expect((screen.getByPlaceholderText("Type your answer") as HTMLInputElement).value).toBe("");
  });

  test("submits a complete answer map keyed by each provider question id", async () => {
    const interaction = createInteraction({
      questions: [
        {
          id: "q1",
          header: "One",
          question: "First?",
          isOther: false,
          isSecret: false,
          options: [{ label: "yes" }],
        },
        {
          id: "q2",
          header: "Two",
          question: "Second?",
          isOther: false,
          isSecret: false,
          options: [{ label: "also yes" }],
        },
      ],
    });
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /^yes/ }));
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.click(screen.getByRole("button", { name: /also yes/ }));
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]?.[3]).toEqual({
      action: "accept",
      answers: {
        q1: ["yes"],
        q2: ["also yes"],
      },
    });
  });
});

describe("CodexInteractionCard failure handling", () => {
  test.each([
    ["forbidden" as const, /refused/i],
    ["error" as const, /Could not send/i],
  ])("keeps the card mounted and reports %s", async (result, messagePattern) => {
    mockRespondToInteraction.mockImplementation(async () => result);
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // The turn is still blocked on this interaction, so the card must survive,
    // say what went wrong, and re-enable its controls for a retry.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(messagePattern);
    expect(mockToastError).toHaveBeenCalled();
    expect(
      (useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).length,
    ).toBe(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
  });

  test("a retry that succeeds clears the inline error and removes the card", async () => {
    mockRespondToInteraction.mockImplementation(async () => "error");
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByRole("alert");

    mockRespondToInteraction.mockImplementation(async () => "applied");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("reconciles an ambiguous transport outcome before offering a retry", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    const interaction = createInteraction();
    mockFetchPendingInteractions.mockResolvedValue([interaction]);
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mockFetchPendingInteractions).toHaveBeenCalledWith(CLIENT, SESSION_ID));
    expect((await screen.findByRole("alert")).textContent).toMatch(/safe to retry/i);
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);
  });

  test("removes an interaction when reconciliation proves an ambiguous response resolved", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    mockFetchPendingInteractions.mockResolvedValue([]);
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );
  });

  test("blocks question submission when an unknown outcome cannot be reconciled", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    mockFetchPendingInteractions.mockRejectedValue(new Error("bridge offline"));
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/outcome is unknown/i);
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  });

  test("a stale response still clears the card", async () => {
    mockRespondToInteraction.mockImplementation(async () => "stale");
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("disables both controls while a response is in flight", async () => {
    let release: (value: CodexApprovalResponseResult) => void = () => {};
    mockRespondToInteraction.mockImplementation(
      () => new Promise<CodexApprovalResponseResult>((resolve) => {
        release = resolve;
      }),
    );
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);

    release("applied");
    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );
  });

  test("an interaction whose deadline passes while it is open stays answerable", async () => {
    /*
     * Expiry is the bridge's call, not the card's. A client-side timer that
     * disabled the controls would strand the user in front of a question they
     * can no longer answer while the turn is still parked on it — and the
     * clocks are not necessarily the same. The card keeps working; the bridge
     * answers `stale` if it really has moved on, which clears the card.
     */
    const expired = createInteraction({
      requestedAt: Date.now() - 600_000,
      expiresAt: Date.now() - 300_000,
    });
    seedPending(expired);
    renderCard(expired);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit.hasAttribute("disabled")).toBe(false);

    mockRespondToInteraction.mockImplementation(async () => "stale");
    fireEvent.click(submit);

    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]?.[3]).toEqual({
      action: "accept",
      answers: { q1: ["staging"] },
    });
    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a reconcile that withdraws an expired interaction empties the authoritative store entry", () => {
    /*
     * The bridge withdraws an expired interaction on its next snapshot, and
     * `/session/:id/interactions` — not the SSE frame the tab may have missed —
     * is what the tab rehydrates from. Pin that a withdrawal reaches the store
     * even while a card for it is mounted, so the tab stops rendering it.
     */
    const interaction = createInteraction({ expiresAt: Date.now() - 1_000 });
    seedPending(interaction);
    renderCard(interaction);
    expect(screen.getByText("Codex has a question")).toBeTruthy();

    useCodexStore.getState().setPendingInteractions(SESSION_KEY, []);

    expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);
    // The mounted card never posted anything on its own behalf.
    expect(mockRespondToInteraction).not.toHaveBeenCalled();
  });

  test("cancel posts a bare cancel action with no answers", async () => {
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]?.[3]).toEqual({ action: "cancel" });
  });

  test("keeps cancel retryable when reconciliation shows the question still pending", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    const interaction = createInteraction();
    mockFetchPendingInteractions.mockResolvedValue([interaction]);
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(mockFetchPendingInteractions).toHaveBeenCalledWith(CLIENT, SESSION_ID),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/still waiting/i);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
  });

  test("removes the question when cancel reconciliation shows it absent", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    mockFetchPendingInteractions.mockResolvedValue([]);
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );
  });

  test("blocks question controls when cancel reconciliation fails", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    mockFetchPendingInteractions.mockRejectedValue(new Error("bridge offline"));
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/cancellation outcome is unknown/i);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("CodexInteractionCard draft persistence", () => {
  test("a selection and typed answer survive unmount and remount", () => {
    /**
     * The tab unmounts when the user switches environments while the pending
     * interaction rehydrates from the store — so in-progress input must
     * rehydrate with it rather than vanish.
     */
    const interaction = createInteraction({
      questions: [
        {
          id: "q1",
          header: "Other",
          question: "Anything else?",
          isOther: true,
          isSecret: false,
          options: [{ label: "no" }],
        },
      ],
    });
    seedPending(interaction);
    const { unmount } = renderCard(interaction);

    fireEvent.change(screen.getByPlaceholderText("Type your answer"), {
      target: { value: "half-typed reply" },
    });

    unmount();
    renderCard(interaction);

    expect(
      (screen.getByPlaceholderText("Type your answer") as HTMLInputElement).value,
    ).toBe("half-typed reply");
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);
  });

  test("a successful submit clears the stored draft", async () => {
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    const draftKey = codexInteractionDraftKey(SESSION_KEY, interaction.interactionId);
    expect(usePromptDraftStore.getState().drafts.has(draftKey)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );

    // A future interaction reusing this id must not inherit the selection.
    expect(usePromptDraftStore.getState().drafts.has(draftKey)).toBe(false);
  });

  test("a reconcile that withdraws the interaction clears its draft", () => {
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    const draftKey = codexInteractionDraftKey(SESSION_KEY, interaction.interactionId);
    expect(usePromptDraftStore.getState().drafts.has(draftKey)).toBe(true);

    useCodexStore.getState().setPendingInteractions(SESSION_KEY, []);

    expect(usePromptDraftStore.getState().drafts.has(draftKey)).toBe(false);
  });
});

describe("CodexInteractionCard mcp-form branch", () => {
  const formInteraction = createInteraction({
    interactionId: "interaction-form",
    kind: "mcp-form",
    questions: undefined,
    serverName: "deploy-mcp",
    message: "Provide the release details",
    schema: {
      required: ["release"],
      properties: {
        release: { type: "string", title: "Release name" },
        count: { type: "integer", title: "Replica count" },
        channel: { type: "string", title: "Channel", enum: ["beta", "stable"] },
        force: { type: "boolean", title: "Force" },
        notes: { type: "string", description: "Optional notes" },
      },
    },
  });

  test("renders a field per schema property with the server name and message", () => {
    seedPending(formInteraction);
    renderCard(formInteraction);

    expect(screen.getByText("MCP input requested")).toBeTruthy();
    expect(screen.getByText("Provide the release details")).toBeTruthy();
    expect(screen.getByText("deploy-mcp")).toBeTruthy();
    // Required fields are marked, optional ones are not.
    expect(screen.getByText("Release name *")).toBeTruthy();
    expect(screen.getByText("Replica count")).toBeTruthy();
    expect(screen.getByText("Optional notes")).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  test("blocks submission until every required field has a value", () => {
    seedPending(formInteraction);
    const { container } = renderCard(formInteraction);

    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
    const textInputs = container.querySelectorAll('input[type="text"]');
    fireEvent.change(textInputs[0]!, { target: { value: "v2.4.0" } });
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);
  });

  test("coerces numeric fields to numbers and keeps an emptied one as an empty string", async () => {
    // Keep the interaction unresolved between the two submits: a successful
    // submit removes it from the store and clears the form draft with it, so
    // the second payload would no longer describe the same filled-in form.
    mockRespondToInteraction.mockImplementation(async () => "error");
    seedPending(formInteraction);
    const { container } = renderCard(formInteraction);

    const textInputs = container.querySelectorAll('input[type="text"]');
    fireEvent.change(textInputs[0]!, { target: { value: "v2.4.0" } });
    const numberInput = container.querySelector('input[type="number"]')!;
    fireEvent.change(numberInput, { target: { value: "3" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stable" } });
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    const answer = mockRespondToInteraction.mock.calls[0]?.[3] as {
      action: string;
      content: Record<string, unknown>;
    };
    expect(answer.action).toBe("accept");
    // A JSON-schema `integer` must go over the wire as a number, not "3".
    expect(answer.content).toEqual({
      release: "v2.4.0",
      count: 3,
      channel: "stable",
      force: true,
    });

    fireEvent.change(numberInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(2));
    const second = mockRespondToInteraction.mock.calls[1]?.[3] as {
      content: Record<string, unknown>;
    };
    expect(second.content.count).toBe("");
  });

  test("never sends NaN for a numeric field that cannot be parsed", async () => {
    /*
     * `JSON.stringify(NaN)` is `null`, so an unparseable numeric field would
     * reach the MCP server as a silently wrong value rather than as a refusal.
     * It degrades to the emptied-field state instead, which the required check
     * already blocks.
     */
    seedPending(formInteraction);
    const { container } = renderCard(formInteraction);

    const textInputs = container.querySelectorAll('input[type="text"]');
    fireEvent.change(textInputs[0]!, { target: { value: "v2.4.0" } });
    const numberInput = container.querySelector('input[type="number"]')!;
    fireEvent.change(numberInput, { target: { value: "3" } });
    fireEvent.change(numberInput, { target: { value: "not a number" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    const answer = mockRespondToInteraction.mock.calls[0]?.[3] as {
      content: Record<string, unknown>;
    };
    expect(Number.isNaN(answer.content.count)).toBe(false);
    expect(answer.content.count).toBe("");
    expect(answer.content.release).toBe("v2.4.0");
  });

  test("blocks submission when a required numeric field holds unparseable text", () => {
    const requiredNumber = createInteraction({
      interactionId: "interaction-required-number",
      kind: "mcp-form",
      questions: undefined,
      schema: {
        required: ["count"],
        properties: { count: { type: "integer", title: "Replica count" } },
      },
    });
    seedPending(requiredNumber);
    const { container } = renderCard(requiredNumber);

    const numberInput = container.querySelector('input[type="number"]')!;
    fireEvent.change(numberInput, { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);

    fireEvent.change(numberInput, { target: { value: "12e" } });
    // The required check treats "" as unanswered, so garbage cannot be sent.
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
  });

  test("submits no answers key for a form interaction", async () => {
    seedPending(formInteraction);
    const { container } = renderCard(formInteraction);
    fireEvent.change(container.querySelectorAll('input[type="text"]')[0]!, {
      target: { value: "v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(
      Object.keys(mockRespondToInteraction.mock.calls[0]?.[3] as object),
    ).toEqual(["action", "content"]);
  });

  test("keeps sensitive MCP values out of drafts, loses them on unmount, and submits them", async () => {
    const sensitiveInteraction = createInteraction({
      interactionId: "interaction-sensitive-form",
      kind: "mcp-form",
      questions: undefined,
      schema: {
        required: ["apiToken"],
        properties: {
          apiToken: { type: "string", title: "API token", writeOnly: true },
        },
      },
    });
    seedPending(sensitiveInteraction);
    const { unmount } = renderCard(sensitiveInteraction);

    const password = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(password, { target: { value: "sensitive-value" } });
    expect(password.value).toBe("sensitive-value");
    expect(
      usePromptDraftStore.getState().drafts.has(
        codexInteractionDraftKey(SESSION_KEY, sensitiveInteraction.interactionId),
      ),
    ).toBe(false);

    unmount();
    renderCard(sensitiveInteraction);
    const remountedPassword = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(remountedPassword.value).toBe("");
    fireEvent.change(remountedPassword, { target: { value: "replacement-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]?.[3]).toEqual({
      action: "accept",
      content: { apiToken: "replacement-value" },
    });
  });

  test("keeps an MCP form retryable when unknown-outcome reconciliation finds it pending", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    mockFetchPendingInteractions.mockResolvedValue([formInteraction]);
    seedPending(formInteraction);
    const { container } = renderCard(formInteraction);
    fireEvent.change(container.querySelectorAll('input[type="text"]')[0]!, {
      target: { value: "v1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/safe to retry/i);
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);
  });

  test("removes an MCP form when unknown-outcome reconciliation shows it absent", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    mockFetchPendingInteractions.mockResolvedValue([]);
    seedPending(formInteraction);
    const { container } = renderCard(formInteraction);
    fireEvent.change(container.querySelectorAll('input[type="text"]')[0]!, {
      target: { value: "v1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );
  });

  test("blocks an MCP form retry when unknown-outcome reconciliation fails", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    mockFetchPendingInteractions.mockRejectedValue(new Error("bridge offline"));
    seedPending(formInteraction);
    const { container } = renderCard(formInteraction);
    fireEvent.change(container.querySelectorAll('input[type="text"]')[0]!, {
      target: { value: "v1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/outcome is unknown/i);
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("CodexInteractionCard mcp-url branch", () => {
  function urlInteraction(url: string | undefined): CodexInteraction {
    return createInteraction({
      interactionId: "interaction-url",
      kind: "mcp-url",
      questions: undefined,
      ...(url === undefined ? {} : { url }),
    });
  }

  test("opens an https URL through the desktop-aware browser helper", async () => {
    const interaction = urlInteraction("https://example.com/form?id=1");
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /Open secure form/ }));
    await waitFor(() =>
      expect(mockOpenInBrowser).toHaveBeenCalledWith("https://example.com/form?id=1"),
    );
  });

  test("keeps the card usable and surfaces a native browser failure", async () => {
    mockOpenInBrowser.mockImplementation(async () => {
      throw new Error("desktop command failed");
    });
    const interaction = urlInteraction("https://example.com/form");
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /Open secure form/ }));

    const message =
      "Could not open the MCP form in your browser. Check the desktop connection and try again.";
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
    expect(mockToastError).toHaveBeenCalledWith(message);
    expect(screen.getByRole("button", { name: /Open secure form/ })).toBeTruthy();
  });

  test.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["file:///etc/passwd"],
    ["vbscript:msgbox(1)"],
  ])("refuses to render a link for %s", (url) => {
    // The allowlist is what stands between MCP-supplied text and the native
    // system-browser command.
    const interaction = urlInteraction(url);
    seedPending(interaction);
    renderCard(interaction);

    expect(screen.queryByRole("button", { name: /Open secure form/ })).toBeNull();
    // With no usable URL there is nothing to complete, so the action is blocked.
    expect(
      screen.getByRole("button", { name: /I.?ve completed it/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(mockOpenInBrowser).not.toHaveBeenCalled();
  });

  test("a malformed URL degrades to no link instead of throwing", () => {
    const interaction = urlInteraction("not a url at all");
    seedPending(interaction);
    expect(() => renderCard(interaction)).not.toThrow();
    expect(screen.queryByRole("button", { name: /Open secure form/ })).toBeNull();
  });

  test("a missing URL degrades to no link", () => {
    const interaction = urlInteraction(undefined);
    seedPending(interaction);
    renderCard(interaction);
    expect(screen.queryByRole("button", { name: /Open secure form/ })).toBeNull();
  });

  test("confirming completion accepts with neither answers nor content", async () => {
    const interaction = urlInteraction("http://localhost:8080/form");
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /I.?ve completed it/ }));
    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]?.[3]).toEqual({ action: "accept" });
  });

  test("removes an MCP URL interaction when unknown reconciliation proves it resolved", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    mockFetchPendingInteractions.mockResolvedValue([]);
    const interaction = urlInteraction("https://example.com/form");
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /I.?ve completed it/ }));

    await waitFor(() =>
      expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY) ?? []).toEqual([]),
    );
  });

  test("keeps an MCP URL interaction retryable when unknown reconciliation finds it pending", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    const interaction = urlInteraction("https://example.com/form");
    mockFetchPendingInteractions.mockResolvedValue([interaction]);
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /I.?ve completed it/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/safe to retry/i);
    expect(
      screen.getByRole("button", { name: /I.?ve completed it/ }).hasAttribute("disabled"),
    ).toBe(false);
  });

  test("blocks an MCP URL retry when unknown-outcome reconciliation fails", async () => {
    mockRespondToInteraction.mockResolvedValue("unknown");
    mockFetchPendingInteractions.mockRejectedValue(new Error("bridge offline"));
    const interaction = urlInteraction("https://example.com/form");
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /I.?ve completed it/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/outcome is unknown/i);
    expect(
      screen.getByRole("button", { name: /I.?ve completed it/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  });
});
