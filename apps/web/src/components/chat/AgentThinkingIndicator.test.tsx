import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { AgentThinkingIndicator } from "./AgentThinkingIndicator";

describe("AgentThinkingIndicator", () => {
  test("renders the agent thinking copy as an accessible shimmer status", () => {
    render(<AgentThinkingIndicator agentName="Codex" />);

    const indicator = screen.getByRole("status");

    expect(indicator.textContent).toBe("Codex is thinking...");
    expect(indicator.classList.contains("agent-thinking-shimmer")).toBe(true);
    expect(indicator.querySelector("svg")).toBeNull();
  });
});
