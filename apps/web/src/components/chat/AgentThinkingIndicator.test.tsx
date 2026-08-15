import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentThinkingIndicator } from "./AgentThinkingIndicator";

describe("AgentThinkingIndicator", () => {
  afterEach(cleanup);

  test("renders the agent thinking copy as an accessible shimmer status", () => {
    render(<AgentThinkingIndicator agentName="Codex" />);

    const indicator = screen.getByRole("status");

    expect(indicator.textContent).toBe("Codex is thinking...");
    expect(indicator.classList.contains("agent-thinking-shimmer")).toBe(true);
    expect(indicator.querySelector("svg") === null).toBe(true);
  });

  test("merges a caller-provided class name with the shared shimmer classes", () => {
    const { container } = render(
      <AgentThinkingIndicator
        agentName="Claude"
        className="justify-self-start text-sm"
      />,
    );

    const indicator = container.querySelector('[role="status"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.className).toContain("agent-thinking-shimmer");
    expect(indicator?.className).toContain("justify-self-start");
    expect(indicator?.className).toContain("text-sm");
  });
});
