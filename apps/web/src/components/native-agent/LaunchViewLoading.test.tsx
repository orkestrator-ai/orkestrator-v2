import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { NodeErrorBoundary } from "@/components/federation/NodeErrorBoundary";
import type { AgentNativeTab } from "@/components/native-agent";
import type { LaunchPromptPending } from "./LaunchPromptPending";
import * as realImports from "./launch-view-imports";

const importsSnapshot = { ...realImports };
const nativeImport = mock(async () => TestNativeTab);
const previewImport = mock(async () => TestPreview);

function TestNativeTab({ tabId }: ComponentProps<typeof AgentNativeTab>) {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount(count + 1)}>
      {tabId}: {count}
    </button>
  );
}

function TestPreview({ prompt }: ComponentProps<typeof LaunchPromptPending>) {
  return <p>{prompt}</p>;
}

mock.module("./launch-view-imports", () => ({
  importNativeAgentTab: nativeImport,
  importLaunchPromptPending: previewImport,
}));

const { LazyAgentNativeTab, loadAgentNativeTab } = await import("./LazyAgentNativeTab");
const { LazyLaunchPromptPending } = await import("./LazyLaunchPromptPending");

afterEach(cleanup);
afterAll(() => {
  mock.module("./launch-view-imports", () => importsSnapshot);
});

test("a cold native tab can retry its chunk and keeps the mounted component through updates", async () => {
  nativeImport.mockRejectedValueOnce(new Error("Chunk unavailable"));
  const tab = (tabId: string) => (
    <LazyLoadBoundary renderError={({ onRetry }) => <button onClick={onRetry}>Retry tab</button>}>
      <LazyAgentNativeTab
        tabId={tabId}
        data={{ environmentId: "fixture", isLocal: true }}
        isActive
        loadingFallback={<p>Loading tab</p>}
      />
    </LazyLoadBoundary>
  );
  const view = render(tab("First tab"));
  expect(screen.getByText("Loading tab")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Retry tab" }));
  fireEvent.click(await screen.findByRole("button", { name: "First tab: 0" }));
  await loadAgentNativeTab();
  view.rerender(tab("Updated tab"));
  expect(screen.getByRole("button", { name: "Updated tab: 1" })).toBeTruthy();
  expect(nativeImport).toHaveBeenCalledTimes(2);

  view.unmount();
  render(tab("Preloaded tab"));
  expect(screen.getByRole("button", { name: "Preloaded tab: 0" })).toBeTruthy();
  expect(screen.queryByText("Loading tab") === null).toBe(true);
});

test("a rejected preview leaves the workspace and its fallback usable, then the next launch retries", async () => {
  previewImport.mockRejectedValueOnce(new Error("Preview unavailable"));
  const launch = (environmentId: string) => (
    <NodeErrorBoundary nodeId="fixture" machine="Local">
      <button>Workspace action</button>
      <LazyLaunchPromptPending
        key={environmentId}
        environmentId={environmentId}
        platform="codex"
        prompt={`Opening prompt for ${environmentId}`}
        stage="starting-container"
        fallback={<button>Open initialization log</button>}
      />
    </NodeErrorBoundary>
  );
  const view = render(launch("first"));
  await act(async () => {});
  expect(previewImport).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("node-workspace-error") === null).toBe(true);
  expect(screen.getByRole("button", { name: "Workspace action" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open initialization log" })).toBeTruthy();

  view.rerender(launch("second"));
  expect(await screen.findByText("Opening prompt for second")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open initialization log" }) === null).toBe(true);
  expect(previewImport).toHaveBeenCalledTimes(2);
});
