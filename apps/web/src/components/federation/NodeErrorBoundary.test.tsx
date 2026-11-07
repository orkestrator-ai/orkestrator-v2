import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NodeErrorBoundary } from "./NodeErrorBoundary";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";

afterEach(cleanup);

let broken = new Set<string>();

function NodeWorkspace({ nodeId }: { nodeId: string }) {
  if (broken.has(nodeId)) throw new Error("render failure");
  return <p>{nodeId} workspace</p>;
}

function Window({ onRetry }: { onRetry?: (nodeId: string) => void }) {
  return (
    <main>
      <nav>window sidebar</nav>
      {["bk_a", "bk_b"].map((nodeId) => (
        <section key={nodeId} aria-label={nodeId}>
          <NodeErrorBoundary
            nodeId={nodeId}
            machine={nodeId.toUpperCase()}
            onRetry={() => onRetry?.(nodeId)}
          >
            <NodeWorkspace nodeId={nodeId} />
          </NodeErrorBoundary>
        </section>
      ))}
    </main>
  );
}

test("a crash in one node's workspace shows that node's error; the window and other nodes keep rendering", () => {
  // React reports the caught error; keep the test output quiet.
  const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
  broken = new Set(["bk_a"]);
  render(<Window />);
  expect(screen.getByText("window sidebar")).toBeTruthy();
  expect(screen.getByText("bk_b workspace")).toBeTruthy();
  const alert = screen.getByRole("alert");
  expect(alert.getAttribute("data-node")).toBe("bk_a");
  expect(alert.textContent).toContain("BK_A's workspace stopped working.");
  expect(alert.textContent).toContain("Its work keeps running");
  expectDomAbsent(screen.queryByText("bk_a workspace"));
  consoleError.mockRestore();
});

test("Try again calls the owner's retry and remounts the node's workspace", () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
  broken = new Set(["bk_a"]);
  const onRetry = mock((nodeId: string) => {
    broken.delete(nodeId);
  });
  render(<Window onRetry={onRetry} />);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(onRetry).toHaveBeenCalledWith("bk_a");
  expect(screen.getByText("bk_a workspace")).toBeTruthy();
  expectDomAbsent(screen.queryByRole("alert"));
  consoleError.mockRestore();
});

test("a retry that fails again shows the error again, still only for that node", () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
  broken = new Set(["bk_b"]);
  render(<Window onRetry={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("alert").getAttribute("data-node")).toBe("bk_b");
  expect(screen.getByText("bk_a workspace")).toBeTruthy();
  consoleError.mockRestore();
});
