import { describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import * as TerminalContextBarrel from "../../../apps/web/src/contexts";
import {
  MAX_TABS,
  TerminalProvider,
  useOptionalTerminalContext,
  useTerminalContext,
  type CreateTabOptions,
  type TerminalTabType,
} from "../../../apps/web/src/contexts/TerminalContext";
import type { AgentLaunchModeOverride } from "../../../apps/web/src/contexts";

describe("TerminalContext", () => {
  test("useOptionalTerminalContext returns null outside a provider", () => {
    const { result } = renderHook(() => useOptionalTerminalContext());

    expect(result.current).toBeNull();
  });

  test("useTerminalContext throws outside a provider", () => {
    expect(() => renderHook(() => useTerminalContext())).toThrow(
      "useTerminalContext must be used within a TerminalProvider",
    );
  });

  test("TerminalProvider supplies the terminal context value", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TerminalProvider>{children}</TerminalProvider>
    );

    const { result } = renderHook(() => useOptionalTerminalContext(), { wrapper });

    expect(result.current).not.toBeNull();
    expect(result.current?.createTab).toBeNull();
    expect(result.current?.tabCount).toBe(0);
    expect(result.current?.openFilePaths).toEqual([]);
  });

  test("TerminalProvider stores callable context setters without invoking them as state updaters", async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TerminalProvider>{children}</TerminalProvider>
    );

    const terminalWrite = async (_data: string) => {};
    const createTab = (_type: TerminalTabType, _options?: CreateTabOptions) => {};
    const selectTab = (_index: number) => {};
    const closeActiveTab = () => {};
    const createFileTab = (_filePath: string) => {};

    const { result } = renderHook(() => useTerminalContext(), { wrapper });

    act(() => {
      result.current.setTerminalWrite(terminalWrite);
      result.current.setCreateTab(createTab);
      result.current.setSelectTab(selectTab);
      result.current.setCloseActiveTab(closeActiveTab);
      result.current.setCreateFileTab(createFileTab);
      result.current.setTabCount(3);
      result.current.setOpenFilePaths(["src/main.ts"]);
    });

    expect(result.current.terminalWrite).toBe(terminalWrite);
    expect(result.current.createTab).toBe(createTab);
    expect(result.current.selectTab).toBe(selectTab);
    expect(result.current.closeActiveTab).toBe(closeActiveTab);
    expect(result.current.createFileTab).toBe(createFileTab);
    expect(result.current.tabCount).toBe(3);
    expect(result.current.openFilePaths).toEqual(["src/main.ts"]);

    await expect(result.current.terminalWrite?.("hello")).resolves.toBeUndefined();
    result.current.createTab?.("codex", { agentLaunchMode: "native" });
    result.current.selectTab?.(1);
    result.current.closeActiveTab?.();
    result.current.createFileTab?.("src/main.ts");
  });

  test("contexts barrel exports the runtime context API and launch mode type", () => {
    const launchMode: AgentLaunchModeOverride = "tmux";

    expect(TerminalContextBarrel.TerminalProvider).toBe(TerminalProvider);
    expect(TerminalContextBarrel.useTerminalContext).toBe(useTerminalContext);
    expect(TerminalContextBarrel.MAX_TABS).toBe(MAX_TABS);
    expect(launchMode).toBe("tmux");
  });
});
