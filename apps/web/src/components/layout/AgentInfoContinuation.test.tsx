import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { ContinuationExplanation } from "./AgentInfoContinuation";
import { UsagePanel } from "./AgentInfoButton.panels";

const RESPONSE_AT = "2026-11-19T10:00:00.000Z";
const RESPONSE_MS = Date.parse(RESPONSE_AT);
const MINUTE = 60_000;
const turns = [
  {
    turnId: "t1",
    at: RESPONSE_AT,
    cacheAccessNotBefore: new Date(RESPONSE_MS - MINUTE).toISOString(),
    modelId: "claude-sonnet",
    cacheReadTokens: 90_000,
    cacheWriteTokens: 3_000,
  },
];

afterEach(cleanup);

function region() {
  return within(screen.getByRole("region", { name: "Next continuation" }));
}

test.each([
  { cacheReadTokens: 5, cacheWriteTokens: 0 },
  { cacheReadTokens: 0, cacheWriteTokens: 5 },
])("reports recent small or write-only cache activity with unknown share (%j)", (activity) => {
  render(
    <ContinuationExplanation
      provider="claude"
      turns={[{ ...turns[0]!, ...activity }]}
      contextTokens={150_000}
      running={false}
      canCompact
      nowMs={RESPONSE_MS + 3 * MINUTE}
    />,
  );
  const section = region();
  expect(section.getByText("Likely warm")).toBeTruthy();
  expect(section.getByText("Large context")).toBeTruthy();
  expect(section.getByText(/Last response 3m ago. The turn reported cache activity/)).toBeTruthy();
  expect(section.getByText("The cached share of the next request is unknown.")).toBeTruthy();
  expect(section.getByText("Last reported context: about 150k tokens.")).toBeTruthy();
  expect(section.getByText(/Compacting first can reduce retained context/)).toBeTruthy();
  expect(section.getByText(/totals are history/)).toBeTruthy();
});

test("keeps the middle of Claude's lifetimes unknown and omits compaction when unsupported", () => {
  render(
    <ContinuationExplanation
      provider="claude"
      turns={turns}
      contextTokens={20_000}
      running={false}
      canCompact={false}
      nowMs={RESPONSE_MS + 20 * MINUTE}
    />,
  );
  const section = region();
  expect(section.getByText("Unknown")).toBeTruthy();
  expect(
    section.getByText(
      /past the shortest cache lifetime \(5 minutes\); still warm only if the session used longer caching \(up to 1 hour\)/,
    ),
  ).toBeTruthy();
  expect(section.getByText(/Last reported context/)).toBeTruthy();
  expect(section.queryByText(/Compacting/) === null).toBe(true);
  expect(section.queryByText("Large context") === null).toBe(true);
});

test("says when the cache has likely expired", () => {
  render(
    <ContinuationExplanation
      provider="claude"
      turns={turns}
      contextTokens={150_000}
      running={false}
      canCompact
      nowMs={RESPONSE_MS + 3 * 60 * MINUTE}
    />,
  );
  const section = region();
  expect(section.getByText("Likely expired")).toBeTruthy();
  expect(
    section.getByText("Last response 3h ago, past the longest cache lifetime (1 hour)."),
  ).toBeTruthy();
});

test("a multi-provider harness names why the cache is unknown", () => {
  render(
    <ContinuationExplanation
      provider="opencode"
      turns={turns}
      contextTokens={20_000}
      running={false}
      canCompact
      nowMs={RESPONSE_MS + 2 * MINUTE}
    />,
  );
  const section = region();
  expect(section.getByText("Unknown")).toBeTruthy();
  expect(
    section.getByText(
      "Last response 2m ago. Cache lifetime depends on the model provider and is not reported.",
    ),
  ).toBeTruthy();
  expect(section.getByText(/Last reported context/)).toBeTruthy();
  expect(section.getByText(/Cache reuse depends on the provider/)).toBeTruthy();
});

test("the usage panel shows the explanation only when asked, from the newest turn", () => {
  const usage = {
    usedTokens: 40_000,
    totalTokens: 200_000,
    percentUsed: 20,
    cacheReadTokens: 5_000_000,
    turns,
  };
  const { rerender } = render(<UsagePanel usage={usage} modelId="claude-sonnet" />);
  expect(screen.queryByRole("region", { name: "Next continuation" }) === null).toBe(true);

  rerender(
    <UsagePanel
      usage={usage}
      modelId="claude-sonnet"
      continuation={{
        provider: "claude",
        running: true,
        canCompact: false,
        nowMs: RESPONSE_MS + MINUTE,
      }}
    />,
  );
  expect(region().getByText(/A response is running/)).toBeTruthy();
  expect(region().getByText(/about 40k tokens/)).toBeTruthy();
});

test("an occupancy-unknown snapshot does not claim a context size", () => {
  render(
    <UsagePanel
      usage={{ usedTokens: 0, occupancyUnknown: true, costUsd: 1.2, turns }}
      modelId="claude-sonnet"
      continuation={{
        provider: "claude",
        running: false,
        canCompact: true,
        nowMs: RESPONSE_MS + MINUTE,
      }}
    />,
  );
  expect(region().getByText("Likely warm")).toBeTruthy();
  expect(region().queryByText(/Last reported context/) === null).toBe(true);
});

