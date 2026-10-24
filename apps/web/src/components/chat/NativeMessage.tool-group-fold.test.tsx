/**
 * A long run of tool calls folds to one line: the newest call, the stack icon,
 * how many calls there were and how long they took. The line opens the full
 * list and, from its place at the top of that list, folds it again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalProvider } from "@/contexts";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { VirtuosoMockContext } from "react-virtuoso";
import { NativeMessage } from "./NativeMessage";

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
});

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

  test("keeps a pending question visible, then folds once it is answered", () => {
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
    const show = screen.getByRole("button", { name: /^Show 3 tool calls:/ });
    expect(show.getAttribute("aria-expanded")).toBe("false");
  });

  test("a visible group crossing the threshold folds in the same host and animates its line in", () => {
    const id = `threshold-${++messageCounter}`;
    const calls = [shell(0, "git status"), shell(1, "git diff"), shell(2, "git log")];
    const { container, rerender } = render(messageView(id, calls.slice(0, 2)));
    const frame = container.querySelector("[data-transcript-group-frame]");
    const content = container.querySelector(".tool-group-fold-content");
    expect(content?.getAttribute("data-state")).toBe("open");
    rerender(messageView(id, calls));
    const show = screen.getByRole("button", { name: /^Show 3 tool calls:/ });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    // Same host and body: the fold closes them rather than remounting, so the
    // close animation plays from the rows' measured height.
    expect(container.querySelector("[data-transcript-group-frame]")).toBe(frame);
    expect(container.querySelector(".tool-group-fold-content")).toBe(content);
    expect(content?.getAttribute("data-state")).toBe("closed");
    expect(container.querySelector(".tool-group-head-enter")).toBeTruthy();
    // Opened by the reader, it stays open as calls keep arriving.
    fireEvent.click(show);
    rerender(messageView(id, [...calls, shell(3, "git branch")]));
    expect(
      screen.getByRole("button", { name: /^Fold 4 tool calls:/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("git status")).toBeTruthy();
  });

  test("short and restored open groups mount without the reader opening animation", () => {
    const id = `mount-animation-${++messageCounter}`;
    const calls = [shell(0, "git status"), shell(1, "git diff"), shell(2, "git log")];
    const first = render(messageView(id, calls.slice(0, 2)));
    expect(first.container.querySelector(".tool-group-reader-open") === null).toBe(true);
    first.rerender(messageView(id, calls));
    fireEvent.click(screen.getByRole("button", { name: /^Show 3 tool calls:/ }));
    expect(first.container.querySelector(".tool-group-reader-open")).toBeTruthy();
    first.unmount();
    const restored = render(messageView(id, calls));
    expect(screen.getByRole("button", { name: /^Fold 3 tool calls:/ })).toBeTruthy();
    expect(restored.container.querySelector(".tool-group-reader-open") === null).toBe(true);
  });

  test("a summary enters only on its first short-to-long crossing", () => {
    const id = `recross-${++messageCounter}`;
    const calls = [shell(0, "git status"), shell(1, "git diff"), shell(2, "git log")];
    const { container, rerender } = render(messageView(id, calls.slice(0, 2)));
    rerender(messageView(id, calls));
    expect(container.querySelector(".tool-group-head-enter")).toBeTruthy();
    rerender(messageView(id, calls.slice(0, 2)));
    rerender(messageView(id, calls));
    expect(container.querySelector(".tool-group-head-enter") === null).toBe(true);
  });

  test("an initially long summary never animates on a later re-crossing", () => {
    const id = `long-recross-${++messageCounter}`;
    const calls = [shell(0, "git status"), shell(1, "git diff"), shell(2, "git log")];
    const { container, rerender } = render(messageView(id, calls));
    rerender(messageView(id, calls.slice(0, 2)));
    rerender(messageView(id, calls));
    expect(container.querySelector(".tool-group-head-enter") === null).toBe(true);
  });

  for (const interaction of ["focus", "selection"] as const) {
    test(`defers threshold folding while row ${interaction} is held`, () => {
      const id = `interaction-${++messageCounter}`;
      const calls = [shell(0, "git status"), shell(1, "git diff"), shell(2, "git log")];
      const { container, rerender } = render(messageView(id, calls.slice(0, 2)));
      const row = screen.getByText("git status");
      const control = row.closest("button")!;
      if (interaction === "focus") {
        act(() => control.focus());
      } else {
        const range = document.createRange();
        range.selectNodeContents(row);
        document.getSelection()!.addRange(range);
        fireEvent(document, new Event("selectionchange"));
      }
      rerender(messageView(id, calls));
      expect(container.querySelector(".tool-group-fold-content")?.getAttribute("data-state")).toBe(
        "open",
      );
      expect(screen.getByText("git status")).toBe(row);
      if (interaction === "focus") {
        act(() => control.blur());
      } else {
        document.getSelection()!.removeAllRanges();
        fireEvent(document, new Event("selectionchange"));
      }
      expect(container.querySelector(".tool-group-fold-content")?.getAttribute("data-state")).toBe(
        "closed",
      );
    });
  }

  test("an explicit fold overrides a held selection and a later short run protects focus again", () => {
    const id = `explicit-fold-${++messageCounter}`;
    const calls = [shell(0, "git status"), shell(1, "git diff"), shell(2, "git log")];
    const { container, rerender } = render(messageView(id, calls.slice(0, 2)));
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("git status"));
    document.getSelection()!.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    rerender(messageView(id, calls));
    fireEvent.click(screen.getByRole("button", { name: /^Fold 3 tool calls:/ }));
    expect(container.querySelector(".tool-group-fold-content")?.getAttribute("data-state")).toBe(
      "closed",
    );
    document.getSelection()!.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    rerender(messageView(id, calls.slice(0, 2)));
    act(() => screen.getByText("git status").closest("button")!.focus());
    rerender(messageView(id, calls));
    expect(container.querySelector(".tool-group-fold-content")?.getAttribute("data-state")).toBe(
      "open",
    );
  });

  test("renders a group that arrives already long folded without animating", () => {
    const calls = [shell(0, "git status"), shell(1, "git diff --stat"), shell(2, "git log -5")];
    const { container } = render(messageView(`arrives-folded-${++messageCounter}`, calls));
    expect(
      screen.getByRole("button", { name: /^Show 3 tool calls:/ }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(container.querySelector(".tool-group-head-enter") === null).toBe(true);
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

  test("an open long group renders a bounded window of entries inside its own viewport", () => {
    const calls = Array.from({ length: 300 }, (_, index) => shell(index % 10, `step ${index}`));
    messageCounter += 1;
    // happy-dom lays nothing out; give the inner virtualizer fixed geometry.
    const { container } = render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 400, itemHeight: 40 }}>
        {messageView(`tool-group-fold-${messageCounter}`, calls)}
      </VirtuosoMockContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Show 300 tool calls:/ }));
    const viewport = container.querySelector("[data-transcript-inner-viewport]");
    expect(viewport).toBeTruthy();
    // At most a window of entries is mounted; the rest is virtual space.
    const mounted = viewport!.querySelectorAll("[data-transcript-part-id]").length;
    expect(mounted).toBeLessThan(60);
    const list = viewport!.querySelector<HTMLElement>("[data-testid=virtuoso-item-list]")!;
    expect(
      Number.parseFloat(list.style.paddingBottom) + Number.parseFloat(list.style.paddingTop),
    ).toBeGreaterThan((300 - 60) * 40);
    // The inner scroller has a hard height, below the body ceiling.
    const scroller = viewport!.querySelector<HTMLElement>("[data-virtuoso-scroller]")!;
    expect(Number.parseFloat(scroller.style.height)).toBeLessThanOrEqual(28 * 16);
    // The frame keeps standing in for the calls the inner viewport scrolls.
    const head = container.querySelector(":scope [data-transcript-part-id]");
    expect(head?.closest("[data-transcript-inner-viewport]") === null).toBe(true);
  });

  test("a short group's body has a hard height ceiling", () => {
    const { container } = renderParts([shell(0, "git status"), shell(1, "git diff --stat")]);
    const body = container.querySelector(".tool-group-fold-content > div") as HTMLElement;
    expect(body.style.maxHeight).toBe("min(28rem, 55dvh)");
    expect(body.className).toContain("overflow-y-auto");
  });

  test("members prepended by history keep the existing rows mounted", () => {
    const id = `prepend-${++messageCounter}`;
    const later = [shell(3, "git status"), shell(4, "git log"), shell(5, "git show")];
    const { rerender } = render(messageView(id, later));
    fireEvent.click(screen.getByRole("button", { name: /^Show 3 tool calls:/ }));
    const row = screen.getByText("git log").closest(".px-2");
    rerender(messageView(id, [shell(2, "git fetch"), ...later]));
    expect(screen.getByText("git log").closest(".px-2")).toBe(row);
  });
});
