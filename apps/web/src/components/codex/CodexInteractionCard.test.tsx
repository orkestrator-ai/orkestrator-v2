import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCodexStore } from "@/stores/codexStore";
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
const realCodexClientSnapshot = { ...realCodexClient };

const mockRespondToInteraction = mock<
  (
    _client: unknown,
    _sessionId: string,
    _interactionId: string,
    _answer: CodexInteractionAnswer,
  ) => Promise<CodexApprovalResponseResult>
>(async () => "applied");

mock.module("@/lib/codex-client", () => ({
  ...realCodexClientSnapshot,
  respondToInteraction: mockRespondToInteraction,
}));

const { CodexInteractionCard } = await import("./CodexInteractionCard");

afterAll(() => {
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
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

let originalOpen: typeof window.open;
let openCalls: Array<[string | URL | undefined, string | undefined]> = [];

beforeEach(() => {
  mockRespondToInteraction.mockClear();
  mockRespondToInteraction.mockImplementation(async () => "applied");
  openCalls = [];
  originalOpen = window.open;
  window.open = ((url?: string | URL, target?: string) => {
    openCalls.push([url, target]);
    return null;
  }) as typeof window.open;
});

afterEach(() => {
  cleanup();
  window.open = originalOpen;
  useCodexStore.setState({ pendingInteractions: new Map() });
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

  test("typing clears a selected option so only one answer is submitted", async () => {
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

  test("requires an answer for every question before submitting", () => {
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
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /also yes/ }));
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);
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

  test("cancel posts a bare cancel action with no answers", async () => {
    const interaction = createInteraction();
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(mockRespondToInteraction).toHaveBeenCalledTimes(1));
    expect(mockRespondToInteraction.mock.calls[0]?.[3]).toEqual({ action: "cancel" });
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

  test("opens an https URL in a new tab with noopener", () => {
    const interaction = urlInteraction("https://example.com/form?id=1");
    seedPending(interaction);
    renderCard(interaction);

    fireEvent.click(screen.getByRole("button", { name: /Open secure form/ }));
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]?.[0]).toBe("https://example.com/form?id=1");
    expect(openCalls[0]?.[1]).toBe("_blank");
  });

  test.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["file:///etc/passwd"],
    ["vbscript:msgbox(1)"],
  ])("refuses to render a link for %s", (url) => {
    // The allowlist is what stands between MCP-supplied text and `window.open`.
    const interaction = urlInteraction(url);
    seedPending(interaction);
    renderCard(interaction);

    expect(screen.queryByRole("button", { name: /Open secure form/ })).toBeNull();
    // With no usable URL there is nothing to complete, so the action is blocked.
    expect(
      screen.getByRole("button", { name: /I.?ve completed it/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(openCalls).toHaveLength(0);
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
});
