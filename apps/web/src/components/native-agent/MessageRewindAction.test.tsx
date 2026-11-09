import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import type { NativeAgentSessionAction } from "@orkestrator/protocol/native-agent";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { useJoinedMessageActions, useMessageRewind } from "./MessageRewindAction";

afterEach(cleanup);

function message(id: string, role: NativeMessage["role"], content = id): NativeMessage {
  return {
    id,
    role,
    content,
    turnId: `turn-${id}`,
    parts: [{ type: "text", content }],
    createdAt: "2026-11-09T12:00:00.000Z",
  };
}

const MESSAGES = [
  message("p1", "user", "first"),
  message("r1", "assistant"),
  message("p2", "user", "second"),
  message("r2", "assistant"),
];

function Harness({
  performAction,
  hasDraft = false,
  restored,
  disabled = false,
  collect,
}: {
  performAction: (action: NativeAgentSessionAction) => Promise<{ outcome: "applied" }>;
  hasDraft?: boolean;
  restored: Array<{ text: string }>;
  disabled?: boolean;
  collect?: (elements: ReactNode[]) => void;
}) {
  const [tick, setTick] = useState(0);
  const rewind = useMessageRewind({
    platform: "codex",
    agentLabel: "Codex",
    enabled: true,
    messages: MESSAGES,
    responseInProgress: false,
    disabled,
    performAction,
    composerHasDraft: () => hasDraft,
    restoreDraft: (draft) => restored.push(draft),
  });
  collect?.(MESSAGES.map((row) => rewind.renderRewindAction(row.id)));
  return (
    <div>
      <button type="button" onClick={() => setTick((value) => value + 1)}>
        Re-render {tick}
      </button>
      {MESSAGES.map((row) => (
        <span key={row.id}>{rewind.renderRewindAction(row.id)}</span>
      ))}
      {rewind.dialog}
    </div>
  );
}

describe("useMessageRewind", () => {
  test("offers rewind on prompts only, with an element stable across renders", () => {
    const renders: ReactNode[][] = [];
    renderInAppCommandScope(
      <Harness
        performAction={async () => ({ outcome: "applied" })}
        restored={[]}
        collect={(elements) => renders.push(elements)}
      />,
    );
    expect(
      screen.getAllByRole("button", { name: "Rewind Codex session to before this prompt" }),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Re-render/ }));
    const [first, ...rest] = renders;
    expect(first![1]).toBeNull();
    expect(first![3]).toBeNull();
    for (const pass of rest) {
      expect(pass[0]).toBe(first![0]);
      expect(pass[2]).toBe(first![2]);
    }
  });

  test("confirms with the dropped turn count, rewinds, and restores the prompt", async () => {
    const performAction = mock(async (_action: NativeAgentSessionAction) => ({
      outcome: "applied" as const,
    }));
    const restored: Array<{ text: string }> = [];
    renderInAppCommandScope(<Harness performAction={performAction} restored={restored} />);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Rewind Codex session to before this prompt" })[0]!,
    );
    const dialog = await screen.findByTestId("message-rewind-dialog");
    expect(dialog.textContent).toContain("Rewind Codex to before this prompt?");
    expect(dialog.textContent).toContain("2 turns");
    expect(performAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
    await waitFor(() => expect(screen.queryByTestId("message-rewind-dialog")).toBeNull());
    expect(performAction).toHaveBeenCalledWith({ kind: "rewind-messages", messageId: "p1" });
    expect(restored).toEqual([{ text: "first", annotations: [] }] as never);
  });

  test("cancel sends nothing", async () => {
    const performAction = mock(async () => ({ outcome: "applied" as const }));
    renderInAppCommandScope(<Harness performAction={performAction} restored={[]} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Rewind Codex session to before this prompt" })[1]!,
    );
    await screen.findByTestId("message-rewind-dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("message-rewind-dialog")).toBeNull());
    expect(performAction).not.toHaveBeenCalled();
  });

  test("a draft already in the composer is never overwritten", async () => {
    const restored: Array<{ text: string }> = [];
    renderInAppCommandScope(
      <Harness performAction={async () => ({ outcome: "applied" })} hasDraft restored={restored} />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Rewind Codex session to before this prompt" })[1]!,
    );
    await screen.findByTestId("message-rewind-dialog");
    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
    await waitFor(() => expect(screen.queryByTestId("message-rewind-dialog")).toBeNull());
    expect(restored).toEqual([]);
  });

  test("a refused rewind keeps the dialog open and restores nothing", async () => {
    const restored: Array<{ text: string }> = [];
    renderInAppCommandScope(
      <Harness
        performAction={async () => {
          throw new Error("codex message rewind failed");
        }}
        restored={restored}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Rewind Codex session to before this prompt" })[1]!,
    );
    await screen.findByTestId("message-rewind-dialog");
    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rewind" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByTestId("message-rewind-dialog")).toBeTruthy();
    expect(restored).toEqual([]);
  });

  test("a running turn disables the action", () => {
    renderInAppCommandScope(
      <Harness performAction={async () => ({ outcome: "applied" })} restored={[]} disabled />,
    );
    for (const button of screen.getAllByRole("button", {
      name: "Rewind Codex session to before this prompt",
    })) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });
});

describe("useJoinedMessageActions", () => {
  function Join({
    parts,
    collect,
  }: {
    parts: [ReactNode, ReactNode];
    collect: (node: ReactNode) => void;
  }) {
    const join = useJoinedMessageActions();
    const [, setTick] = useState(0);
    collect(join("row", parts[0], parts[1]));
    return (
      <button type="button" onClick={() => setTick((value) => value + 1)}>
        again
      </button>
    );
  }

  test("returns the lone part, and one stable joined element for two", () => {
    const fork = <span>fork</span>;
    const rewind = <span>rewind</span>;
    const joined: ReactNode[] = [];
    renderInAppCommandScope(<Join parts={[fork, rewind]} collect={(node) => joined.push(node)} />);
    fireEvent.click(screen.getByRole("button", { name: "again" }));
    expect(joined[0]).toBe(joined[1]);
    const alone: ReactNode[] = [];
    cleanup();
    renderInAppCommandScope(<Join parts={[fork, null]} collect={(node) => alone.push(node)} />);
    expect(alone[0]).toBe(fork);
  });
});
