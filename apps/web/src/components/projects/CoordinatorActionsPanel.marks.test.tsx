/**
 * The Actions panel's "Mark done" context menu: offered on open cards, undone
 * only for the user's own marks, reachable from the keyboard, and backed by the
 * conversation's stored marks.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { useState } from "react";
import { ActionsPanel } from "./CoordinatorActionsPanel";
import {
  applyCoordinatorActionMarks,
  type CoordinatorActionCard,
} from "./coordinator-action-cards";
import { useCoordinatorActionMarks } from "@/stores/coordinatorActionMarksStore";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";

afterEach(() => {
  cleanup();
  cleanupNodeScopes();
});

const cards: CoordinatorActionCard[] = [
  { id: "t", anchorId: "u", index: 0, kind: "topic", title: "New subject", done: false },
  { id: "q", anchorId: "a", index: 1, kind: "question", title: "Which option?", done: false },
  { id: "p", anchorId: "n", index: 2, kind: "pr", title: "#42 Improve search", done: true },
];

/** The panel with marks held in local state, as the chat shell lays them over the cards. */
function Marked({
  initial = [],
  onMark,
}: {
  initial?: string[];
  onMark?: (card: CoordinatorActionCard, done: boolean) => void;
}) {
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set(initial));
  return (
    <ActionsPanel
      docked
      cards={applyCoordinatorActionMarks(cards, marked)}
      onNavigate={() => {}}
      onMarkDone={(card, done) => {
        onMark?.(card, done);
        setMarked((current) => {
          const next = new Set(current);
          if (done) next.add(card.id);
          else next.delete(card.id);
          return next;
        });
      }}
    />
  );
}

const waiting = () => screen.getByRole("button", { name: "Collapse actions" }).textContent;
/** An open menu hides the rest of the page from the accessibility tree until it closes. */
const menuClosed = () => waitFor(() => expect(screen.queryByRole("menu") === null).toBe(true));

describe("applyCoordinatorActionMarks", () => {
  test("marks only open cards and leaves the list alone when nothing applies", () => {
    expect(applyCoordinatorActionMarks(cards, new Set())).toBe(cards);
    // A mark on a card the transcript finished changes nothing.
    expect(applyCoordinatorActionMarks(cards, new Set(["p", "gone"]))).toBe(cards);
    const marked = applyCoordinatorActionMarks(cards, new Set(["q"]));
    expect(marked[1]).toEqual({ ...cards[1]!, done: true, markedDone: true });
    expect(marked[0]).toBe(cards[0]);
    expect(marked[2]).toBe(cards[2]);
  });
});

