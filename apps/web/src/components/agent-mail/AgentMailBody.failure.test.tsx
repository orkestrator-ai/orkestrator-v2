import type { ComponentProps } from "react";
import * as realBoundary from "@/components/LazyLoadBoundary";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as realLoaders from "@/lib/lazy-view-loaders";
const snapshot = { ...realLoaders };
const rejectImport = mock(async () => {
  throw new Error("Failed to fetch dynamically imported module");
});
mock.module("@/lib/lazy-view-loaders", () => ({
  ...snapshot,
  loadAgentMailMarkdown: rejectImport,
}));
const boundarySnapshot = { ...realBoundary };
const onFailure = mock();
const onReload = mock();
mock.module("@/components/LazyLoadBoundary", () => ({
  ...boundarySnapshot,
  LazyLoadBoundary: (props: ComponentProps<typeof realBoundary.LazyLoadBoundary>) => (
    <boundarySnapshot.LazyLoadBoundary {...props} onError={onFailure} onReload={onReload} />
  ),
}));
const { AgentMailBody } = await import("./AgentMailConversationView");
afterAll(() => mock.module("@/lib/lazy-view-loaders", () => snapshot));
afterAll(() => mock.module("@/components/LazyLoadBoundary", () => boundarySnapshot));
afterEach(cleanup);
test("rejected Markdown chunk keeps plain mail and the surrounding shell mounted", async () => {
  render(
    <main>
      <nav>Mail shell</nav>
      <AgentMailBody body="read **this**" />
    </main>,
  );
  const reload = await screen.findByRole("button", { name: "Reload application" });
  expect(screen.queryByRole("button", { name: "Retry formatting" }) === null).toBe(true);
  fireEvent.click(reload);
  expect(onReload).toHaveBeenCalledTimes(1);
  expect(rejectImport).toHaveBeenCalledTimes(1);
  expect(screen.getByText("read **this**")).toBeTruthy();
  expect(screen.getByText("Mail shell")).toBeTruthy();
  expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "module-load" }));
});
