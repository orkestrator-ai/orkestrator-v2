import { afterEach, describe, expect, test } from "bun:test";
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  CoordinatorResearchMcpServer,
  CoordinatorWebResearch,
} from "@orkestrator/protocol/coordinator-web-research";
import { CoordinatorWebResearchSettings } from "./CoordinatorWebResearchSettings";

const CONTEXT7 = { name: "context7", url: "https://mcp.context7.com/mcp" };

let latest: { mode: CoordinatorWebResearch; servers: CoordinatorResearchMcpServer[] };

function Harness({ initialMode = "search-and-mcp" as CoordinatorWebResearch }) {
  const [mode, setMode] = useState<CoordinatorWebResearch>(initialMode);
  const [servers, setServers] = useState<CoordinatorResearchMcpServer[]>([CONTEXT7]);
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
});
