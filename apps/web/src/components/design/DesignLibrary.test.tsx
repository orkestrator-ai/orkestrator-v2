import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesignLibraryQuery } from "@orkestrator/protocol/design-operations";
import { DesignClientError } from "./design-client";
import type { DesignLibraryItem, DesignLibraryResult } from "./design-launch";
import type { DesignOpenChoices } from "./design-open";
import { DesignLibrary, type DesignLibraryClient } from "./DesignLibrary";

afterEach(cleanup);

function entry(id: string, overrides: Partial<DesignLibraryItem> = {}): DesignLibraryItem {
  return {
    id,
    name: `Design ${id}`,
    revision: 4,
    modifiedAt: "2026-09-20T10:00:00.000Z",
    createdAt: "2026-09-20T09:00:00.000Z",
    frameCount: 2,
    state: "live",
    validation: { invalid: 0, unvalidated: 0 },
    ...overrides,
  };
}

function page(
  entries: DesignLibraryItem[],
  extra: Partial<DesignLibraryResult> = {},
): DesignLibraryResult {
  return {
    entries,
    total: entries.length,
    quota: {
      live: entries.length,
      liveLimit: 256,
      deleted: 0,
      deletedLimit: 32,
      deletedBytes: 0,
      deletedBytesLimit: 1,
    },
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function client(list: DesignLibraryClient["list"], overrides: Partial<DesignLibraryClient> = {}) {
  return {
    list: mock(list),
    lifecycle: mock(overrides.lifecycle ?? (async () => ({}) as never)),
    purge: mock(overrides.purge ?? (async () => ({ purged: true }))),
    exportDocument: mock(overrides.exportDocument ?? (async () => ({}) as never)),
  };
}

const closedChoices = (): DesignOpenChoices => ({ canOpen: true, besideFallsBack: false });

function mount(api: DesignLibraryClient, props: Partial<Parameters<typeof DesignLibrary>[0]> = {}) {
  const onOpen = mock((): string | null => null);
  const view = render(
    <DesignLibrary
      environmentId="env-a"
      backendKey="local"
      legacy={false}
      canManage
      client={api}
      openChoices={closedChoices}
      onOpen={onOpen}
      searchDebounceMs={0}
      {...props}
    />,
  );
  return { onOpen, ...view };
}

const names = () =>
  Array.from(document.querySelectorAll('ul[aria-label="Designs"] [data-design-name]')).map(
    (node) => node.textContent,
  );

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("DesignLibrary", () => {
  test("lists summaries with frame count, export and validation state", async () => {
    const api = client(async () =>
      page([
        entry("a", {
          export: { relativePath: "a.orkdes", revision: 2, outdated: true },
          validation: { invalid: 1, unvalidated: 2 },
        }),
      ]),
    );
    mount(api);
    await flush();
    const item = screen.getByRole("button", { name: /Design a/ });
    expect(item.textContent).toContain("2 frames");
    expect(item.textContent).toContain("Saved copy outdated (a.orkdes)");
    expect(item.textContent).toContain("1 invalid");
    expect(item.textContent).toContain("2 unvalidated");
    expect(api.list.mock.calls[0]?.[1]).toEqual({
      search: undefined,
      sort: "modified",
      filter: "live",
      offset: 0,
      limit: 50,
    });
  });

  test("searches by name and loads more with nextOffset", async () => {
    const api = client(async (_env, query: DesignLibraryQuery) => {
      if (query.search) return page([entry("match")]);
      if (query.offset === 50) return page([entry("second")], { total: 51 });
      return page([entry("first")], { total: 51, nextOffset: 50 });
    });
    mount(api);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await flush();
    expect(names()).toEqual(["Design first", "Design second"]);
    expect(screen.getByText("Showing 2 of 51")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search designs" }), {
      target: { value: "match" },
    });
    await flush();
    expect(api.list.mock.calls.at(-1)?.[1]).toMatchObject({ search: "match", offset: 0 });
    expect(names()).toEqual(["Design match"]);
  });

  test("shows an empty state and a list error without losing loaded entries", async () => {
    let fail = false;
    const api = client(async () => {
      if (fail) throw new Error("Library index unavailable");
      return page([entry("a")]);
    });
    mount(api);
    await flush();
    fail = true;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search designs" }), {
      target: { value: "x" },
    });
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Library index unavailable");
    expect(names()).toEqual(["Design a"]);

    cleanup();
    mount(client(async () => page([])));
    await flush();
    expect(screen.getByText(/No designs yet/)).toBeTruthy();
  });

  test("ignores a late response after the environment changes", async () => {
    const slow = deferred<DesignLibraryResult>();
    const api = client((environmentId) =>
      environmentId === "env-a" ? slow.promise : Promise.resolve(page([entry("b")])),
    );
    const { rerender, onOpen } = mount(api);
    rerender(
      <DesignLibrary
        environmentId="env-b"
        backendKey="local"
        legacy={false}
        canManage
        client={api}
        openChoices={closedChoices}
        onOpen={onOpen}
        searchDebounceMs={0}
      />,
    );
    await flush();
    expect(names()).toEqual(["Design b"]);
    slow.resolve(page([entry("a-late")]));
    await flush();
    expect(names()).toEqual(["Design b"]);
  });

  test("a failed rename keeps the selection and the list", async () => {
    const api = client(async () => page([entry("a"), entry("b")]), {
      lifecycle: mock(async () => {
        throw new DesignClientError({
          code: "conflict",
          message: "Revision changed",
          retry: "after-refresh",
        });
      }),
    });
    mount(api);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Design a/ }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New name for Design a" }), {
      target: { value: "  Renamed  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await flush();
    expect(api.lifecycle).toHaveBeenCalledWith(
      "env-a",
      "a",
      { kind: "rename_canvas", name: "Renamed" },
      { canvasRevision: 4 },
    );
    expect(screen.getByRole("alert").textContent).toContain("Rename failed: Revision changed");
    expect(names()).toEqual(["Design a", "Design b"]);
    expect(screen.getByRole("button", { name: /Design a/, pressed: true })).toBeTruthy();
  });

  test("trash requires confirmation and uses the reviewed revision", async () => {
    const api = client(async () => page([entry("a")]));
    mount(api);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Design a/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    expect(api.lifecycle).not.toHaveBeenCalled();
    expect(screen.getByText(/You can restore it for 7 days/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    await flush();
    expect(api.lifecycle).toHaveBeenCalledWith(
      "env-a",
      "a",
      { kind: "delete_canvas" },
      { canvasRevision: 4 },
    );
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  test("deleted designs can be restored with the tombstone revision or purged explicitly", async () => {
    const api = client(async () =>
      page([
        entry("gone", { state: "deleted", revision: 9, deletedAt: "2026-09-21T00:00:00.000Z" }),
      ]),
    );
    mount(api);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Design gone/ }));
    expect(screen.queryByRole("button", { name: "Open beside" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await flush();
    expect(api.lifecycle).toHaveBeenCalledWith(
      "env-a",
      "gone",
      { kind: "restore_canvas" },
      { tombstoneRevision: 9 },
    );
    fireEvent.click(screen.getByRole("button", { name: /Design gone/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(api.purge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await flush();
    expect(api.purge).toHaveBeenCalledWith("env-a", "gone");
  });

  test("open actions follow the layout choices", async () => {
    const api = client(async () => page([entry("a"), entry("b")]));
    const { onOpen } = mount(api, {
      openChoices: (canvasId) =>
        canvasId === "a"
          ? { openTabId: "tab-a", canOpen: true, besideFallsBack: false }
          : { canOpen: true, besideFallsBack: true, notice: "Split depth reached." },
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Design a/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show open tab" }));
    expect(onOpen).toHaveBeenLastCalledWith("a", "current");
    fireEvent.click(screen.getByRole("button", { name: /Design b/ }));
    expect(screen.queryByRole("button", { name: "Open here" }) === null).toBe(true);
    expect(screen.getByText("Split depth reached.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open (current pane)" }));
    expect(onOpen).toHaveBeenLastCalledWith("b", "split");
  });

  test("an old backend hides lifecycle actions", async () => {
    const api = client(async () => page([entry("a", { legacy: true })]));
    mount(api, { legacy: true, canManage: false });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Design a/ }));
    expect(screen.getByRole("button", { name: "Open beside" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    for (const label of ["Rename", "Duplicate", "Move to trash"])
      expect(screen.queryByRole("button", { name: label }) === null).toBe(true);
    expect(screen.queryByRole("combobox", { name: "Show designs" }) === null).toBe(true);
  });
});
