import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  mockToastError,
  mockToastSuccess,
  mockToastWarning,
} from "../../../../../tests/mocks/sonner";
import { armAutoMergeCleanup } from "./auto-merge-cleanup";

beforeEach(() => {
  mockToastSuccess.mockClear();
  mockToastWarning.mockClear();
  mockToastError.mockClear();
});

describe("armAutoMergeCleanup", () => {
  test("arms auto-merge with cleanup and confirms it", async () => {
    const set = mock(async () => true as boolean | null);
    expect(await armAutoMergeCleanup("env-1", set, null)).toBe(true);
    expect(set).toHaveBeenCalledWith(true, true);
    expect(mockToastSuccess).toHaveBeenCalledWith("Auto-merge & Cleanup is on", {
      description: "Merges when ready and resolves conflicts, then deletes this environment.",
      id: "auto-merge-cleanup-env-1",
    });
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  test("a transient hold (checks running) still confirms it", async () => {
    const set = mock(async () => true as boolean | null);
    await armAutoMergeCleanup("env-1", set, { message: "Checks are running.", transient: true });
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  test("a hold that needs someone to act warns what it waits for instead", async () => {
    const set = mock(async () => true as boolean | null);
    await armAutoMergeCleanup("env-1", set, {
      message: "A required check failed.",
      transient: false,
    });
    expect(mockToastWarning).toHaveBeenCalledWith("Auto-merge & Cleanup is on", {
      description: "Waiting: A required check failed.",
      id: "auto-merge-cleanup-env-1",
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  // `set` reports these itself: a rejected save, a backend that did not keep
  // the cleanup choice, or one already in flight (null), and a backend that
  // refused to arm auto-merge (false).
  for (const answer of [null, false] as const) {
    test(`a save that answers ${answer} shows no success or waiting toast`, async () => {
      const set = mock(async () => answer as boolean | null);
      expect(await armAutoMergeCleanup("env-1", set, { message: "Draft.", transient: false })).toBe(
        false,
      );
      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(mockToastWarning).not.toHaveBeenCalled();
    });
  }
});
