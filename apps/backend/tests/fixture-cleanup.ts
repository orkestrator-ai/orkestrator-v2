import { promises as fs } from "node:fs";

/** Drain fixture writers, but always remove roots even if a writer stalls or rejects. */
export async function removeFixturesAfterSettlement(
  settle: () => Promise<unknown>,
  roots: readonly string[],
  timeoutMs = 2_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(settle),
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
}
