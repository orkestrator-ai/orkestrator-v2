/**
 * One presentation for every provider's failed turn: the same reason reads
 * the same whichever agent hit it, and only actions the host can perform are
 * offered, on the latest failure only.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { ProviderFailureAlert } from "./ProviderFailureAlert";
import {
  ProviderFailureActionsContext,
  type ProviderFailureActions,
} from "./provider-failure-actions";

afterEach(cleanup);

function withActions(actions: ProviderFailureActions, node: ReactNode) {
  return (
    <ProviderFailureActionsContext.Provider value={actions}>
      {node}
    </ProviderFailureActionsContext.Provider>
  );
}

function reasonOf(container: HTMLElement): string | null | undefined {
  return container.querySelector("[data-provider-failure]")?.getAttribute("data-provider-failure");
}

describe("ProviderFailureAlert", () => {
  test("the same problem reads the same across providers", () => {
    const cases: Array<[AgentPlatform, string]> = [
      ["claude", "API Error: 429 rate_limit_error"],
      ["codex", "rateLimitExceeded"],
      ["opencode", "Model request failed (HTTP 429): Too Many Requests"],
    ];
    const titles = cases.map(([platform, text]) => {
      const { container } = render(<ProviderFailureAlert text={text} platform={platform} />);
      const title = container.querySelector("[data-provider-failure] .font-medium")?.textContent;
      expect(reasonOf(container)).toBe("rate-limit");
      cleanup();
      return title;
    });
    expect(new Set(titles)).toEqual(new Set(["Rate limited"]));
  });

  test("a structured reason wins over unhelpful text", () => {
    const { container } = render(
      <ProviderFailureAlert
        text="Claude ended the turn on an API error."
        failure={{ reason: "billing" }}
        platform="claude"
      />,
    );
    expect(reasonOf(container)).toBe("billing");
    expect(screen.getByText("Billing problem")).toBeTruthy();
  });

  test("the provider's own words stay behind Details", () => {
    render(<ProviderFailureAlert text="raw provider message" platform="codex" />);
    const details = screen.getByText("raw provider message");
    expect(details.hidden).toBe(true);
    const toggle = screen.getByRole("button", { name: "Details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(details.hidden).toBe(false);
  });

  test("a usage limit shows a verified reset time and offers no retry", () => {
    const retry = mock(() => undefined);
    const now = Date.parse("2026-11-19T10:00:00.000Z");
    render(
      withActions(
        { actionableFailureId: "f1", retry },
        <ProviderFailureAlert
          text="You've hit your usage limit."
          failure={{ reason: "usage-limit", resetsAt: "2026-11-19T12:30:00.000Z" }}
          failureId="f1"
          occurredAt="2026-11-19T09:00:00.000Z"
          now={now}
        />,
      ),
    );
    expect(screen.getByText("Usage limit reached")).toBeTruthy();
    expect(screen.getByText(/The limit resets at/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
  });

  test("a usage limit with only the provider's words quotes them as its words", () => {
    render(<ProviderFailureAlert text="You've hit your limit · resets 3pm" platform="claude" />);
    expect(screen.getByText("Claude Code says it resets 3pm.")).toBeTruthy();
  });

  test("Retry acts on the latest failure only, with that failure's identity", () => {
    const retry = mock((_id: string, _at: string) => undefined);
    render(
      withActions(
        { actionableFailureId: "latest", retry },
        <>
          <ProviderFailureAlert text="fetch failed" failureId="older" occurredAt="t0" />
          <ProviderFailureAlert text="fetch failed" failureId="latest" occurredAt="t1" />
        </>,
      ),
    );
    const buttons = screen.getAllByRole("button", { name: "Retry" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(retry).toHaveBeenCalledWith("latest", "t1");
  });

  test("Retry is disabled, with its reason, when the host cannot send now", () => {
    render(
      withActions(
        {
          actionableFailureId: "f1",
          retry: () => undefined,
          retryUnavailableReason: "Send or clear the message in the composer first.",
        },
        <ProviderFailureAlert text="Overloaded" failureId="f1" occurredAt="t" />,
      ),
    );
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Send or clear the message in the composer first.")).toBeTruthy();
  });

  test("an unavailable model offers Change model only when the host can change it", () => {
    const changeModel = mock(() => undefined);
    const element = (
      <ProviderFailureAlert text="Unknown model: foo/bar" failureId="f1" occurredAt="t" />
    );
    render(withActions({ actionableFailureId: "f1", retry: () => undefined }, element));
    expect(screen.queryByRole("button", { name: "Change model" }) === null).toBe(true);
    // Retry is not this reason's remedy, whatever the host supports.
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
    cleanup();

    render(withActions({ actionableFailureId: "f1", changeModel }, element));
    fireEvent.click(screen.getByRole("button", { name: "Change model" }));
    expect(changeModel).toHaveBeenCalledTimes(1);
  });

  test("sign-in shows the platform's own control only for an authentication failure", () => {
    const signIn = <button type="button">Sign in to provider</button>;
    render(
      <ProviderFailureAlert text="Model request failed (HTTP 401): bad key" signIn={signIn} />,
    );
    expect(screen.getByRole("button", { name: "Sign in to provider" })).toBeTruthy();
    cleanup();
    render(<ProviderFailureAlert text="fetch failed" signIn={signIn} />);
    expect(screen.queryByRole("button", { name: "Sign in to provider" }) === null).toBe(true);
  });

  test("without a host, a failure is explained with no actions", () => {
    render(<ProviderFailureAlert text="fetch failed" failureId="f1" occurredAt="t" />);
    expect(screen.getByText("Provider unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
  });
});
