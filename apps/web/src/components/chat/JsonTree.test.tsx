import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MAX_JSON_RENDER_DEPTH,
  MAX_JSON_RENDER_ENTRIES,
} from "@/lib/chat/json-payload";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { JsonTree } from "./JsonTree";

afterEach(cleanup);

beforeEach(() => {
  useMessagePartExpansionStore.getState().reset();
});

describe("JsonTree scalars", () => {
  test("distinguishes null, undefined and the empty string from a value", () => {
    render(
      <JsonTree
        value={{ missing: null, blank: "", present: "text" }}
        expansionKey="t"
      />,
    );

    // A null field is not the same as a field holding an empty string, and
    // neither should render as nothing at all.
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("empty")).toBeTruthy();
    expect(screen.getByText("text")).toBeTruthy();
  });

  test("renders booleans and numbers as literals", () => {
    render(
      <JsonTree value={{ enabled: false, count: 0 }} expansionKey="t" />,
    );

    expect(screen.getByText("false")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
  });

  test("states an empty container in place rather than folding it", () => {
    render(
      <JsonTree value={{ items: [], meta: {} }} expansionKey="t" />,
    );

    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("No fields")).toBeTruthy();
  });
});

describe("JsonTree arrays", () => {
  test("renders an all-scalar array as a plain list", () => {
    render(<JsonTree value={["alpha", "beta", 3]} expansionKey="t" />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  test("renders a scalar sitting among records without a disclosure", () => {
    render(
      <JsonTree value={["loose", { title: "Recorded" }]} expansionKey="t" />,
    );

    // Mixed arrays drop the bullet list, but the scalar must still be shown,
    // and the record keeps its own position rather than being renumbered.
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.getByText("loose")).toBeTruthy();
    expect(screen.getByText("2. Recorded")).toBeTruthy();
  });

  test("states an empty record among records rather than folding it", () => {
    render(<JsonTree value={[{}, { title: "Recorded" }]} expansionKey="t" />);

    expect(screen.getByText("No fields")).toBeTruthy();
    expect(screen.getByText("2. Recorded")).toBeTruthy();
  });

  test("numbers an unlabelled record by position", () => {
    render(<JsonTree value={[{ count: 1 }]} expansionKey="t" />);

    expect(screen.getByText("Item 1")).toBeTruthy();
  });
});

describe("JsonTree bounds", () => {
  test("stops safely at the render depth without re-serializing the branch", () => {
    // The payload-level raw disclosure holds the bounded original source.
    // Re-stringifying a deeply nested parsed value here can expand quadratically.
    render(
      <JsonTree
        value={{ deep: "value" }}
        depth={MAX_JSON_RENDER_DEPTH}
        expansionKey="t"
      />,
    );

    expect(screen.getByText(/Maximum nesting depth reached/)).toBeTruthy();
    expect(screen.queryByText(/"deep": "value"/)).toBeNull();
  });

  test("renders one level below the depth cap as structure", () => {
    render(
      <JsonTree
        value={{ deep: "value" }}
        depth={MAX_JSON_RENDER_DEPTH - 1}
        expansionKey="t"
      />,
    );

    expect(screen.getByText("Deep")).toBeTruthy();
    expect(screen.getByText("value")).toBeTruthy();
  });

  test("caps the fields it renders and says how many it withheld", () => {
    const wide = Object.fromEntries(
      Array.from({ length: MAX_JSON_RENDER_ENTRIES + 7 }, (_, index) => [
        `field${index}`,
        index,
      ]),
    );
    render(<JsonTree value={wide} expansionKey="t" />);

    expect(screen.getByText(/^7 more not shown/)).toBeTruthy();
    expect(screen.getByText("Field0")).toBeTruthy();
    expect(
      screen.queryByText(`Field${MAX_JSON_RENDER_ENTRIES}`),
    ).toBeNull();
  });

  test("caps the items it renders and says how many it withheld", () => {
    const long = Array.from(
      { length: MAX_JSON_RENDER_ENTRIES + 3 },
      (_, index) => index,
    );
    render(<JsonTree value={long} expansionKey="t" />);

    expect(screen.getAllByRole("listitem")).toHaveLength(
      MAX_JSON_RENDER_ENTRIES,
    );
    expect(screen.getByText(/^3 more not shown/)).toBeTruthy();
  });

  test("does not claim truncation when everything fits", () => {
    render(<JsonTree value={[1, 2]} expansionKey="t" />);

    expect(screen.queryByText(/more not shown/)).toBeNull();
  });
});

describe("JsonTree expansion persistence", () => {
  test("a branch remembers its state against the document key", () => {
    const value = { verdict: { ready: "no" }, scope: { files: 2 } };
    const view = render(<JsonTree value={value} expansionKey="msg/tree" />);

    fireEvent.click(screen.getByText("Verdict"));
    expect(screen.getByText("no")).toBeTruthy();

    view.unmount();
    render(<JsonTree value={value} expansionKey="msg/tree" />);

    // Keyed by `msg/tree/verdict`, so the sibling branch stays closed.
    expect(screen.getByText("no")).toBeTruthy();
    expect(screen.queryByText("2")).toBeNull();
  });

  test("the same key opens the same branch in an identical tree", () => {
    const value = { verdict: { ready: "no" } };
    render(
      <>
        <JsonTree value={value} expansionKey="msg/a" />
        <JsonTree value={value} expansionKey="msg/b" />
      </>,
    );

    fireEvent.click(screen.getAllByText("Verdict")[0]!);

    // Distinct prefixes, so opening one must not open the other.
    expect(screen.getAllByText("no")).toHaveLength(1);
  });

  test("keeps delimiter-bearing object keys distinct from nested paths", () => {
    render(
      <JsonTree
        value={{
          "a/b": { direct: "open" },
          a: { b: { nested: "closed" } },
        }}
        expansionKey="msg/tree"
      />,
    );

    fireEvent.click(screen.getByText("A/b"));
    expect(screen.getByText("open")).toBeTruthy();

    fireEvent.click(screen.getByText("A"));
    expect(screen.getByText("B")).toBeTruthy();
    expect(screen.queryByText("closed")).toBeNull();
  });

  test("accepts valid JSON keys containing lone UTF-16 surrogates", () => {
    expect(() =>
      render(
        <JsonTree
          value={{ ["\ud800"]: { value: "reachable" } }}
          expansionKey="msg/tree"
        />,
      )
    ).not.toThrow();
  });
});
