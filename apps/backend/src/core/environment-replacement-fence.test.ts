import { expect, test } from "bun:test";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";

test("exclusive Git reservation excludes environment and raw-path writers through commit", async () => {
  const fence = new EnvironmentMutationFence();
  let admitted!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = fence.withExclusiveMutation("env", ["/tmp/rewind-worktree"], async () => {
    // Only commands inside the reservation can mutate the environment.
    fence.beginMutation("env")();
    admitted();
    await gate;
    fence.beginMutation("env")();
  });
  await ready;
  try {
    expect(() => fence.beginMutation("env")).toThrow("being moved");
    expect(() => fence.beginAgentWork("env")).toThrow("being moved");
    expect(() => fence.beginWorktreeMutation("/tmp/rewind-worktree/new-file")).toThrow(
      "being moved",
    );
    await expect(fence.withExclusiveMutation("env", [], async () => {})).rejects.toThrow();
    await expect(fence.withReplacement("env", async () => {})).rejects.toThrow("being moved");
  } finally {
    release();
    await operation;
  }
  fence.beginMutation("env")();
  fence.beginAgentWork("env")();
  fence.beginWorktreeMutation("/tmp/rewind-worktree/new-file")();
});

test("exclusive reset refuses in-flight writes and releases after failure", async () => {
  const fence = new EnvironmentMutationFence();
  const release = fence.beginMutation("env");
  await expect(fence.withExclusiveMutation("env", [], async () => {})).rejects.toThrow(
    "in progress",
  );
  release();
  const releasePath = fence.beginWorktreeMutation("/tmp/rewind-worktree/new-file");
  await expect(
    fence.withExclusiveMutation("env", ["/tmp/rewind-worktree"], async () => {}),
  ).rejects.toThrow("file mutation");
  releasePath();
  await expect(
    fence.withExclusiveMutation("env", [], async () => {
      throw new Error("save failed");
    }),
  ).rejects.toThrow("save failed");
  fence.beginMutation("env")();
});
