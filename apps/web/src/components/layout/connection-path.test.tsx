import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectionPathPanel } from "./AgentInfoButton.panels";
import { workspaceTarget } from "@/lib/portal/portal-transport";

const happyDOM = (
  window as unknown as {
    happyDOM: { setURL(url: string): void };
  }
).happyDOM;
const originalHref = window.location.href;

afterEach(() => {
  cleanup();
  happyDOM.setURL(originalHref);
});

describe("DP-04 the info panel shows the connection path", () => {
  test("a direct leaf workspace names the node and its route", () => {
    render(
      <ConnectionPathPanel
        path={{ nodeName: "Build box", path: "direct", routeKind: "https" }}
        boundMachineName={null}
      />,
    );
    expect(screen.getByTestId("connection-path").textContent).toContain(
      "Direct to Build box over HTTPS.",
    );
  });

  test("a relayed workspace names the command node and how it reaches the leaf", () => {
    render(
      <ConnectionPathPanel
        path={{ nodeName: "Build box", path: "relay", routeKind: "ssh", via: "Office desktop" }}
        boundMachineName={null}
      />,
    );
    expect(screen.getByTestId("connection-path").textContent).toContain(
      "Relayed through Office desktop, which reaches Build box over SSH.",
    );
  });

  test("an environment on the connected node says so", () => {
    render(<ConnectionPathPanel path={null} boundMachineName="Office desktop" />);
    expect(screen.getByTestId("connection-path").getAttribute("data-path")).toBe("this-node");
  });

  test("a window on a leaf reads its non-secret path from its workspace target", () => {
    expect(workspaceTarget()).toBeNull();
    window.orkestratorWorkspaceTarget = {
      nodeId: "bk_build",
      nodeName: "Build box",
      path: "relay",
      routeKind: "ssh",
      via: "Desk",
    };
    try {
      render(<ConnectionPathPanel path={workspaceTarget()} boundMachineName="Desk" />);
      expect(screen.getByTestId("connection-path").textContent).toContain(
        "Relayed through Desk, which reaches Build box over SSH.",
      );
    } finally {
      delete window.orkestratorWorkspaceTarget;
    }
  });
});
