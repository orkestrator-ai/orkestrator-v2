import { cachedArtifactSearchBody, rememberArtifactSearchBody } from "@/lib/chat/artifact-requests";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { useRef, type ChangeEvent } from "react";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { clearProtectedRichContent } from "@/lib/chat/rich-content-reset";
import { useAgentChatFind } from "./AgentChatFind";

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

test("unchanged artifact rows refresh body text after publication and withdrawal", () => {
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
  const query = (value: string) =>
    act(() =>
      hook.result.current.onQueryChange({ target: { value } } as ChangeEvent<HTMLInputElement>),
    );
  query("body");
  expect(hook.result.current.matches).toHaveLength(0);
  const scope = { backendId: "backend", environmentId: "env", logicalSessionKey: "session" };
  rememberArtifactSearchBody(artifact, "body loaded", scope);
  query("loaded");
  expect(hook.result.current.matches).toHaveLength(1);
  rememberArtifactSearchBody(artifact, null, scope);
  query("body");
  expect(hook.result.current.matches).toHaveLength(0);
});
