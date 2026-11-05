import {
  artifactSearchBodyRevision,
  cachedArtifactSearchBody,
  clearArtifactRequestCache,
  rememberArtifactSearchBody,
} from "@/lib/chat/artifact-requests";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useRef, type ChangeEvent } from "react";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { artifactPartContent } from "@orkestrator/protocol/transcript-artifacts";
import type { TranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts";
import { clearProtectedRichContent } from "@/lib/chat/rich-content-reset";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import { useAgentChatFind, type AgentChatFindMatch } from "./AgentChatFind";
import {
  getNativeMessageSearchProjection,
  getNativeMessageSearchText,
} from "./native-message-search";

interface Row {
  id: string;
  parts: Array<{ type: string; content: string }>;
}

afterEach(() => cleanup());

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    parts: [{ type: "text", content: `needle ${index}` }],
  }));
}

function setup(initialItems: Row[], initialActive = true) {
  const getSearchText = mock((item: Row) => item.parts[0]!.content);
  const onNavigate = () => {};
  const hook = renderHook(
    ({ items, isActive }: { items: Row[]; isActive: boolean }) => {
      const ownerRef = useRef<HTMLElement | null>(null);
      return useAgentChatFind({ items, getSearchText, isActive, ownerRef, onNavigate });
    },
    { initialProps: { items: initialItems, isActive: initialActive } },
  );
  const type = (value: string) =>
    act(() => {
      hook.result.current.onQueryChange({ target: { value } } as ChangeEvent<HTMLInputElement>);
    });
  const toggleFind = () => fireEvent.keyDown(document, { key: "f", metaKey: true });
  return { ...hook, getSearchText, type, toggleFind };
}

describe("useAgentChatFind indexing (WEB-10)", () => {
  test("a transcript update re-reads only the rows it changed, even as new objects", () => {
    const items = rows(1000);
    const { rerender, result, getSearchText, type, toggleFind } = setup(items);
    toggleFind();
    type("needle");
    expect(getSearchText).toHaveBeenCalledTimes(1000);
    expect(result.current.matches).toHaveLength(1000);

    getSearchText.mockClear();
    const reparsed = structuredClone(items);
    rerender({ items: reparsed, isActive: true });
    expect(getSearchText).toHaveBeenCalledTimes(0);

    const changed = structuredClone(reparsed);
    changed[500]!.parts[0]!.content = "changed";
    rerender({ items: changed, isActive: true });
    expect(getSearchText).toHaveBeenCalledTimes(1);
    expect(result.current.matches).toHaveLength(999);
    expect(result.current.matches.some((match) => match.itemIndex === 500)).toBe(false);
  });

  test("appended rows are read once and removed rows leave the matches", () => {
    const items = rows(3);
    const { rerender, result, getSearchText, type, toggleFind } = setup(items);
    toggleFind();
    type("needle");
    getSearchText.mockClear();

    rerender({ items: [...items, ...rows(4).slice(3)], isActive: true });
    expect(getSearchText).toHaveBeenCalledTimes(1);
    expect(result.current.matches).toHaveLength(4);

    rerender({ items: items.slice(1), isActive: true });
    expect(result.current.matches.map((match) => match.itemIndex)).toEqual([0, 1]);
  });

  test("keeps rows apart when a page of older history shifts every index", () => {
    const items = rows(3);
    const { rerender, result, getSearchText, type, toggleFind } = setup(items);
    toggleFind();
    type("needle 2");
    expect(result.current.matches.map((match) => match.itemIndex)).toEqual([2]);
    getSearchText.mockClear();

    const older: Row = { id: "older", parts: [{ type: "text", content: "older text" }] };
    rerender({ items: [older, ...items], isActive: true });
    expect(getSearchText).toHaveBeenCalledTimes(1);
    expect(result.current.matches.map((match) => match.itemIndex)).toEqual([3]);
  });

  test("typing another query does not read any row again", () => {
    const { getSearchText, result, type, toggleFind } = setup(rows(5));
    toggleFind();
    type("needle");
    getSearchText.mockClear();
    type("needle 3");
    expect(getSearchText).toHaveBeenCalledTimes(0);
    expect(result.current.matches).toHaveLength(1);
  });

  test("a closed find bar with a query left in it costs nothing per update", () => {
    const items = rows(5);
    const { rerender, result, getSearchText, type, toggleFind } = setup(items);
    toggleFind();
    type("needle");
    act(() => result.current.onClose());
    getSearchText.mockClear();

    rerender({ items: structuredClone(items), isActive: true });
    expect(getSearchText).toHaveBeenCalledTimes(0);
    expect(result.current.matches).toEqual([]);

    toggleFind();
    expect(result.current.query).toBe("needle");
    expect(result.current.matches).toHaveLength(5);
  });

  test("clearing protected rich content drops the held text", () => {
    const items = rows(2);
    const { rerender, getSearchText, type, toggleFind } = setup(items);
    toggleFind();
    type("needle");
    getSearchText.mockClear();

    clearProtectedRichContent("logout");
    rerender({ items: structuredClone(items), isActive: true });
    expect(getSearchText).toHaveBeenCalledTimes(2);
  });
});

