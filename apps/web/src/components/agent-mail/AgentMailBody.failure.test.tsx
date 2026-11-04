import { lazy } from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import * as realMarkdown from "./AgentMailMarkdown";
const snapshot = { ...realMarkdown };
mock.module("./AgentMailMarkdown", () => ({
  AgentMailMarkdown: lazy(async () => {
    throw new Error("Failed to fetch dynamically imported module");
  }),
}));
const { AgentMailBody } = await import("./AgentMailConversationView");
afterAll(() => mock.module("./AgentMailMarkdown", () => snapshot));
afterEach(cleanup);
test("rejected Markdown chunk keeps plain mail and the surrounding shell mounted", async () => {
  render(
    <main>
      <nav>Mail shell</nav>
      <AgentMailBody body="read **this**" />
    </main>,
  );
  await screen.findByRole("button", { name: "Reload Markdown" });
  expect(screen.getByText("read **this**")).toBeTruthy();
  expect(screen.getByText("Mail shell")).toBeTruthy();
});
