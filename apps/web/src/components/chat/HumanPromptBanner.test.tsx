import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";
import { HumanPromptBanner } from "./HumanPromptBanner";

const waiting: HumanPromptEntry = {
  id: "tool-1",
  environmentId: "env-1",
  tabId: "tab-1",
  source: "agent-tool",
  since: "2026-11-05T10:00:00.000Z",
  prompt: { kind: "secret", wantsEnter: false, text: "Password:", key: "secret" },
};

describe("HumanPromptBanner", () => {
  afterEach(cleanup);

  test("a caller that gives no onOpen sees no Open, as in an ordinary tab", () => {
    render(<HumanPromptBanner prompts={[waiting]} />);
    expect(screen.getByText(/answer it in the worker's tab/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  test("Open hands the entry to the caller", () => {
    const onOpen = mock((_entry: HumanPromptEntry) => undefined);
    render(<HumanPromptBanner prompts={[waiting]} label={() => "api-fix"} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Open api-fix" }));
    expect(onOpen).toHaveBeenCalledWith(waiting);
  });

  test("an entry with nowhere to go has no Open, beside one that does", () => {
    const other = { ...waiting, id: "tool-2", environmentId: "env-2" };
    render(
      <HumanPromptBanner
        prompts={[waiting, other]}
        label={(entry) => entry.environmentId}
        onOpen={() => undefined}
        canOpen={(entry) => entry.environmentId === "env-2"}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open env-1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open env-2" })).toBeTruthy();
  });

  test("the same prompt id on two nodes draws two rows", () => {
    render(
      <HumanPromptBanner
        prompts={[
          { ...waiting, nodeId: "bk_a" },
          { ...waiting, nodeId: "bk_b" },
        ]}
      />,
    );
    expect(screen.getAllByText("Waiting for a password or passphrase")).toHaveLength(2);
  });

  test("a sign-in shows its link and code", () => {
    render(
      <HumanPromptBanner
        prompts={[
          {
            ...waiting,
            prompt: {
              kind: "device-code",
              url: "https://github.com/login/device",
              code: "1A2B-3C4D",
              wantsEnter: false,
              text: "Enter the code",
              key: "device",
            },
          },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Open link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1A2B-3C4D" })).toBeTruthy();
  });
});