test("an open bar follows artifact bodies as they are published and withdrawn", () => {
  const items = [{ id: "artifact-row", parts: [{ type: "artifact", content: "summary" }] }];
  const artifact = { publicationId: "search-test", artifactId: "artifact-test", revision: 1 };
  const getSearchText = () => `summary ${cachedArtifactSearchBody(artifact) ?? ""}`;
  const hook = renderHook(() =>
    useAgentChatFind({
      items,
      getSearchText,
      isActive: true,
      ownerRef: useRef<HTMLElement | null>(null),
      onNavigate: () => {},
    }),
  );
  fireEvent.keyDown(document, { key: "f", metaKey: true });
  act(() =>
    hook.result.current.onQueryChange({
      target: { value: "body" },
    } as ChangeEvent<HTMLInputElement>),
  );
  expect(hook.result.current.matches).toHaveLength(0);
  const scope = { backendId: "backend", environmentId: "env", logicalSessionKey: "session" };
  act(() => rememberArtifactSearchBody(artifact, "body loaded", scope));
  expect(hook.result.current.matches).toHaveLength(1);
  act(() => rememberArtifactSearchBody(artifact, null, scope));
  expect(hook.result.current.matches).toHaveLength(0);
});

describe("a body arriving while find is open", () => {
  const SCOPE = { backendId: "backend", environmentId: "env", logicalSessionKey: "session" };
  const REF: TranscriptArtifactRef = {
    schemaVersion: 1,
    artifactId: "art_abcdefgh1",
    revision: 2,
    publicationId: "pub_abcdefgh1",
    kind: "html-static",
    title: "Report title",
    summary: "A needle summary",
    provenance: { backendId: "backend", origin: "agent" },
  };
  const artifactPart = {
    type: "artifact",
    content: artifactPartContent(REF),
    artifact: REF,
    publishedAt: "2026-11-05T10:00:00.000Z",
    conversationSequence: 1,
  } as NativeMessagePart;
  const textPart = (content: string) => ({ type: "text", content }) as NativeMessagePart;
  const row = (id: string, parts: NativeMessagePart[]): NativeMessage => ({
    id,
    role: "assistant",
    content: "",
    createdAt: "2026-11-05T10:00:00.000Z",
    parts,
  });

  function open(initialItems: NativeMessage[], query = "needle") {
    const onNavigate = mock((_match: AgentChatFindMatch, _query: string) => {});
    const getSearchText = mock(getNativeMessageSearchText);
    const hook = renderHook(
      ({ items }: { items: NativeMessage[] }) =>
        useAgentChatFind({
          items,
          getSearchText,
          getSearchProjection: getNativeMessageSearchProjection,
          isActive: true,
          ownerRef: useRef<HTMLElement | null>(null),
          onNavigate,
        }),
      { initialProps: { items: initialItems } },
    );
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    act(() =>
      hook.result.current.onQueryChange({
        target: { value: query },
      } as ChangeEvent<HTMLInputElement>),
    );
    const next = () => act(() => hook.result.current.onNext());
    return { ...hook, onNavigate, getSearchText, next };
  }

  /** What the selected match is, whatever its place in the list. */
  function selectedText(
    hook: { result: { current: ReturnType<typeof useAgentChatFind> } },
    items: NativeMessage[],
  ) {
    const match = hook.result.current.currentMatch!;
    const { text } = getNativeMessageSearchProjection(items[match.itemIndex]!);
    return text.slice(match.characterIndex, match.characterIndex + 20);
  }

  beforeEach(() => clearArtifactRequestCache());
  afterEach(() => clearArtifactRequestCache());

  test("in an earlier row, updates the count and keeps the selected match", () => {
    const items = [
      row("report", [artifactPart]),
      row("later", [textPart("needle in the later row")]),
    ];
    const view = open(items);
    expect(view.result.current.matches).toHaveLength(2);
    view.next();
    expect(view.result.current.currentMatchIndex).toBe(1);
    const navigations = view.onNavigate.mock.calls.length;

    act(() => rememberArtifactSearchBody(REF, "needle one, needle two", SCOPE));

    expect(view.result.current.matches).toHaveLength(4);
    expect(view.result.current.currentMatchIndex).toBe(3);
    expect(selectedText(view, items)).toBe("needle in the later ");
    // The same match is not a navigation: the reader stays where they scrolled.
    expect(view.onNavigate.mock.calls).toHaveLength(navigations);
  });

  test("before the selected match in its own row, keeps that match", () => {
    const items = [row("report", [artifactPart, textPart("needle after the report")])];
    const view = open(items);
    view.next();
    expect(selectedText(view, items)).toBe("needle after the rep");
    const navigations = view.onNavigate.mock.calls.length;

    // The body starts like the text after it, so comparing the row's text could not tell them apart.
    act(() => rememberArtifactSearchBody(REF, "needle after the body", SCOPE));

    expect(view.result.current.matches).toHaveLength(3);
    expect(view.result.current.currentMatchIndex).toBe(2);
    expect(selectedText(view, items)).toBe("needle after the rep");
    expect(view.onNavigate.mock.calls).toHaveLength(navigations);
  });

  test("after the selected match, changes the count and leaves its place alone", () => {
    const items = [row("first", [textPart("needle first")]), row("report", [artifactPart])];
    const view = open(items);
    expect(view.result.current.currentMatchIndex).toBe(0);
    act(() => rememberArtifactSearchBody(REF, "needle body", SCOPE));
    expect(view.result.current.matches).toHaveLength(3);
    expect(view.result.current.currentMatchIndex).toBe(0);
    expect(selectedText(view, items)).toBe("needle first");
  });

  test("stepping continues from the kept match, and each new match is a navigation", () => {
    const items = [row("report", [artifactPart]), row("later", [textPart("needle later")])];
    const view = open(items);
    view.next();
    act(() => rememberArtifactSearchBody(REF, "needle body", SCOPE));
    expect(view.result.current.currentMatchIndex).toBe(2);
    const navigations = view.onNavigate.mock.calls.length;
    view.next();
    expect(view.result.current.currentMatchIndex).toBe(0);
    expect(view.onNavigate.mock.calls).toHaveLength(navigations + 1);
  });

  test("withdrawing the body that holds the selected match falls to what now holds its place", () => {
    const items = [row("report", [artifactPart]), row("later", [textPart("needle later")])];
    act(() => rememberArtifactSearchBody(REF, "needle body", SCOPE));
    const view = open(items);
    view.next();
    expect(selectedText(view, items)).toBe("needle body");
    const navigations = view.onNavigate.mock.calls.length;
    act(() => rememberArtifactSearchBody(REF, null, SCOPE));
    expect(view.result.current.matches).toHaveLength(2);
    expect(view.result.current.currentMatchIndex).toBe(1);
    expect(selectedText(view, items)).toBe("needle later");
    expect(view.onNavigate.mock.calls).toHaveLength(navigations + 1);
  });

  test("a page of older history keeps the selected match too", () => {
    const items = [
      row("first", [textPart("needle first")]),
      row("second", [textPart("needle second")]),
    ];
    const view = open(items);
    view.next();
    const navigations = view.onNavigate.mock.calls.length;
    const paged = [row("older", [textPart("needle older")]), ...items];
    view.rerender({ items: paged });
    expect(view.result.current.currentMatchIndex).toBe(2);
    expect(selectedText(view, paged)).toBe("needle second");
    expect(view.onNavigate.mock.calls).toHaveLength(navigations);
  });

  test("a row streaming after the selected match does not move it", () => {
    const items = [row("first", [textPart("needle first")])];
    const view = open(items);
    const navigations = view.onNavigate.mock.calls.length;
    const streamed = [row("first", [textPart("needle first and needle more")])];
    view.rerender({ items: streamed });
    expect(view.result.current.matches).toHaveLength(2);
    expect(view.result.current.currentMatchIndex).toBe(0);
    expect(view.onNavigate.mock.calls).toHaveLength(navigations);
  });

  test("a closed bar does not read the body or re-render for it", () => {
    let renders = 0;
    const getSearchText = mock(getNativeMessageSearchText);
    const items = [row("report", [artifactPart])];
    renderHook(() => {
      renders += 1;
      return useAgentChatFind({
        items,
        getSearchText,
        isActive: true,
        ownerRef: useRef<HTMLElement | null>(null),
        onNavigate: () => {},
      });
    });
    const before = renders;
    act(() => rememberArtifactSearchBody(REF, "needle body", SCOPE));
    expect(renders).toBe(before);
    expect(getSearchText).toHaveBeenCalledTimes(0);
  });

  test("only a body's own row is read again", () => {
    const items = [row("report", [artifactPart]), row("later", [textPart("needle later")])];
    const view = open(items);
    view.getSearchText.mockClear();
    act(() => rememberArtifactSearchBody(REF, "needle body", SCOPE));
    expect(view.getSearchText).toHaveBeenCalledTimes(1);
  });

  test("a card mounting again with the same body changes nothing", () => {
    rememberArtifactSearchBody(REF, "needle body", SCOPE);
    const revision = artifactSearchBodyRevision();
    rememberArtifactSearchBody(REF, "needle body", SCOPE);
    expect(artifactSearchBodyRevision()).toBe(revision);
    rememberArtifactSearchBody(REF, "needle changed", SCOPE);
    expect(artifactSearchBodyRevision()).toBe(revision + 1);
  });
});
