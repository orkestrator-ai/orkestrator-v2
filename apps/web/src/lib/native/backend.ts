import {
  notePrefetchedCommandInvocation,
  readPrefetchedCommandResponse,
} from "@/lib/prefetched-command-responses";

export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const prefetched = readPrefetchedCommandResponse(command, args);
  if (prefetched.found) return prefetched.value as T;
  // A command no primed snapshot answered may be the write that invalidates
  // them. Report it before the round trip so a mutation cannot be overtaken by
  // a read that the batch primed earlier in the same reconciliation.
  notePrefetchedCommandInvocation(command);
  if (!window.orkestrator) {
    throw new Error("Orkestrator native backend is not available");
  }
  return window.orkestrator.invoke<T>(command, args);
}