test("usage panel updates the verdict when the selected model changes", () => {
  const usage = { usedTokens: 150_000, turns };
  const continuation = {
    provider: "claude" as const,
    running: false,
    canCompact: true,
    nowMs: RESPONSE_MS + MINUTE,
  };
  const { rerender } = render(
    <UsagePanel usage={usage} modelId="claude-sonnet" continuation={continuation} />,
  );
  expect(region().getByText("Likely warm")).toBeTruthy();

  rerender(<UsagePanel usage={usage} modelId="claude-opus" continuation={continuation} />);
  expect(region().getByText("Unknown")).toBeTruthy();
  expect(region().getByText(/last response used a different model/)).toBeTruthy();
});

test.each([false, true])("shows continuation before usage with running=%s", (running) => {
  render(
    <UsagePanel
      usage={undefined}
      modelId={undefined}
      rateLimits={running ? [{ label: "Weekly", usedPercent: 20 }] : undefined}
      continuation={{ provider: "claude", running, canCompact: false }}
    />,
  );
  expect(region().getByText("Unknown")).toBeTruthy();
  expect(
    region().getByText(running ? /A response is running/ : /No response has reported usage/),
  ).toBeTruthy();
});

test("retains cache counters but drops continuation evidence after Codex compacts", () => {
  const usage = { usedTokens: 150_000, turns, cacheReadTokens: 90_000 };
  const continuation = {
    provider: "codex" as const,
    running: false,
    canCompact: true,
    nowMs: RESPONSE_MS + MINUTE,
  };
  const { rerender } = render(
    <UsagePanel usage={usage} modelId={undefined} continuation={continuation} />,
  );
  expect(region().getByText("Likely warm")).toBeTruthy();

  rerender(
    <UsagePanel
      usage={{ ...usage, contextCompacted: true, occupancyUnknown: true, usedTokens: 0 }}
      modelId={undefined}
      continuation={continuation}
    />,
  );
  expect(region().getByText("Unknown")).toBeTruthy();
  expect(region().getByText(/Context was compacted/)).toBeTruthy();
  expect(region().queryByText(/Last reported context|Large context/) === null).toBe(true);
  expect(screen.getByText("90k")).toBeTruthy();
});

test("estimated Claude turn traffic does not imply a large context", () => {
  render(
    <UsagePanel
      usage={{ usedTokens: 170_000, estimated: true, turns }}
      modelId="claude-sonnet"
      continuation={{ provider: "claude", running: false, canCompact: true, nowMs: RESPONSE_MS }}
    />,
  );
  expect(region().queryByText(/Last reported context|Large context/) === null).toBe(true);
});

test("the first idle commit uses the current clock after a long turn", () => {
  const originalDateNow = Date.now;
  let nowMs = RESPONSE_MS - 10 * MINUTE;
  Date.now = () => nowMs;
  const committed: Array<string | null | undefined> = [];
  const view = (running: boolean) => (
    <Profiler
      id="continuation"
      onRender={() =>
        committed.push(screen.getByRole("region", { name: "Next continuation" }).textContent)
      }
    >
      <ContinuationExplanation
        provider="claude"
        turns={running ? undefined : turns}
        contextTokens={40_000}
        running={running}
        canCompact={false}
      />
    </Profiler>
  );
  try {
    const { rerender } = render(view(true));
    committed.length = 0;
    nowMs = RESPONSE_MS;
    rerender(view(false));
    expect(committed[0]).toContain("Last response 0s ago");
    expect(committed.every((text) => !text?.includes("does not agree with this clock"))).toBe(true);
  } finally {
    Date.now = originalDateNow;
  }
});

test("ages the last response on a minute clock and stops it on unmount", () => {
  const originalDateNow = Date.now;
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  let nowMs = RESPONSE_MS + 2 * MINUTE;
  let tick: (() => void) | undefined;
  const cleared: number[] = [];
  Date.now = () => nowMs;
  window.setInterval = ((callback: TimerHandler, delay?: number) => {
    expect(delay).toBe(MINUTE);
    tick = callback as () => void;
    return 91;
  }) as typeof window.setInterval;
  window.clearInterval = ((handle: number) => {
    cleared.push(handle);
  }) as typeof window.clearInterval;
  try {
    const view = render(
      <ContinuationExplanation
        provider="claude"
        turns={turns}
        contextTokens={50_000}
        running={false}
        canCompact={false}
      />,
    );
    expect(region().getByText("Likely warm")).toBeTruthy();
    nowMs = RESPONSE_MS + 7 * MINUTE;
    act(() => tick?.());
    // Re-reading moved the idle time on; it did not extend the cache.
    expect(region().getByText("Unknown")).toBeTruthy();
    expect(region().getByText(/Last response 7m ago/)).toBeTruthy();
    view.unmount();
    expect(cleared).toEqual([91]);
  } finally {
    Date.now = originalDateNow;
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
  }
});

test("does not run a clock when no response is dated", () => {
  const originalSetInterval = window.setInterval;
  let calls = 0;
  window.setInterval = (() => {
    calls += 1;
    return 1;
  }) as unknown as typeof window.setInterval;
  try {
    render(
      <ContinuationExplanation
        provider="claude"
        turns={[{ turnId: "t1" }]}
        contextTokens={50_000}
        running={false}
        canCompact={false}
      />,
    );
    expect(region().getByText(/did not date its last response/)).toBeTruthy();
    expect(calls).toBe(0);
  } finally {
    window.setInterval = originalSetInterval;
  }
});
