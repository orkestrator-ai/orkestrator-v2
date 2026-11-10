import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ActionsPanel } from "./CoordinatorActionsPanel";
import {
  coordinatorActionCards,
  visibleCoordinatorCards,
  type CoordinatorActionCard,
} from "./coordinator-action-cards";
import { searchCoordinatorActions } from "./coordinator-action-search";
import {
  COORDINATOR_ACTIONS_DOCKED_KEY,
  setCoordinatorActionsDockedOpen,
} from "./coordinator-actions-preference";
import type { NativeMessage } from "@/lib/chat/native-message-types";

afterEach(() => {
  cleanup();
  localStorage.removeItem(COORDINATOR_ACTIONS_DOCKED_KEY);
});

const card = (
  index: number,
  kind: CoordinatorActionCard["kind"],
  title: string,
  extra: Partial<CoordinatorActionCard> = {},
): CoordinatorActionCard => ({
  id: `card-${index}`,
  anchorId: `row-${index}`,
  index,
  kind,
  title,
  done: false,
  ...extra,
});

// Fourteen actions: more than the panel's ten visible cards.
const all: CoordinatorActionCard[] = [
  card(0, "topic", "Release planning"),
  card(1, "pr", "#7 Fix the build", { state: "merged", done: true }),
  card(2, "question", "Which database?"),
  ...Array.from({ length: 10 }, (_, offset) => card(3 + offset, "topic", `Later topic ${offset}`)),
  card(13, "pr", "#9 Add search", { state: "open" }),
];
const visible = visibleCoordinatorCards(all, all.length - 1);

function optionNames() {
  return within(screen.getByRole("listbox", { name: "Actions" }))
    .queryAllByRole("option")
    .map((option) => option.getAttribute("aria-label"));
}
function selectedName() {
  return screen
    .getByRole("listbox", { name: "Actions" })
    .querySelector('[aria-selected="true"]')
    ?.getAttribute("aria-label");
}
async function openSearch() {
  fireEvent.click(screen.getByRole("button", { name: "Search actions" }));
  const input = await screen.findByRole("combobox", { name: "Search actions" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  return input;
}

test("search matches title, kind and state, newest first", () => {
  expect(searchCoordinatorActions(all, "").map((c) => c.index)).toEqual(
    all.map((c) => c.index).toReversed(),
  );
  expect(searchCoordinatorActions(all, "PR").map((c) => c.title)).toEqual([
    "#9 Add search",
    "#7 Fix the build",
  ]);
  expect(searchCoordinatorActions(all, "pull request merged").map((c) => c.title)).toEqual([
    "#7 Fix the build",
  ]);
  expect(searchCoordinatorActions(all, "question").map((c) => c.title)).toEqual([
    "Which database?",
  ]);
  expect(searchCoordinatorActions(all, "awaiting").map((c) => c.title)).toEqual([
    "Which database?",
  ]);
  expect(searchCoordinatorActions(all, "DATABASE").map((c) => c.title)).toEqual([
    "Which database?",
  ]);
  expect(searchCoordinatorActions(all, "nothing like this")).toEqual([]);
  // Terms start a word: "pr" is not found inside "improve", "#9" and "9" are found in "#9".
  const improve = [card(0, "topic", "Improve the docs"), card(1, "question", "Merge PRs now?")];
  expect(searchCoordinatorActions(improve, "pr").map((c) => c.title)).toEqual(["Merge PRs now?"]);
  expect(searchCoordinatorActions(all, "#9").map((c) => c.title)).toEqual(["#9 Add search"]);
  expect(searchCoordinatorActions(all, "9 add").map((c) => c.title)).toEqual(["#9 Add search"]);
});

test("the docked header opens a palette over every action, older than the visible ten", async () => {
  render(<ActionsPanel docked cards={visible} searchCards={all} onNavigate={() => {}} />);
  // The panel itself shows only the newest ten.
  expect(screen.queryByRole("button", { name: "Release planning" }) === null).toBe(true);
  await openSearch();
  expect(screen.getByTestId("coordinator-action-search-dialog")).toBeTruthy();
  expect(optionNames()).toHaveLength(all.length);
  expect(optionNames()[0]).toBe("#9 Add search");
  expect(optionNames().at(-1)).toBe("Release planning");
  expect(selectedName()).toBe("#9 Add search");
});

test("typing filters, and a query with no match shows the empty state", async () => {
  render(<ActionsPanel docked cards={visible} searchCards={all} onNavigate={() => {}} />);
  const input = await openSearch();
  fireEvent.change(input, { target: { value: "pr" } });
  expect(optionNames()).toEqual(["#9 Add search", "Done: #7 Fix the build"]);
  fireEvent.change(input, { target: { value: "release" } });
  expect(optionNames()).toEqual(["Release planning"]);
  fireEvent.change(input, { target: { value: "zzz" } });
  expect(optionNames()).toEqual([]);
  expect(screen.getByText("No actions match that search.")).toBeTruthy();
});

test("arrow keys move the selection and Enter navigates to an older action", async () => {
  const targets: string[] = [];
  render(
    <ActionsPanel
      docked
      cards={visible}
      searchCards={all}
      onNavigate={(anchor) => targets.push(anchor)}
    />,
  );
  const input = await openSearch();
  for (let step = 0; step < all.length + 3; step += 1)
    fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(selectedName()).toBe("Release planning");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(selectedName()).toBe("Done: #7 Fix the build");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(
    screen.getByRole("option", { name: "Release planning" }).id,
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(targets).toEqual(["row-0"]);
  await waitFor(() =>
    expect(screen.queryByTestId("coordinator-action-search-dialog") === null).toBe(true),
  );
});

test("keys an IME is composing with neither move the selection nor choose an action", async () => {
  const targets: string[] = [];
  render(
    <ActionsPanel
      docked
      cards={visible}
      searchCards={all}
      onNavigate={(anchor) => targets.push(anchor)}
    />,
  );
  const input = await openSearch();
  expect(selectedName()).toBe("#9 Add search");
  // Chromium and Firefox: the confirming and candidate keys are flagged as composing.
  fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  // WebKit ends the composition first; only keyCode 229 marks the confirming key.
  fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(selectedName()).toBe("#9 Add search");
  expect(targets).toEqual([]);
  expect(screen.getByTestId("coordinator-action-search-dialog")).toBeTruthy();

  // Once the composition is over, the same keys drive the palette again.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(targets).toEqual(["row-12"]);
  await waitFor(() =>
    expect(screen.queryByTestId("coordinator-action-search-dialog") === null).toBe(true),
  );
});

test("Escape closes the palette and returns focus to the search button", async () => {
  render(<ActionsPanel docked cards={visible} searchCards={all} onNavigate={() => {}} />);
  const button = screen.getByRole("button", { name: "Search actions" });
  const input = await openSearch();
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByTestId("coordinator-action-search-dialog") === null).toBe(true),
  );
  await waitFor(() => expect(document.activeElement).toBe(button));
});

test("a folded docked panel keeps search beside its icon", async () => {
  act(() => setCoordinatorActionsDockedOpen(false));
  const targets: string[] = [];
  render(
    <ActionsPanel
      docked
      cards={visible}
      searchCards={all}
      onNavigate={(anchor) => targets.push(anchor)}
    />,
  );
  expect(screen.getByRole("button", { name: /Actions, \d+ waiting/ })).toBeTruthy();
  // Only the folded button is reachable; the hidden header's copy is not.
  expect(screen.getAllByRole("button", { name: "Search actions" })).toHaveLength(1);
  await openSearch();
  fireEvent.click(screen.getByRole("option", { name: "Which database?" }));
  expect(targets).toEqual(["row-2"]);
});

test("the narrow overlay offers search once expanded and stays open behind the palette", async () => {
  render(<ActionsPanel docked={false} cards={visible} searchCards={all} onNavigate={() => {}} />);
  const icon = screen.getByRole("button", { name: /Actions, \d+ waiting/ });
  expect(screen.queryByRole("button", { name: "Search actions" }) === null).toBe(true);
  fireEvent.click(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  const button = screen.getByRole("button", { name: "Search actions" });
  const input = await openSearch();
  // A pointer press inside the palette is outside the overlay, yet it stays open.
  fireEvent.pointerDown(input);
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByTestId("coordinator-action-search-dialog") === null).toBe(true),
  );
  await waitFor(() => expect(document.activeElement).toBe(button));
  expect(icon.getAttribute("aria-expanded")).toBe("true");
});

