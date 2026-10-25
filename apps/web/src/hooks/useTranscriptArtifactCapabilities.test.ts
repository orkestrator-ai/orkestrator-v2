import { afterEach, expect, jest, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import {
  resetTranscriptArtifactCapabilities,
  useTranscriptArtifactCapabilities,
} from "./useTranscriptArtifactCapabilities";
const invokeMock = invoke as unknown as ReturnType<typeof mock>;
afterEach(() => {
  cleanup();
  resetTranscriptArtifactCapabilities();
  jest.useRealTimers();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});
test("mounted subscribers recover from an initial capabilities transport failure", async () => {
  jest.useFakeTimers();
  resetTranscriptArtifactCapabilities();
  let reads = 0;
  invokeMock.mockImplementation(async () => {
    if (++reads === 1) throw new Error("transport unavailable");
    return { backendId: "recovered", rolloutFlags: {} };
  });
  const { result, unmount } = renderHook(useTranscriptArtifactCapabilities);
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(result.current).toBeNull();
  await act(async () => {
    jest.advanceTimersByTime(10_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(result.current?.backendId).toBe("recovered");
  expect(reads).toBe(2);
  unmount();
});
