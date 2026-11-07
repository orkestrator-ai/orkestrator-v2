import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionResolution,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import { NativeAgentInteractionCard } from "./NativeAgentInteractionCard";
import { promptDraftStore } from "@/stores/promptDraftStore";
import { appCommandStore } from "@/test/app-command-store";

afterEach(() => {
  cleanup();
  appCommandStore(promptDraftStore).getState().reset();
});

function interaction(secret: boolean): AgentInteractionRequest {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id: "interaction-1",
    provider: "opencode",
    kind: "question",
    origin: "interactive-native",
    sessionId: "session-1",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    presentation: {
      title: "Credentials required",
      questions: [
        {
          id: "token",
          prompt: "Access token",
          required: true,
          multiple: false,
          secret,
          allowFreeText: true,
          options: [],
        },
      ],
    },
  };
}

describe("NativeAgentInteractionCard", () => {
  test("masks secret answers and sends them only in the live resolution", async () => {
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: "interaction-1",
      sessionId: "session-1",
      revision: 2,
    }));
    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={interaction(true)} onResolve={onResolve} />,
    );

    const input = screen.getByLabelText("Access token response") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    fireEvent.change(input, { target: { value: "secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      action: "answer",
      answer: {
        answers: [{ questionId: "token", freeText: "secret-value" }],
      },
    });
  });

  test("uses a multiline field for non-secret free text", () => {
    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={interaction(false)}
        onResolve={async () => ({
          result: "applied",
          interactionId: "interaction-1",
          sessionId: "session-1",
          revision: 2,
        })}
      />,
    );

    expect(screen.getByLabelText("Access token response").tagName).toBe("TEXTAREA");
  });

  test("keeps single-choice options and custom text mutually exclusive", async () => {
    const request = interaction(false);
    request.presentation.questions[0] = {
      ...request.presentation.questions[0]!,
      prompt: "Language",
      options: [
        { id: "typescript", label: "TypeScript", providerValue: "TypeScript" },
        { id: "rust", label: "Rust", providerValue: "Rust" },
      ],
    };
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: request.id,
      sessionId: request.sessionId,
      revision: 2,
    }));
    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={request} onResolve={onResolve} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "TypeScript" }));
    fireEvent.change(screen.getByLabelText("Language response"), {
      target: { value: "Zig" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      answer: { answers: [{ questionId: "token", freeText: "Zig" }] },
    });
    expect(onResolve.mock.calls[0]?.[0].answer?.answers[0]?.optionIds).toBeUndefined();
  });

  test("renders typed MCP schema fields and serializes the object response", async () => {
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: "mcp-1",
      sessionId: "session-1",
      revision: 2,
    }));
    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={{
          ...interaction(false),
          id: "mcp-1",
          provider: "codex",
          kind: "mcp-form",
          presentation: {
            title: "MCP input requested",
            questions: [
              {
                id: "mcp-form-content",
                prompt: "Form",
                description: JSON.stringify({
                  type: "object",
                  required: ["count", "mode"],
                  properties: {
                    count: { type: "integer", title: "Count" },
                    mode: { type: "string", enum: ["safe", "fast"], title: "Mode" },
                    enabled: { type: "boolean", title: "Enabled" },
                    token: { type: "string", format: "password", title: "Token" },
                  },
                }),
                required: true,
                multiple: false,
                secret: false,
                allowFreeText: true,
                options: [],
              },
            ],
            confirmLabel: "Submit",
          },
        }}
        onResolve={onResolve}
      />,
    );
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "safe" } });
    fireEvent.click(screen.getByLabelText("Enabled"));
    const token = screen.getByLabelText("Token") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    const freeText = (onResolve.mock.calls[0]![0] as AgentInteractionResolution).answer?.answers[0]
      ?.freeText;
    expect(JSON.parse(freeText ?? "{}")).toEqual({
      count: 3,
      mode: "safe",
      enabled: true,
      token: "secret",
    });
  });

  test.each(["text", "password"])("MCP %s input submits with the shortcut", async (type) => {
    const request: AgentInteractionRequest = {
      ...interaction(false),
      kind: "mcp-form",
      presentation: {
        title: "MCP input requested",
        questions: [
          {
            ...interaction(false).presentation.questions[0]!,
            id: "mcp-form-content",
            description: JSON.stringify({
              type: "object",
              required: ["value"],
              properties: {
                value: {
                  type: "string",
                  title: "Value",
                  ...(type === "password" ? { format: "password" } : {}),
                },
              },
            }),
          },
        ],
      },
    };
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: request.id,
      sessionId: request.sessionId,
      revision: 2,
    }));
    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={request} onResolve={onResolve} />,
    );
    const field = screen.getByLabelText("Value") as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
    expect(field.type).toBe(type);
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "fixture-answer" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter", [type === "text" ? "metaKey" : "ctrlKey"]: true });
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      action: "answer",
      answer: {
        answers: [
          { questionId: "mcp-form-content", freeText: JSON.stringify({ value: "fixture-answer" }) },
        ],
      },
    });
  });

  test("preserves non-secret drafts across unmount and exposes safe approval actions", async () => {
    const request: AgentInteractionRequest = {
      ...interaction(false),
      provider: "codex",
      kind: "command-approval",
      presentation: {
        title: "Approve command",
        body: "Command: bun test",
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
        approveForSessionLabel: "Approve for session",
      },
    };
    const onResolve = mock(async (resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: resolution.interactionId,
      sessionId: resolution.sessionId,
      revision: 2,
    }));
    const view = renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={interaction(false)} onResolve={onResolve} />,
    );
    fireEvent.change(screen.getByLabelText("Access token response"), {
      target: { value: "remember me" },
    });
    view.unmount();
    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={interaction(false)} onResolve={onResolve} />,
    );
    expect((screen.getByLabelText("Access token response") as HTMLTextAreaElement).value).toBe(
      "remember me",
    );
    cleanup();
    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={request} onResolve={onResolve} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve for session" }));
    await waitFor(() =>
      expect(onResolve.mock.calls.at(-1)?.[0]).toMatchObject({
        action: "approve-for-session",
      }),
    );
    expect(screen.getByRole("button", { name: "Cancel turn" })).toBeTruthy();
  });

  test("offers Approve and remember only with a rule offer, showing the exact pattern first", async () => {
    const base: AgentInteractionRequest = {
      ...interaction(false),
      provider: "codex",
      kind: "command-approval",
      presentation: {
        title: "Approve command",
        body: "Command: npm run test -- --watch",
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
      },
    };
    const onResolve = mock(async (resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: resolution.interactionId,
      sessionId: resolution.sessionId,
      revision: 2,
    }));
    const onApproveAndRemember = mock(async (_choice: unknown) => ({
      result: "applied" as const,
      interactionId: "interaction-1",
      sessionId: "session-1",
      revision: 2,
    }));
    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={base}
        onResolve={onResolve}
        onApproveAndRemember={onApproveAndRemember}
      />,
    );
    // No offer from the backend: no option.
    expect(screen.queryByRole("button", { name: "Approve and remember…" }) === null).toBe(true);
    cleanup();

    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={{
          ...base,
          presentation: {
            ...base.presentation,
            ruleOffer: {
              kind: "command-prefix",
              patterns: ["npm run test -- --watch", "npm run test --", "npm run test", "npm run"],
              suggested: 2,
            },
          },
        }}
        onResolve={onResolve}
        onApproveAndRemember={onApproveAndRemember}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve and remember…" }));
    const panel = screen.getByTestId("remember-rule-panel");
    expect(panel.textContent).toContain("npm run test -- --watch");
    expect(panel.textContent).toContain("(narrowest)");
    // The provider's own proposal is preselected.
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([false, false, true, false]);
    fireEvent.click(radios[0]!);
    fireEvent.click(screen.getByRole("button", { name: "This environment" }));
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve and remember" }));
    await waitFor(() => expect(onApproveAndRemember).toHaveBeenCalledTimes(1));
    expect(onApproveAndRemember.mock.calls[0]![0]).toEqual({
      pattern: "npm run test -- --watch",
      scope: "environment",
      anyProvider: false,
      expiresInMs: 7 * 24 * 60 * 60 * 1_000,
    });
    expect(onResolve).not.toHaveBeenCalled();
  });

  test("explains why a request can't be remembered", () => {
    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={{
          ...interaction(false),
          provider: "codex",
          kind: "command-approval",
          presentation: {
            title: "Approve command",
            questions: [],
            ruleOffer: {
              kind: "command-prefix",
              patterns: [],
              suggested: 0,
              unavailableReason: "This command uses shell operators.",
            },
          },
        }}
        onResolve={mock(async () => ({
          result: "applied" as const,
          interactionId: "interaction-1",
          sessionId: "session-1",
          revision: 2,
        }))}
        onApproveAndRemember={mock(async () => ({
          result: "applied" as const,
          interactionId: "interaction-1",
          sessionId: "session-1",
          revision: 2,
        }))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve and remember…" }));
    expect(screen.getByTestId("remember-rule-panel").textContent).toContain(
      "This command uses shell operators.",
    );
    expect(screen.queryByRole("button", { name: "Approve and remember" }) === null).toBe(true);
  });

  test("submits an explicitly selected provider amendment with an approval", async () => {
    const request: AgentInteractionRequest = {
      ...interaction(false),
      provider: "codex",
      kind: "command-approval",
      presentation: {
        title: "Approve command",
        questions: [
          {
            id: "codex-approval-amendment",
            prompt: "Broader approval (optional)",
            required: false,
            multiple: false,
            secret: false,
            allowFreeText: false,
            options: [
              {
                id: "amendment-0",
                label: "Approve with network policy",
                providerValue: "approve-with-network-amendment:1",
                description: "allow registry.example",
                amendment: { kind: "network-policy", detail: "allow registry.example" },
              },
            ],
          },
        ],
        confirmLabel: "Approve",
      },
    };
    const onResolve = mock(async (resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: resolution.interactionId,
      sessionId: resolution.sessionId,
      revision: 2,
    }));
    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={request} onResolve={onResolve} />,
    );

    expect(screen.getByText("allow registry.example")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve with network policy" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]![0]).toMatchObject({
      action: "answer",
      answer: {
        answers: [{ questionId: "codex-approval-amendment", optionIds: ["amendment-0"] }],
      },
    });
  });

  test("fails closed when an approval has no actionable details", () => {
    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={{
          ...interaction(false),
          provider: "codex",
          kind: "command-approval",
          presentation: {
            title: "Approve command",
            questions: [],
            confirmLabel: "Approve",
            confirmDisabled: true,
          },
        }}
        onResolve={async () => ({
          result: "applied",
          interactionId: "interaction-1",
          sessionId: "session-1",
          revision: 2,
        })}
      />,
    );
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("names the MCP server that asked, and shows nothing extra without a source", () => {
    const permission = (source?: AgentInteractionRequest["source"]): AgentInteractionRequest => ({
      ...interaction(false),
      provider: "claude",
      kind: "permission",
      presentation: {
        title: "Allow mcp__linear__create_issue",
        body: "Tool: mcp__linear__create_issue",
        questions: [],
        confirmLabel: "Approve",
      },
      ...(source ? { source } : {}),
    });
    const onResolve = async () => ({
      result: "applied" as const,
      interactionId: "interaction-1",
      sessionId: "session-1",
      revision: 2,
    });
    const view = renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={permission({
          kind: "mcp-server",
          name: "<b>linear</b>",
          scope: "project",
        })}
        onResolve={onResolve}
      />,
    );
    const line = screen.getByTestId("interaction-source");
    // The configured name is untrusted text: shown verbatim, never as markup.
    expect(line.textContent).toBe("Requested by MCP server <b>linear</b> · from project settings");
    expect(line.querySelector("b") === null).toBe(true);
    view.unmount();

    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={permission({ kind: "mcp-server", name: "linear", scope: "brand-new" })}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByTestId("interaction-source").textContent).toBe(
      "Requested by MCP server linear · from other configuration",
    );
    cleanup();

    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={permission()} onResolve={onResolve} />,
    );
    expect(screen.queryByTestId("interaction-source") === null).toBe(true);
    expect(screen.getByText("Tool: mcp__linear__create_issue")).toBeTruthy();
  });

  test("a request a person must answer says so and offers nothing that remembers it", async () => {
    const command: AgentInteractionRequest = {
      ...interaction(false),
      provider: "codex",
      kind: "command-approval",
      presentation: {
        title: "Approve command",
        body: "Command: git push --force",
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
        // Withheld by the backend for such a request; the card refuses them
        // too, so neither can reappear through a stale or foreign snapshot.
        approveForSessionLabel: "Approve for session",
        ruleOffer: { kind: "command-prefix", patterns: ["git push --force"], suggested: 0 },
      },
    };
    const onResolve = mock(async (resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: resolution.interactionId,
      sessionId: resolution.sessionId,
      revision: 2,
    }));
    const onApproveAndRemember = mock(async () => ({
      result: "applied" as const,
      interactionId: "interaction-1",
      sessionId: "session-1",
      revision: 2,
    }));
    const view = renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={command}
        onResolve={onResolve}
        onApproveAndRemember={onApproveAndRemember}
      />,
    );
    // Without the marker both affordances are there.
    expect(screen.queryByTestId("interaction-human-required") === null).toBe(true);
    expect(screen.getByRole("button", { name: "Approve for session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve and remember…" })).toBeTruthy();
    view.unmount();

    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={{ ...command, humanRequired: true }}
        onResolve={onResolve}
        onApproveAndRemember={onApproveAndRemember}
      />,
    );
    expect(screen.getByTestId("interaction-human-required").textContent).toBe(
      "You need to answer this yourself: a saved rule can't approve it.",
    );
    expect(screen.queryByRole("button", { name: "Approve for session" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Approve and remember…" }) === null).toBe(true);
    // One-time answers stay.
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel turn" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({ action: "answer" });
    expect(onApproveAndRemember).not.toHaveBeenCalled();
  });

  test("tags a tool its MCP server calls destructive or read-only, and nothing else", () => {
    const permission = (extra: Partial<AgentInteractionRequest>): AgentInteractionRequest => ({
      ...interaction(false),
      provider: "claude",
      kind: "permission",
      presentation: {
        title: "Allow mcp__linear__delete_issue",
        body: "Tool: mcp__linear__delete_issue",
        questions: [],
        confirmLabel: "Approve",
      },
      ...extra,
    });
    const onResolve = async () => ({
      result: "applied" as const,
      interactionId: "interaction-1",
      sessionId: "session-1",
      revision: 2,
    });
    const tag = (extra: Partial<AgentInteractionRequest>) => {
      const view = renderInAppCommandScope(
        <NativeAgentInteractionCard interaction={permission(extra)} onResolve={onResolve} />,
      );
      const element = screen.queryByTestId("interaction-tool-hint");
      const result = element
        ? { text: element.textContent, title: element.getAttribute("title") }
        : null;
      view.unmount();
      return result;
    };
    const destructive = tag({
      source: { kind: "mcp-server", name: "linear" },
      toolHints: { readOnly: false, destructive: true },
    });
    expect(destructive?.text).toBe("Destructive");
    // Self-declared, and the card says so.
    expect(destructive?.title).toContain("not verified");
    // Shown on its own when the provider names no server.
    expect(tag({ toolHints: { readOnly: true } })?.text).toBe("Read-only");
    expect(tag({ toolHints: { readOnly: true, destructive: true } })).toBeNull();
    expect(tag({ toolHints: { idempotent: true, openWorld: true } })).toBeNull();
    expect(tag({})).toBeNull();
  });

  test("keeps Claude plan feedback and submits it with a revision request", async () => {
    const request: AgentInteractionRequest = {
      ...interaction(false),
      provider: "claude",
      kind: "plan-approval",
      presentation: {
        title: "Approve Claude's plan",
        planAvailable: true,
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
      },
    };
    const onResolve = mock(async (resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: resolution.interactionId,
      sessionId: resolution.sessionId,
      revision: 2,
    }));
    const view = renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={request}
        planContent="# Implementation\n\nDo the work."
        onResolve={onResolve}
      />,
    );
    expect(screen.getByText("Implementation plan")).toBeTruthy();
    const feedback = screen.getByLabelText("Plan revision feedback") as HTMLTextAreaElement;
    fireEvent.change(feedback, { target: { value: "Add rollback steps" } });
    view.unmount();
    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={request} onResolve={onResolve} />,
    );
    expect((screen.getByLabelText("Plan revision feedback") as HTMLTextAreaElement).value).toBe(
      "Add rollback steps",
    );
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      action: "decline",
      feedback: "Add rollback steps",
    });
  });

  test("⌘↵ in an answer field sends the answer", async () => {
    const onResolve = mock(async (resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: resolution.interactionId,
      sessionId: resolution.sessionId,
      revision: 2,
    }));
    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={interaction(false)} onResolve={onResolve} />,
    );
    const field = screen.getByLabelText("Access token response");
    // Nothing typed yet: the answer is required, so the chord does nothing.
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    fireEvent.change(field, { target: { value: "abc" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onResolve).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      action: "answer",
      answer: { answers: [{ questionId: "token", freeText: "abc" }] },
    });
  });

  test("⌘↵ in plan feedback requests changes, and never approves from a button", async () => {
    const request: AgentInteractionRequest = {
      ...interaction(false),
      provider: "claude",
      kind: "plan-approval",
      presentation: {
        title: "Approve Claude's plan",
        planAvailable: true,
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
      },
    };
    const onResolve = mock(async (resolution: AgentInteractionResolution) => ({
      result: "applied" as const,
      interactionId: resolution.interactionId,
      sessionId: resolution.sessionId,
      revision: 2,
    }));
    renderInAppCommandScope(
      <NativeAgentInteractionCard interaction={request} onResolve={onResolve} />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Approve" }), {
      key: "Enter",
      metaKey: true,
    });
    const feedback = screen.getByLabelText("Plan revision feedback");
    fireEvent.keyDown(feedback, { key: "Enter", metaKey: true });
    expect(onResolve).not.toHaveBeenCalled();

    fireEvent.change(feedback, { target: { value: "Add rollback steps" } });
    fireEvent.keyDown(feedback, { key: "Enter", metaKey: true });

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      action: "decline",
      feedback: "Add rollback steps",
    });
  });

  test("shows unavailable plan copy as description without a plan disclosure", () => {
    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={{
          ...interaction(false),
          provider: "claude",
          kind: "plan-approval",
          presentation: {
            title: "Claude's plan is unavailable for approval",
            body: "Claude asked to leave plan mode without providing a readable plan. Approval is disabled.",
            planAvailable: false,
            questions: [],
            confirmLabel: "Approve",
            declineLabel: "Deny",
            confirmDisabled: true,
          },
        }}
        onResolve={async () => ({
          result: "rejected",
          interactionId: "interaction-1",
          sessionId: "session-1",
          revision: 2,
        })}
      />,
    );

    expect(
      screen.getByText(
        "Claude asked to leave plan mode without providing a readable plan. Approval is disabled.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Implementation plan") === null).toBe(true);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("NativeAgentInteractionCard countdown pause", () => {
  function approval(hold: AgentInteractionRequest["hold"]): AgentInteractionRequest {
    return {
      ...interaction(false),
      provider: "codex",
      kind: "command-approval",
      expiresAt: Date.now() + 2 * 60_000,
      hold,
      presentation: {
        title: "Run a command",
        body: "git push",
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
      },
    };
  }

  test("an approval's countdown pauses through the same control", async () => {
    const onHold = mock(async (_held: boolean) => ({
      result: "applied" as const,
      interactionId: "interaction-1",
      sessionId: "session-1",
      revision: 2,
    }));
    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={approval({ available: true })}
        onResolve={async () => ({
          result: "applied",
          interactionId: "interaction-1",
          sessionId: "session-1",
          revision: 2,
        })}
        onHold={onHold}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Pause countdown, \d:\d\d left$/ }));
    await waitFor(() => expect(onHold).toHaveBeenCalledWith(true));
    // Pausing never answers: the approval's own buttons are still there.
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  test("an approval whose provider limit is the countdown cannot be paused", () => {
    renderInAppCommandScope(
      <NativeAgentInteractionCard
        interaction={approval({ available: false, reason: "no-extension" })}
        onResolve={async () => ({
          result: "applied",
          interactionId: "interaction-1",
          sessionId: "session-1",
          revision: 2,
        })}
        onHold={async () => ({
          result: "applied",
          interactionId: "interaction-1",
          sessionId: "session-1",
          revision: 2,
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /countdown/ }) === null).toBe(true);
    expect(screen.getByText(/Codex stops waiting at this deadline itself/)).toBeTruthy();
  });
});
