/**
 * A long run of tool calls folds to one line: the newest call, the stack icon,
 * how many calls there were and how long they took. The line opens the full
 * list and, from its place at the top of that list, folds it again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalProvider } from "@/contexts";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { NativeMessage } from "./NativeMessage";

afterEach(cleanup);

let messageCounter = 0;
// Call ids are unique within a conversation, and an opened group is
// remembered by them, so no two tests may share one.
let callCounter = 0;

function messageView(id: string, parts: NativeMessagePart[], scope = "fold-test") {
  return (
    <TerminalProvider>
      <NativeMessage
        agentExpansionScope={scope}
        message={{
          id,
          role: "assistant",
          content: "",
          createdAt: "2026-10-20T10:00:00.000Z",
          parts,
        }}
      />
    </TerminalProvider>
  );
}

function renderParts(parts: NativeMessagePart[]) {
  messageCounter += 1;
  // Unique per test so persisted expansion state cannot leak between them.
  return render(messageView(`tool-group-fold-${messageCounter}`, parts));
}

function shell(
  index: number,
  command: string,
  overrides: Partial<NativeMessagePart> = {},
): NativeMessagePart {
  return {
    type: "tool-invocation",
    content: command,
    toolName: "Bash",
    toolArgs: { command },
    toolState: "success",
    toolUseId: `call-${++callCounter}`,
    createdAt: `2026-10-20T10:00:0${index}.000Z`,
    toolDurationMs: 250,
    ...overrides,
  } as NativeMessagePart;
}

describe("folded tool group", () => {
  test("folds three or more calls to the newest call, the count and the span", () => {
    const { container } = renderParts([
      shell(0, "git status"),
      shell(1, "git diff --stat"),
      shell(2, "bun test src/app.test.ts", { toolDurationMs: 1_000 }),
    ]);

    const trigger = screen.getByRole("button", { name: /^Show 3 tool calls:/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByRole("button", { name: /Show 3 tool calls:.*bun test src\/app\.test\.ts/ }) ===
        trigger,
    ).toBe(true);
    expect(trigger.textContent).toContain("bun test src/app.test.ts");
    expect(trigger.textContent).toContain("3 tool calls");
    // 10:00:00 → 10:00:02 + 1s.
    expect(trigger.textContent).toContain("3s");
    expect(container.querySelector("svg.lucide-layers")).toBeTruthy();
    // The older calls are folded away rather than drawn as rows.
    expect(screen.queryByText("git status") === null).toBe(true);
    expect(screen.queryByText("git diff --stat") === null).toBe(true);
  });

  test("opens to every row and folds again from the top", () => {
    renderParts([
      shell(0, "git status"),
      shell(1, "git diff --stat"),
      shell(2, "git log -5"),
      shell(3, "git add -A"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Show 4 tool calls:/ }));
    for (const command of ["git status", "git diff --stat", "git log -5", "git add -A"]) {
      expect(screen.getByText(command)).toBeTruthy();
    }

    const header = screen.getByRole("button", { name: /^Fold 4 tool calls:/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(screen.queryByText("git status") === null).toBe(true);
    expect(screen.getByRole("button", { name: /^Show 4 tool calls:/ })).toBeTruthy();
  });

  test("stays open as calls stream in after it and as history pages in before it", () => {
    messageCounter += 1;
    const id = `tool-group-fold-${messageCounter}`;
    const calls = Array.from({ length: 6 }, (_, index) => shell(index, `echo ${index}`));
    const { rerender } = render(messageView(id, calls.slice(2, 5)));
    fireEvent.click(screen.getByRole("button", { name: /^Show 3 tool calls:/ }));

    rerender(messageView(id, calls.slice(2, 6)));
    expect(screen.getByRole("button", { name: /^Fold 4 tool calls:/ })).toBeTruthy();

    // Earlier history coalesces in front, and the row takes the oldest id.
    rerender(messageView(`${id}-earlier`, calls.slice(0, 6)));
    expect(screen.getByRole("button", { name: /^Fold 6 tool calls:/ })).toBeTruthy();
    expect(screen.getByText("echo 0")).toBeTruthy();
  });

  test("stays closed after an opened group grows and is folded again", () => {
    const id = `close-after-growth-${++messageCounter}`;
    const calls = Array.from({ length: 7 }, (_, index) => shell(index, `echo ${index}`));
    const { rerender } = render(messageView(id, calls.slice(2, 5)));
    fireEvent.click(screen.getByRole("button", { name: /^Show 3 tool calls:/ }));
    rerender(messageView(id, calls.slice(2, 6)));
    fireEvent.click(screen.getByRole("button", { name: /^Fold 4 tool calls:/ }));
    rerender(messageView(id, calls.slice(2, 7)));
    expect(
      screen.getByRole("button", { name: /^Show 5 tool calls:/ }).getAttribute("aria-expanded"),
    ).toBe("false");
    // Earlier history must not restore an obsolete open alias either.
    rerender(messageView(`${id}-earlier`, calls));
    expect(
      screen.getByRole("button", { name: /^Show 7 tool calls:/ }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByText("echo 2") === null).toBe(true);
  });

  test("restores expansion after virtualized unmounts and isolates transcript scopes", () => {
    const id = `remount-${++messageCounter}`;
    const calls = [shell(0, "git status"), shell(1, "git diff --stat"), shell(2, "git log -5")];
    const first = render(messageView(id, calls, "transcript-a"));
    fireEvent.click(screen.getByRole("button", { name: /^Show 3 tool calls:/ }));
    first.unmount();
    const other = render(messageView(id, calls, "transcript-b"));
    expect(
      screen.getByRole("button", { name: /^Show 3 tool calls:/ }).getAttribute("aria-expanded"),
    ).toBe("false");
    other.unmount();
    const restored = render(messageView(id, calls, "transcript-a"));
    fireEvent.click(screen.getByRole("button", { name: /^Fold 3 tool calls:/ }));
    restored.unmount();
    render(messageView(id, calls, "transcript-a"));
    expect(
      screen.getByRole("button", { name: /^Show 3 tool calls:/ }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("stays open when paging and streaming replace both endpoints before a remount", () => {
    const id = `both-ends-${++messageCounter}`;
    const calls = Array.from({ length: 7 }, (_, index) => shell(index, `echo ${index}`));
    const first = render(messageView(id, calls.slice(2, 5)));
    fireEvent.click(screen.getByRole("button", { name: /^Show 3 tool calls:/ }));
    first.unmount();
    render(messageView(`${id}-earlier`, calls));
    expect(
      screen.getByRole("button", { name: /^Fold 7 tool calls:/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("echo 0")).toBeTruthy();
  });

  test("keeps expansion when calls acquire provider ids", () => {
    const id = `new-ids-${++messageCounter}`;
    const calls = [shell(0, "git status"), shell(1, "git diff --stat"), shell(2, "git log -5")];
    const { rerender } = render(
      messageView(
        id,
        calls.map((call) => ({ ...call, toolUseId: undefined })),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Show 3 tool calls:/ }));
    rerender(messageView(id, calls));
    expect(
      screen.getByRole("button", { name: /^Fold 3 tool calls:/ }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("keeps a pending question visible and folds it only after completion", async () => {
    const id = `question-${++messageCounter}`;
    const question = shell(2, "", {
      toolName: "AskUserQuestion",
      toolState: "pending",
      toolArgs: { questions: [{ question: "Which approach?", options: [{ label: "Simple" }] }] },
    });
    const calls = [shell(0, "git status"), shell(1, "git diff --stat"), question];
    const { rerender } = render(messageView(id, calls));
    expect(screen.queryByRole("button", { name: /^Show .*tool calls:/ }) === null).toBe(true);
    expect(screen.getByText("Which approach?")).toBeTruthy();
    rerender(messageView(id, [...calls.slice(0, 2), { ...question, toolState: "success" }]));
    // A group that was on screen unfolded mounts open and folds a frame later,
    // so the collapse animates rather than snapping shut.
    const trigger = () => screen.getByRole("button", { name: /^Show 3 tool calls:/ });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"));
  });

  test("renders a group that arrives already long folded without animating", () => {
    const calls = [shell(0, "git status"), shell(1, "git diff --stat"), shell(2, "git log -5")];
    render(messageView(`arrives-folded-${++messageCounter}`, calls));
    expect(
      screen.getByRole("button", { name: /^Show 3 tool calls:/ }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("lets a folded line stand in for its newest call's transcript position", () => {
    const calls = [shell(0, "git status"), shell(1, "git diff --stat"), shell(2, "git log -5")];
    const ids = calls.map((call) => call.toolUseId);
    const { container } = renderParts(calls);
    const anchors = () =>
      Array.from(container.querySelectorAll<HTMLElement>("[data-transcript-part-id]"));

    expect(anchors().map((element) => element.dataset.transcriptPartId)).toEqual([ids[2]]);
    expect(anchors()[0]!.textContent).toContain("git log -5");

    fireEvent.click(screen.getByRole("button", { name: /^Show 3 tool calls:/ }));
    expect(anchors().map((element) => element.dataset.transcriptPartId)).toEqual(ids);
  });

  test("surfaces running and failed calls on the folded line", () => {
    renderParts([
      shell(0, "git status", { toolState: "failure" }),
      shell(1, "git diff --stat"),
      shell(2, "bun test", { toolState: "pending", toolDurationMs: undefined }),
    ]);

    const trigger = screen.getByRole("button", { name: /^Show 3 tool calls:/ });
    expect(trigger.textContent).toContain("running...");
    expect(trigger.textContent).toContain("1 failed");
  });

  test("leaves a short group as plain rows", () => {
    renderParts([shell(0, "git status"), shell(1, "git diff --stat")]);

    expect(screen.queryByRole("button", { name: /tool calls/ }) === null).toBe(true);
    expect(screen.getByText("git status")).toBeTruthy();
    expect(screen.getByText("git diff --stat")).toBeTruthy();
  });
});
