import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionResolution,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import { NativeAgentInteractionCard } from "./NativeAgentInteractionCard";
import { usePromptDraftStore } from "@/stores/promptDraftStore";

afterEach(() => {
  cleanup();
  usePromptDraftStore.getState().reset();
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
    render(<NativeAgentInteractionCard interaction={interaction(true)} onResolve={onResolve} />);

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
    render(
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
    render(<NativeAgentInteractionCard interaction={request} onResolve={onResolve} />);

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
    render(
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
    const freeText = (onResolve.mock.calls[0]?.[0] as AgentInteractionResolution).answer?.answers[0]
      ?.freeText;
    expect(JSON.parse(freeText ?? "{}")).toEqual({
      count: 3,
      mode: "safe",
      enabled: true,
      token: "secret",
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
    const view = render(
      <NativeAgentInteractionCard interaction={interaction(false)} onResolve={onResolve} />,
    );
    fireEvent.change(screen.getByLabelText("Access token response"), {
      target: { value: "remember me" },
    });
    view.unmount();
    render(<NativeAgentInteractionCard interaction={interaction(false)} onResolve={onResolve} />);
    expect((screen.getByLabelText("Access token response") as HTMLTextAreaElement).value).toBe(
      "remember me",
    );
    cleanup();
    render(<NativeAgentInteractionCard interaction={request} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve for session" }));
    await waitFor(() =>
      expect(onResolve.mock.calls.at(-1)?.[0]).toMatchObject({
        action: "approve-for-session",
      }),
    );
    expect(screen.getByRole("button", { name: "Cancel turn" })).toBeTruthy();
  });

  test("fails closed when an approval has no actionable details", () => {
    render(
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

  test("keeps Claude plan feedback and submits it with a revision request", async () => {
    const request: AgentInteractionRequest = {
      ...interaction(false),
      provider: "claude",
      kind: "plan-approval",
      presentation: {
        title: "Approve Claude's plan",
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
    const view = render(
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
    render(<NativeAgentInteractionCard interaction={request} onResolve={onResolve} />);
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
});
