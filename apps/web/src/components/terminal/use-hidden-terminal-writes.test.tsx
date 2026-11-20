import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import {
  BACKGROUND_WRITES_STORAGE_KEY,
  disposeBackgroundWriteScheduler,
} from "@/lib/terminal-background-writes";
import { useHiddenTerminalWrites } from "./use-hidden-terminal-writes";

function fakeTerminal() {
  const written: string[] = [];
  const terminal = {
    write(data: Uint8Array, parsed?: () => void) {
      written.push(new TextDecoder().decode(data));
      parsed?.();
    },
  };
  return { terminal: terminal as unknown as Terminal, written };
}

const bytes = (text: string) => new TextEncoder().encode(text);

afterEach(() => {
  localStorage.removeItem(BACKGROUND_WRITES_STORAGE_KEY);
  disposeBackgroundWriteScheduler();
});

describe("useHiddenTerminalWrites", () => {
  test("a shown tab writes straight into xterm", () => {
    const { terminal, written } = fakeTerminal();
    const hook = renderHook(() => useHiddenTerminalWrites(terminal, true));
    let parsed = 0;
    hook.result.current.write(bytes("echo"), () => (parsed += 1));
    expect(written).toEqual(["echo"]);
    expect(parsed).toBe(1);
    hook.unmount();
  });

  test("a hidden tab holds its output until it is shown, then writes it in order", () => {
    const { terminal, written } = fakeTerminal();
    const hook = renderHook(({ visible }) => useHiddenTerminalWrites(terminal, visible), {
      initialProps: { visible: false },
    });
    const parsed: string[] = [];
    hook.result.current.write(bytes("one"), () => parsed.push("one"));
    hook.result.current.write(bytes("two"), () => parsed.push("two"));
    expect(written).toEqual([]);
    act(() => hook.rerender({ visible: true }));
    expect(written.join("")).toBe("onetwo");
    expect(parsed).toEqual(["one", "two"]);
    hook.result.current.write(bytes("three"), () => parsed.push("three"));
    expect(written.join("")).toBe("onetwothree");
    hook.unmount();
  });

  test("a replay write lands after everything the hidden tab received before it", () => {
    const { terminal, written } = fakeTerminal();
    const hook = renderHook(() => useHiddenTerminalWrites(terminal, false));
    hook.result.current.write(bytes("live"), () => undefined);
    hook.result.current.write(bytes("replay"), () => undefined, { immediate: true });
    expect(written.join("")).toBe("livereplay");
    hook.unmount();
  });

  test("unmount and flush hand every queued byte to xterm", () => {
    const { terminal, written } = fakeTerminal();
    const hook = renderHook(() => useHiddenTerminalWrites(terminal, false));
    hook.result.current.write(bytes("a"), () => undefined);
    hook.result.current.afterParsed(() => {});
    expect(written).toEqual(["a"]);
    hook.result.current.write(bytes("b"), () => undefined);
    hook.unmount();
    expect(written.join("")).toBe("ab");
  });

  test("the measurement switch writes a hidden tab straight through", () => {
    localStorage.setItem(BACKGROUND_WRITES_STORAGE_KEY, "off");
    const { terminal, written } = fakeTerminal();
    const hook = renderHook(() => useHiddenTerminalWrites(terminal, false));
    hook.result.current.write(bytes("direct"), () => undefined);
    expect(written).toEqual(["direct"]);
    hook.unmount();
  });
});