test("choosing from the narrow overlay folds it and focuses its icon", async () => {
  const targets: string[] = [];
  render(
    <ActionsPanel
      docked={false}
      cards={visible}
      searchCards={all}
      onNavigate={(anchor) => targets.push(anchor)}
    />,
  );
  const icon = screen.getByRole("button", { name: /Actions, \d+ waiting/ });
  fireEvent.click(icon);
  await openSearch();
  fireEvent.click(screen.getByRole("option", { name: "Release planning" }));
  expect(targets).toEqual(["row-0"]);
  await waitFor(() => expect(document.activeElement).toBe(icon));
  expect(icon.getAttribute("aria-expanded")).toBe("false");
});

test("an action whose message is only in unloaded history is listed and navigates to its anchor", async () => {
  const mark = (id: string, title: string): NativeMessage => ({
    id,
    role: "assistant",
    content: "",
    createdAt: "2026-11-01T10:00:00Z",
    parts: [
      {
        type: "tool-invocation",
        content: "",
        toolName: "mcp__orkestrator__mark_question",
        toolArgs: { title },
        toolState: "success",
      },
    ],
  });
  const history = [mark("old-row", "Archived decision")];
  const loaded = [mark("live-row", "Current question")];
  const everything = coordinatorActionCards([...history, ...loaded]);
  // As the shell does: loaded cards re-index into the loaded window.
  const panelCards = visibleCoordinatorCards(
    everything
      .map((c) => ({ ...c, index: loaded.findIndex((m) => m.id === c.anchorId) }))
      .filter((c) => c.index >= 0),
    loaded.length - 1,
  );
  const targets: string[] = [];
  render(
    <ActionsPanel
      docked
      cards={panelCards}
      searchCards={everything}
      onNavigate={(anchor) => targets.push(anchor)}
    />,
  );
  expect(screen.queryByRole("button", { name: "Archived decision" }) === null).toBe(true);
  const input = await openSearch();
  fireEvent.change(input, { target: { value: "archived" } });
  expect(optionNames()).toEqual(["Archived decision"]);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(targets).toEqual(["old-row"]);
});
