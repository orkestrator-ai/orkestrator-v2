import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { NativeMessage } from "./NativeMessage";

afterEach(cleanup);

function getClassTokens(element: Element | null | undefined): string[] {
  return element?.getAttribute("class")?.split(/\s+/).filter(Boolean) ?? [];
}

type UsageFields = Pick<NativeMessagePart, "tokenCountText" | "toolUseCount" | "agentUsageDisplay">;
const action: NativeMessagePart = {
  type: "tool-invocation",
  content: "Read source",
  toolName: "Read",
  toolState: "success",
};

function renderUsage(
  path: "subagent" | "task-group",
  fields: UsageFields = {},
  platform: "claude" | "cursor" = "claude",
  actions: NativeMessagePart[] = [action],
) {
  const part: NativeMessagePart =
    path === "subagent"
      ? {
          type: "subagent",
          content: "Reviewer",
          subagentName: "Reviewer",
          toolState: "success",
          subagentActions: actions,
          subagentActionCount: actions.filter((part) => part.type === "tool-invocation").length,
          toolArgs: { durationMs: 125_000 },
          ...fields,
        }
      : {
          type: "task-group",
          content: "Agent",
          childTools: actions,
          task: {
            type: "tool-invocation",
            content: "Agent",
            toolName: "Agent",
            toolState: "success",
            toolArgs: { description: "Reviewer", durationMs: 125_000 },
            ...fields,
          },
        };
  return renderInAppCommandScope(
    <NativeMessage
      platform={platform}
      message={{
        id: "usage-message",
        role: "assistant",
        content: "",
        createdAt: "2026-03-21T10:00:00.000Z",
        parts: [part],
      }}
    />,
  );
}

function assertStat(label: string, value: string, icon: "wrench" | "coins" | "activity") {
  const accessibleLabel = screen.getByText(label, { exact: true, selector: ".sr-only" });
  expect(accessibleLabel.classList.contains("sr-only")).toBe(true);
  const stat = accessibleLabel.parentElement!;
  expect(stat.getAttribute("title")).toBe(label);
  const visibleValue = stat.querySelector("span[aria-hidden='true']")!;
  expect(visibleValue.textContent).toBe(value);
  expect(visibleValue.classList.contains("sr-only")).toBe(false);
  const svg = stat.querySelector("svg")!;
  expect(svg.classList.contains(`lucide-${icon}`)).toBe(true);
  expect(svg.getAttribute("aria-hidden")).toBe("true");
  return stat;
}

