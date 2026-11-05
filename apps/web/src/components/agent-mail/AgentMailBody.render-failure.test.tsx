import type { ComponentProps } from "react";
import * as realBoundary from "@/components/LazyLoadBoundary";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as realMarkdown from "./AgentMailMarkdown";
const snapshot = { ...realMarkdown };
let failRendering = true;
mock.module("./AgentMailMarkdown", () => ({
  AgentMailMarkdown: () => {
    if (failRendering) throw new Error("Markdown render failed");
    return <p>Formatted mail</p>;
  },
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
afterAll(() => mock.module("./AgentMailMarkdown", () => snapshot));
afterAll(() => mock.module("@/components/LazyLoadBoundary", () => boundarySnapshot));
afterEach(cleanup);
test("Markdown render error keeps plain mail and the surrounding shell mounted", async () => {
  render(
    <main>
      <nav>Mail shell</nav>
      <input aria-label="Unsent draft" defaultValue="Keep my draft" />
      <AgentMailBody body="read **this**" />
    </main>,
  );
  const retry = await screen.findByRole("button", { name: "Retry formatting" });
  expect(screen.queryByRole("button", { name: "Reload application" }) === null).toBe(true);
  expect(screen.getByText("read **this**")).toBeTruthy();
  expect(screen.getByText("Mail shell")).toBeTruthy();
  expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "render" }));
  failRendering = false;
  fireEvent.click(retry);
  await screen.findByText("Formatted mail");
  expect(onReload).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox", { name: "Unsent draft" }) as HTMLInputElement).value).toBe(
    "Keep my draft",
  );
  expect(screen.getByText("Mail shell")).toBeTruthy();
});
