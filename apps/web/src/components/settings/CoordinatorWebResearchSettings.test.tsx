import { afterEach, describe, expect, mock, test } from "bun:test";
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MAX_COORDINATOR_RESEARCH_MCP_SERVERS,
  type CoordinatorResearchMcpServer,
  type CoordinatorWebResearch,
} from "@orkestrator/protocol/coordinator-web-research";
import { CoordinatorWebResearchSettings } from "./CoordinatorWebResearchSettings";

const CONTEXT7 = { name: "context7", url: "https://mcp.context7.com/mcp" };

let latest: { mode: CoordinatorWebResearch; servers: CoordinatorResearchMcpServer[] };

function Harness({
  initialMode = "search-and-mcp" as CoordinatorWebResearch,
  initialServers = [CONTEXT7] as CoordinatorResearchMcpServer[],
}) {
  const [mode, setMode] = useState<CoordinatorWebResearch>(initialMode);
  const [servers, setServers] = useState<CoordinatorResearchMcpServer[]>(initialServers);
  useEffect(() => {
    latest = { mode, servers };
  });
  return (
    <CoordinatorWebResearchSettings
      mode={mode}
      setMode={setMode}
      servers={servers}
      setServers={setServers}
    />
  );
}

afterEach(cleanup);

describe("CoordinatorWebResearchSettings", () => {
  test("says page fetches stay off and switches modes", () => {
    render(<Harness />);
    expect(screen.getByText(/cannot open arbitrary web pages in any mode/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Off/ }));
    expect(latest.mode).toBe("off");
    // The server list belongs to the mode that loads it.
    expect(screen.queryByRole("list", { name: "Research servers" }) === null).toBe(true);
  });

  test("refuses a local server and adds a remote one", () => {
    render(<Harness />);
    const name = screen.getByRole("textbox", { name: "Research server name" });
    const url = screen.getByRole("textbox", { name: "Research server URL" });
    const add = screen.getByRole("button", { name: /Add/ });

    fireEvent.change(name, { target: { value: "local" } });
    fireEvent.change(url, { target: { value: "http://127.0.0.1:9000/mcp" } });
    expect(screen.getByRole("alert").textContent).toContain("https://");
    expect((add as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(name, { target: { value: "context7" } });
    fireEvent.change(url, { target: { value: "https://example.com/mcp" } });
    expect(screen.getByRole("alert").textContent).toContain("already listed");

    fireEvent.change(name, { target: { value: "docs" } });
    fireEvent.change(url, { target: { value: "https://docs.example/mcp" } });
    expect((add as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(add);
    expect(latest.servers).toEqual([CONTEXT7, { name: "docs", url: "https://docs.example/mcp" }]);

    fireEvent.click(screen.getByRole("button", { name: "Remove context7" }));
    expect(latest.servers).toEqual([{ name: "docs", url: "https://docs.example/mcp" }]);
  });

  test("Enter adds the server, clears the draft and goes no further", () => {
    const parentKeyDown = mock(() => undefined);
    const parentSubmit = mock(() => undefined);
    render(
      <div onKeyDown={parentKeyDown} onSubmit={parentSubmit}>
        <Harness />
      </div>,
    );
    const name = screen.getByRole("textbox", { name: "Research server name" });
    const url = screen.getByRole("textbox", { name: "Research server URL" });
    fireEvent.change(name, { target: { value: "docs" } });
    fireEvent.change(url, { target: { value: "https://docs.example/mcp" } });

    fireEvent.keyDown(url, { key: "Enter" });
    expect(parentKeyDown).not.toHaveBeenCalled();
    fireEvent.submit(url.closest("form")!);

    expect(latest.servers).toEqual([CONTEXT7, { name: "docs", url: "https://docs.example/mcp" }]);
    expect((name as HTMLInputElement).value).toBe("");
    expect((url as HTMLInputElement).value).toBe("");
    expect(parentSubmit).not.toHaveBeenCalled();
  });

  test("Enter adds nothing while the draft has a problem", () => {
    render(<Harness />);
    const url = screen.getByRole("textbox", { name: "Research server URL" });
    fireEvent.change(screen.getByRole("textbox", { name: "Research server name" }), {
      target: { value: "local" },
    });
    fireEvent.change(url, { target: { value: "http://127.0.0.1:9000/mcp" } });
    fireEvent.submit(url.closest("form")!);
    expect(latest.servers).toEqual([CONTEXT7]);
  });

  test("at the limit it says why Add is disabled, and Enter adds nothing", () => {
    const full = Array.from({ length: MAX_COORDINATOR_RESEARCH_MCP_SERVERS }, (_, index) => ({
      name: `server${index}`,
      url: `https://server${index}.example/mcp`,
    }));
    render(<Harness initialServers={full} />);
    expect(screen.getByRole("alert").textContent).toContain(
      `at most ${MAX_COORDINATOR_RESEARCH_MCP_SERVERS} research servers`,
    );
    const add = screen.getByRole("button", { name: /Add/ }) as HTMLButtonElement;
    const url = screen.getByRole("textbox", { name: "Research server URL" });
    fireEvent.change(screen.getByRole("textbox", { name: "Research server name" }), {
      target: { value: "extra" },
    });
    fireEvent.change(url, { target: { value: "https://extra.example/mcp" } });
    expect(add.disabled).toBe(true);
    fireEvent.submit(url.closest("form")!);
    expect(latest.servers).toHaveLength(MAX_COORDINATOR_RESEARCH_MCP_SERVERS);

    // Removing one lifts it.
    fireEvent.click(screen.getByRole("button", { name: "Remove server0" }));
    expect(screen.queryByRole("alert") === null).toBe(true);
    expect(add.disabled).toBe(false);
  });
});
