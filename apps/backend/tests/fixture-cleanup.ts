import { promises as fs, rmSync } from "node:fs";

/** The foreground deadline stays bounded; `settled` includes the last writer and removal. */
export function removeFixturesAfterSettlement(
  settle: () => Promise<unknown>,
  roots: readonly string[],
  timeoutMs = 2_000,
): Promise<void> & { settled: Promise<void> } {
  const settlement = Promise.resolve()
    .then(settle)
    .then(() => undefined);
  // Keep ownership after a timeout. A resumed writer may mkdir recursively,
  // so remove again after its last write, on either success or rejection.
  const settled = settlement.finally(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  // The foreground race observes errors before its deadline. Afterwards this
  // handler prevents an unhandled rejection; callers can still await settled.
  void settled.catch(() => undefined);
  const foreground = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Fixture writers did not settle before cleanup")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
    }
  };
  return Object.assign(foreground(), { settled });
}
