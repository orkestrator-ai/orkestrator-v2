import { describe, expect, test } from "bun:test";
import { RendererDebugTools, type DebugRenderer } from "../electron/renderer-debug-tools";

function renderer(id: number) {
  const opened: unknown[] = [];
  let destroyed = false;
  let onDestroyed: (() => void) | null = null;
  const contents: DebugRenderer = {
    id,
    isDestroyed: () => destroyed,
    openDevTools: (options) => opened.push(options),
    once: (_event, listener) => {
      onDestroyed = listener;
    },
  };
  return {
    contents,
    opened,
    destroy() {
      destroyed = true;
      onDestroyed?.();
    },
  };
}

describe("renderer debug tools", () => {
  test("the menu changes only when whether any renderer has debug on changes", () => {
    let changes = 0;
    const tools = new RendererDebugTools(() => changes++);
    const first = renderer(1);
    const second = renderer(2);
    tools.report(first.contents, false);
    expect(changes).toBe(0);
    tools.report(first.contents, true);
    tools.report(second.contents, true);
    expect(tools.anyEnabled()).toBe(true);
    expect(changes).toBe(1);
    tools.report(first.contents, false);
    expect(changes).toBe(1);
    second.destroy();
    expect(tools.anyEnabled()).toBe(false);
    expect(changes).toBe(2);
  });

  test("opens the focused renderer only if it turned debug on, else its window's", () => {
    const tools = new RendererDebugTools(() => undefined);
    const realm = renderer(7);
    const shell = renderer(3);
    tools.report(realm.contents, false);
    tools.report(shell.contents, true);
    expect(tools.open([realm.contents, shell.contents])).toBe(true);
    expect(realm.opened).toHaveLength(0);
    expect(shell.opened).toEqual([{ mode: "detach" }]);
  });

  test("never opens a renderer that did not report debug on", () => {
    const tools = new RendererDebugTools(() => undefined);
    const preview = renderer(9);
    expect(tools.open([preview.contents, null])).toBe(false);
    expect(preview.opened).toHaveLength(0);
  });
});
