import { beforeEach, afterEach, expect, test } from "bun:test";
import { armPullRequestFallback, settlePullRequestFallback } from "./pull-request-load-fallback";
import { mockToastError } from "../../../../tests/mocks/sonner";
import {
  installBackend,
  resetBackend,
} from "@/components/pull-requests/pull-request-test-fixtures";

const ref = { owner: "fallback", repo: "tests", number: 1 };
let opened: string[];
beforeEach(() => {
  opened = [];
  mockToastError.mockClear();
  installBackend({
    open_in_browser: (args) => {
      opened.push(String(args.url));
    },
  });
});
afterEach(resetBackend);

test("success consumes the pending fallback without opening a browser", async () => {
  armPullRequestFallback(ref);
  await settlePullRequestFallback(ref, false);
  await settlePullRequestFallback(ref, true);
  expect(opened).toEqual([]);
  expect(mockToastError).not.toHaveBeenCalled();
});

test("failed load keeps a persistent user-activated deep-link escape route", async () => {
  const url = "https://github.com/fallback/tests/pull/1/files#diff-example";
  armPullRequestFallback(ref, url);
  await settlePullRequestFallback(ref, true);
  expect(opened).toEqual([url]);
  const options = mockToastError.mock.calls[0]?.[1] as {
    duration: number;
    action: { label: string; onClick: () => void };
  };
  expect(options.duration).toBe(Infinity);
  expect(options.action.label).toBe("Open on GitHub");
  options.action.onClick();
  expect(opened).toEqual([url, url]);
  await settlePullRequestFallback(ref, true);
  expect(opened).toHaveLength(2);
});

test("abandoned opens evict the oldest while rearming refreshes its position", async () => {
  for (let number = 1; number <= 100; number++) armPullRequestFallback({ ...ref, number });
  armPullRequestFallback(ref, "https://github.com/fallback/tests/pull/1/files");
  armPullRequestFallback({ ...ref, number: 101 });
  await settlePullRequestFallback({ ...ref, number: 2 }, true);
  expect(opened).toEqual([]);
  await settlePullRequestFallback(ref, true);
  expect(opened).toEqual(["https://github.com/fallback/tests/pull/1/files"]);
  for (let number = 3; number <= 101; number++)
    await settlePullRequestFallback({ ...ref, number }, false);
});
