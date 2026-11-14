/**
 * The worker pool `scratch.ts` runs its `bun test` processes through (to-do
 * 6900): `runPool(count, jobs, task)` calls `task(1)` to `task(count)`, at
 * most `jobs` at a time. After a task fails it starts no further task, but it
 * still waits for every task already started to settle before it rejects with
 * the first failure, so the caller's cleanup (removing the shared worktree)
 * never runs while a started child is still using it.
 */
export async function runPool(
  count: number,
  jobs: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  let next = 1;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next <= count) {
      const index = next++;
      try {
        await task(index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, count) }, worker));
  if (failure) throw failure.error;
}