for (const path of ["subagent", "task-group"] as const) {
  describe(`${path} compact usage`, () => {
    for (const [label, value] of [
      ["1 token", "1"],
      ["980 tokens", "980"],
      ["1.2m tokens", "1.2m"],
      ["auto", "auto"],
      ["980", "980"],
    ] as const) {
      for (const mode of ["full", "cursor", "token-only"] as const) {
        test(`${mode} shows ${label} as ${value} beside the token icon`, () => {
          renderUsage(
            path,
            {
              tokenCountText: label,
              toolUseCount: 8,
              ...(mode === "token-only" ? { agentUsageDisplay: "token-only" } : {}),
            },
            mode === "cursor" ? "cursor" : "claude",
          );
          const token = assertStat(label, value, "coins");
          if (mode === "full") {
            expect(assertStat("8 tool uses", "8", "wrench").parentElement).toBe(
              token.parentElement,
            );
          } else {
            expect(token.parentElement!.querySelectorAll("[title]")).toHaveLength(1);
            expect(screen.queryByText("8 tool uses") === null).toBe(true);
          }
          expect(screen.queryByText("1 update") === null).toBe(true);
          expect(screen.getByText("2m 5s")).toBeTruthy();
        });
      }
    }

    for (const count of [1, 2]) {
      test(`captured usage shows ${count} tools and updates with correct labels and icons`, () => {
        renderUsage(
          path,
          {},
          "claude",
          Array.from({ length: count }, () => action),
        );
        const tools = assertStat(
          `${count} ${count === 1 ? "tool" : "tools"}`,
          String(count),
          "wrench",
        );
        const updates = assertStat(
          `${count} ${count === 1 ? "update" : "updates"}`,
          String(count),
          "activity",
        );
        expect(tools.parentElement).toBe(updates.parentElement);
        expect(tools.parentElement!.querySelector(".lucide-coins") === null).toBe(true);
      });
    }

    test("external zero tools retains its compact value and singular tool-use label", () => {
      renderUsage(path, { toolUseCount: 0, tokenCountText: "1 token" });
      assertStat("0 tool uses", "0", "wrench");
      assertStat("1 token", "1", "coins");
      cleanup();
      renderUsage(path, { toolUseCount: 1, tokenCountText: "1 token" });
      assertStat("1 tool use", "1", "wrench");
    });

    test("Cursor with no tokens hides captured tools and updates but keeps runtime", () => {
      const { container } = renderUsage(path, {}, "cursor");
      expect(container.querySelector(".lucide-wrench") === null).toBe(true);
      expect(container.querySelector(".lucide-activity") === null).toBe(true);
      expect(container.querySelector(".lucide-coins") === null).toBe(true);
      expect(screen.getByText("2m 5s")).toBeTruthy();
    });

    test("empty usage leaves only the runtime", () => {
      const { container } = renderUsage(path, {}, "claude", []);
      expect(container.querySelector("button [title]") === null).toBe(true);
      expect(screen.getByText("2m 5s")).toBeTruthy();
    });

    test("centres a lone runtime on a one-line header", () => {
      renderUsage(path, {}, "cursor", []);
      expect(getClassTokens(screen.getByText("2m 5s").parentElement)).toContain("self-center");
    });

    test("bottom-aligns the runtime when tokens appear on a one-line header", () => {
      renderUsage(path, { tokenCountText: "980 tokens" }, "cursor", []);
      const token = assertStat("980 tokens", "980", "coins");
      const rail = screen.getByText("2m 5s").parentElement;
      expect(rail?.contains(token)).toBe(true);
      expect(getClassTokens(rail?.parentElement)).toContain("items-center");
      expect(getClassTokens(rail)).toContain("self-end");
      expect(getClassTokens(rail)).not.toContain("self-center");
    });

    test("bottom-aligns a lone runtime when a preview appears", () => {
      const preview = "Checked the test results.";
      renderUsage(path, {}, "cursor", [{ type: "text", content: preview }]);
      const rail = screen.getByText("2m 5s").parentElement;
      expect(rail?.parentElement?.contains(screen.getByText(preview))).toBe(true);
      expect(rail?.children).toHaveLength(1);
      expect(getClassTokens(rail)).toContain("self-end");
      expect(getClassTokens(rail)).not.toContain("self-center");
    });

    test("bottom-aligns the runtime when both usage and a preview appear", () => {
      renderUsage(path, { toolUseCount: 8 });
      const rail = screen.getByText("2m 5s").parentElement;
      expect(getClassTokens(rail)).toContain("self-end");
      expect(getClassTokens(rail)).not.toContain("self-center");
    });

    test("runtime sits behind a stopwatch in the same size and colour as the counts", () => {
      renderUsage(path, { toolUseCount: 8, tokenCountText: "980 tokens" });
      const tools = assertStat("8 tool uses", "8", "wrench");
      const runtime = screen.getByText("2m 5s");
      const timer = runtime.querySelector("svg.lucide-timer");
      expect(timer).toBeTruthy();
      expect(timer!.getAttribute("aria-hidden")).toBe("true");
      for (const cls of ["text-[11px]", "text-muted-foreground"]) {
        expect(runtime.classList.contains(cls)).toBe(true);
        expect(tools.parentElement!.classList.contains(cls)).toBe(true);
      }
    });
  });
}

describe("subagent runtime without spawn args", () => {
  // A Codex child has no spawn-tool args; the bridge stamps its run instead.
  function renderCodexChild(fields: Partial<Extract<NativeMessagePart, { type: "subagent" }>>) {
    return renderInAppCommandScope(
      <NativeMessage
        platform="codex"
        message={{
          id: "codex-child",
          role: "assistant",
          content: "",
          createdAt: "2026-03-21T10:00:00.000Z",
          parts: [
            {
              type: "subagent",
              content: "Zeno",
              subagentName: "Zeno",
              subagentActions: [action],
              subagentActionCount: 1,
              ...fields,
            },
          ],
        }}
      />,
    );
  }

  test("ticks a running child from the run's start", () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    renderCodexChild({ toolState: "pending", createdAt: startedAt });
    expect(screen.getByText(/^1m [5-9]s$/)).toBeTruthy();
  });

  test("shows a settled child's measured duration", () => {
    renderCodexChild({
      toolState: "success",
      createdAt: "2026-03-21T10:00:00.000Z",
      toolDurationMs: 125_000,
    });
    expect(screen.getByText("2m 5s")).toBeTruthy();
  });
});
