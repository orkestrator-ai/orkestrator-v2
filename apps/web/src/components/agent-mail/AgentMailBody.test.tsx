import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MARKDOWN_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { AgentMailBody } from "./AgentMailConversationView";

afterEach(cleanup);

describe("AgentMailBody", () => {
  // Must run first: once the Markdown chunk has loaded, nothing suspends again.
  test("shows the plain body while the Markdown renderer loads, then renders Markdown", async () => {
    const { container } = render(<AgentMailBody body="ship **now**" />);
    expect(container.textContent).toBe("ship **now**");

    const bold = await screen.findByText("now");
    expect(bold.tagName).toBe("STRONG");
    expect(container.textContent).toBe("ship now");
  });

  test("keeps a body over the parser limit as plain text", () => {
    const body = "x".repeat(MARKDOWN_POLICY.blockParserCharacters + 1);
    const { container } = render(<AgentMailBody body={body} />);
    expect(container.querySelector("p")?.textContent).toBe(body);
  });
});
