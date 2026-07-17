import { useEffect } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MAX_TABS,
  TerminalProvider,
  useOptionalTerminalContext,
  useTerminalContext,
  type CreatableTabType,
} from ".";

afterEach(cleanup);

describe("TerminalContext", () => {
  test("exports the tab limit and returns null from the optional hook outside a provider", () => {
    function OptionalConsumer() {
      return <span>{useOptionalTerminalContext() === null ? "no-context" : "context"}</span>;
    }

    render(<OptionalConsumer />);
    expect(screen.getByText("no-context")).toBeDefined();
    expect(MAX_TABS).toBe(9);
  });

  test("requires the provider for the strict hook", () => {
    function RequiredConsumer() {
      useTerminalContext();
      return null;
    }

    expect(() => render(<RequiredConsumer />)).toThrow(
      "useTerminalContext must be used within a TerminalProvider",
    );
  });

  test("stores and exposes a browser-aware create-tab callback", () => {
    const createTab = mock((_type: CreatableTabType, _initialUrl?: string) => undefined);

    function Registrar() {
      const context = useTerminalContext();
      useEffect(() => {
        context.setCreateTab((type, options) => createTab(type, options?.initialUrl));
        return () => context.setCreateTab(null);
      }, [context.setCreateTab]);
      return (
        <button
          type="button"
          disabled={!context.createTab}
          onClick={() => context.createTab?.("browser", { initialUrl: "http://localhost:3000/" })}
        >
          Create browser
        </button>
      );
    }

    render(
      <TerminalProvider>
        <Registrar />
      </TerminalProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create browser" }));
    expect(createTab).toHaveBeenCalledWith("browser", "http://localhost:3000/");
  });
});
