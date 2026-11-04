import type { ComponentProps } from "react";
import * as realBoundary from "@/components/LazyLoadBoundary";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import * as realMarkdown from "./AgentMailMarkdown";
const snapshot = { ...realMarkdown };
mock.module("./AgentMailMarkdown", () => ({
  AgentMailMarkdown: () => {
    throw new Error("Markdown render failed");
  },
}));
const boundarySnapshot = { ...realBoundary };
const onFailure = mock();
mock.module("@/components/LazyLoadBoundary", () => ({
  ...boundarySnapshot,
  LazyLoadBoundary: (props: ComponentProps<typeof realBoundary.LazyLoadBoundary>) => (
    <boundarySnapshot.LazyLoadBoundary {...props} onError={onFailure} />
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
      <AgentMailBody body="read **this**" />
    </main>,
  );
  await screen.findByRole("button", { name: "Reload Markdown" });
  expect(screen.getByText("read **this**")).toBeTruthy();
  expect(screen.getByText("Mail shell")).toBeTruthy();
  expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "render" }));
});
