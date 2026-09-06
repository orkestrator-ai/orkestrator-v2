/**
 * Contract for the batch-snapshot cache that sits in front of `invoke()`.
 *
 * `@/lib/native/backend` is mocked for every suite in `tests/setup.ts`, so the
 * wrapper itself cannot be driven here. The decisions it delegates — what is
 * served, what is copied, what expires, and what a write invalidates — all live
 * in this module and are asserted directly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearPrefetchedCommandResponses,
  notePrefetchedCommandInvocation,
  primePrefetchedCommandResponses,
  readPrefetchedCommandResponse,
} from "./prefetched-command-responses";

afterEach(() => clearPrefetchedCommandResponses());

describe("prefetched command responses", () => {
  test("serves only the exact read and expires it after scoped delivery", () => {
    const clear = primePrefetchedCommandResponses([
      {
        command: "get_pane_layout",
        args: { environmentId: "environment-1" },
        snapshot: null,
      },
    ]);

    expect(
      readPrefetchedCommandResponse("get_pane_layout", { environmentId: "environment-1" }),
    ).toEqual({ found: true, value: null });
    expect(
      readPrefetchedCommandResponse("get_pane_layout", { environmentId: "environment-2" }),
    ).toEqual({ found: false });

    clear();
    expect(
      readPrefetchedCommandResponse("get_pane_layout", { environmentId: "environment-1" }),
    ).toEqual({ found: false });
  });

  test("hands out an isolated copy so a caller cannot mutate the batch", () => {
    const snapshot = { projects: [{ id: "project-1" }] };
    primePrefetchedCommandResponses([{ command: "get_projects", args: {}, snapshot }]);

    const first = readPrefetchedCommandResponse("get_projects", {}).value as typeof snapshot;
    first.projects[0]!.id = "mutated";

    expect(readPrefetchedCommandResponse("get_projects", {}).value).toEqual({
      projects: [{ id: "project-1" }],
    });
    expect(snapshot.projects[0]!.id).toBe("project-1");
  });

  test("an expired entry is not served and is dropped on the way out", () => {
    primePrefetchedCommandResponses([{ command: "get_config", args: {}, snapshot: "stale" }], {
      ttlMs: -1,
    });

    expect(readPrefetchedCommandResponse("get_config", {})).toEqual({ found: false });
    expect(readPrefetchedCommandResponse("get_config", {})).toEqual({ found: false });
  });
});

describe("prefetched command invalidation", () => {
  test("a mutation landing mid-delivery drops every primed snapshot", () => {
    primePrefetchedCommandResponses([
      { command: "get_config", args: {}, snapshot: { global: { stale: true } } },
      { command: "get_projects", args: {}, snapshot: ["stale-project"] },
    ]);

    // The client itself writes while the scoped delivery is still running.
    notePrefetchedCommandInvocation("update_config");

    expect(readPrefetchedCommandResponse("get_config", {})).toEqual({ found: false });
    expect(readPrefetchedCommandResponse("get_projects", {})).toEqual({ found: false });
  });

  test("an unrelated read leaves the rest of the batch primed", () => {
    primePrefetchedCommandResponses([
      { command: "get_config", args: {}, snapshot: { global: { stale: true } } },
    ]);

    for (const read of ["get_file_tree", "list_prompt_queues", "read_file", "is_ready", "has_gh"]) {
      notePrefetchedCommandInvocation(read);
    }

    expect(readPrefetchedCommandResponse("get_config", {})).toEqual({
      found: true,
      value: { global: { stale: true } },
    });
  });

  test("every unclassified command is treated as a write", () => {
    for (const mutation of [
      "add_project",
      "create_environment",
      "remove_project",
      "update_config",
      "set_pane_layout",
      "start_build_pipeline",
    ]) {
      primePrefetchedCommandResponses([{ command: "get_projects", args: {}, snapshot: [] }]);
      notePrefetchedCommandInvocation(mutation);
      expect(readPrefetchedCommandResponse("get_projects", {})).toEqual({ found: false });
    }
  });
});
