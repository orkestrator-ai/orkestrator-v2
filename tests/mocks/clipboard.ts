/**
 * Shared mock functions for @/lib/native/clipboard.
 *
 * Registered once in tests/setup.ts so that every test file shares the same
 * mock instances.  Individual tests configure behaviour via mockImplementation
 * in their beforeEach blocks.
 */
import { mock } from "bun:test";

export const mockReadImage = mock(() => Promise.reject(new Error("no image")) as Promise<unknown>);
export const mockReadText = mock(() => Promise.resolve(""));
export const mockWriteText = mock(async () => {});