describe("Mark done", () => {
  test("right-clicking an open card marks it done and out of the waiting count", async () => {
    const onMark = mock((_card: CoordinatorActionCard, _done: boolean) => {});
    render(<Marked onMark={onMark} />);
    expect(waiting()).toContain("1 waiting");

    fireEvent.contextMenu(screen.getByRole("button", { name: "Which option?" }));
    expect(screen.queryByRole("menuitem", { name: "Mark not done" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark done" }));
    await menuClosed();

    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onMark.mock.calls[0]![0].id).toBe("q");
    expect(onMark.mock.calls[0]![1]).toBe(true);
    const card = await screen.findByRole("button", { name: "Done: Which option?" });
    expect(card.className).toContain("opacity-60");
    expect(card.textContent).toContain("Marked done");
    expect(waiting()).toContain("0 waiting");
  });

  test("topics can be marked too", async () => {
    render(<Marked />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "New subject" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark done" }));
    await menuClosed();
    expect(await screen.findByRole("button", { name: "Done: New subject" })).toBeTruthy();
  });

  test("a card marked by hand offers Mark not done, which reopens it", async () => {
    const onMark = mock((_card: CoordinatorActionCard, _done: boolean) => {});
    render(<Marked initial={["q"]} onMark={onMark} />);
    expect(waiting()).toContain("0 waiting");

    fireEvent.contextMenu(screen.getByRole("button", { name: "Done: Which option?" }));
    expect(screen.queryByRole("menuitem", { name: "Mark done" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark not done" }));
    await menuClosed();

    expect(onMark.mock.calls[0]![1]).toBe(false);
    expect(await screen.findByRole("button", { name: "Which option?" })).toBeTruthy();
    expect(waiting()).toContain("1 waiting");
  });

  test("a card the conversation finished offers no way to reopen it", async () => {
    const onMark = mock((_card: CoordinatorActionCard, _done: boolean) => {});
    // A stale mark on a finished card makes no difference.
    render(<Marked initial={["p"]} onMark={onMark} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Done: #42 Improve search" }));
    expect(screen.queryByRole("menuitem", { name: "Mark not done" }) === null).toBe(true);
    expect(screen.queryByRole("menuitem", { name: "Mark done" }) === null).toBe(true);
    const note = screen.getByRole("menuitem", { name: "Done in the conversation" });
    expect(note.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(note);
    fireEvent.keyDown(note, { key: "Escape" });
    await menuClosed();
    expect(onMark).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Done: #42 Improve search" })).toBeTruthy();
  });

  test.each([
    ["the context-menu key", { key: "ContextMenu" }],
    ["Shift+F10", { key: "F10", shiftKey: true }],
  ])("%s opens a focused card's menu and Escape returns focus to it", async (_label, keys) => {
    render(<Marked />);
    const card = screen.getByRole("button", { name: "Which option?" });
    expect(card.getAttribute("aria-keyshortcuts")).toBe("Shift+F10");
    act(() => card.focus());

    fireEvent.keyDown(card, keys);
    const item = screen.getByRole("menuitem", { name: "Mark done" });
    expect(screen.getByRole("menu", { name: "Actions for Which option?" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(item));

    fireEvent.keyDown(item, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu") === null).toBe(true));
    expect(document.activeElement).toBe(card);
  });

  test("Enter on the menu item marks the card from the keyboard", async () => {
    render(<Marked />);
    const card = screen.getByRole("button", { name: "Which option?" });
    act(() => card.focus());
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    const item = screen.getByRole("menuitem", { name: "Mark done" });
    await waitFor(() => expect(document.activeElement).toBe(item));
    fireEvent.keyDown(item, { key: "Enter" });
    await menuClosed();
    expect(await screen.findByRole("button", { name: "Done: Which option?" })).toBeTruthy();
  });

  test("without a mark handler cards have no menu", () => {
    render(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
    const card = screen.getByRole("button", { name: "Which option?" });
    expect(card.getAttribute("aria-keyshortcuts")).toBeNull();
    fireEvent.contextMenu(card);
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu") === null).toBe(true);
  });

  test("the narrow overlay stays open while its card menu is used", () => {
    render(
      <ActionsPanel docked={false} cards={cards} onNavigate={() => {}} onMarkDone={() => {}} />,
    );
    const icon = screen.getByRole("button", { name: "Actions, 1 waiting" });
    fireEvent.pointerEnter(icon, { pointerType: "mouse" });
    expect(icon.getAttribute("aria-expanded")).toBe("true");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Which option?" }));
    const item = screen.getByRole("menuitem", { name: "Mark done" });
    // The menu is outside the overlay; pressing on it is not an outside click.
    fireEvent.pointerDown(item);
    expect(icon.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Mark done in the narrow overlay", () => {
  test("Escape closes only the card's menu and gives focus back to the visible card", async () => {
    render(
      <ActionsPanel docked={false} cards={cards} onNavigate={() => {}} onMarkDone={() => {}} />,
    );
    const icon = screen.getByRole("button", { name: "Actions, 1 waiting" });
    fireEvent.focus(icon);
    expect(icon.getAttribute("aria-expanded")).toBe("true");
    const card = screen.getByRole("button", { name: "Which option?" });
    act(() => card.focus());

    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    const item = screen.getByRole("menuitem", { name: "Mark done" });
    await waitFor(() => expect(document.activeElement).toBe(item));
    fireEvent.keyDown(item, { key: "Escape" });
    await menuClosed();

    expect(icon.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "Actions" }).getAttribute("aria-hidden")).toBe(
      "false",
    );
    expect(document.activeElement).toBe(card);

    // A second Escape, with no menu open, folds the overlay as before.
    fireEvent.keyDown(card, { key: "Escape" });
    await waitFor(() => expect(icon.getAttribute("aria-expanded")).toBe("false"));
  });
});

/** The panel as a coordinator conversation renders it, over the node's stored marks. */
function StoredPanel({ conversationId }: { conversationId: string }) {
  const marks = useCoordinatorActionMarks("p", conversationId);
  return (
    <ActionsPanel
      docked
      cards={applyCoordinatorActionMarks(cards, marks.marked)}
      onNavigate={() => {}}
      onMarkDone={marks.available ? (card, done) => void marks.setMark(card.id, done) : undefined}
    />
  );
}

function storedBackend() {
  const rows = new Map<string, string[]>();
  const revisions = new Map<string, number>();
  const answer = (args: Readonly<Record<string, unknown>>) => {
    const conversationId = String(args.conversationId);
    return {
      projectId: "p",
      conversationId,
      revision: revisions.get(conversationId) ?? 0,
      cardIds: rows.get(conversationId) ?? [],
    };
  };
  return {
    rows,
    invoke: {
      get_coordinator_action_marks: answer,
      set_coordinator_action_mark: (args: Readonly<Record<string, unknown>>) => {
        const conversationId = String(args.conversationId);
        const current = rows.get(conversationId) ?? [];
        const cardId = String(args.cardId);
        rows.set(
          conversationId,
          args.done
            ? [...current.filter((id) => id !== cardId), cardId]
            : current.filter((id) => id !== cardId),
        );
        revisions.set(conversationId, (revisions.get(conversationId) ?? 0) + 1);
        return answer(args);
      },
    },
  };
}

describe("stored marks", () => {
  test("a mark is saved for its conversation and shown again after a reload", async () => {
    const backend = storedBackend();
    const first = renderInNodeScope(<StoredPanel conversationId="c1" />, {
      client: new FakeNodeClient({ invoke: backend.invoke }),
    });
    // The menu waits for the stored marks, which re-renders the card.
    await waitFor(() => {
      fireEvent.contextMenu(screen.getByRole("button", { name: "Which option?" }));
      expect(screen.getByRole("menuitem", { name: "Mark done" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark done" }));
    await waitFor(() => expect(backend.rows.get("c1")).toEqual(["q"]));
    first.unmount();
    cleanupNodeScopes();

    // A new window (a reload, or another client) reads the same marks.
    renderInNodeScope(<StoredPanel conversationId="c1" />, {
      client: new FakeNodeClient({ invoke: backend.invoke }),
    });
    expect(await screen.findByRole("button", { name: "Done: Which option?" })).toBeTruthy();
    cleanup();
    cleanupNodeScopes();

    // Another conversation of the same project is untouched.
    renderInNodeScope(<StoredPanel conversationId="c2" />, {
      client: new FakeNodeClient({ invoke: backend.invoke }),
    });
    await waitFor(() => {
      fireEvent.contextMenu(screen.getByRole("button", { name: "Which option?" }));
      expect(screen.getByRole("menuitem", { name: "Mark done" })).toBeTruthy();
    });
  });
});
