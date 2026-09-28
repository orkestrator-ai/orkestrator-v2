import { describe, expect, test } from "bun:test";
import {
  CONTAINER_ADMISSION_LIMITS,
  createAdmissionPoolForTest,
} from "../../../apps/backend/src/core/container-admission";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("container admission", () => {
  test("runs at most the slot count at once, in arrival order, and refuses past the wait bound", async () => {
    const pool = createAdmissionPoolForTest("copy", { concurrent: 2, waiting: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      pool.run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );
    await Bun.sleep(1);
    expect(started).toEqual([0, 1]);
    expect(pool.snapshot()).toEqual({ active: 2, waiting: 2 });
    await expect(pool.run(async () => "late")).rejects.toThrow(
      "ContainerLifecycleError:resource-exhausted",
    );
    gates[1]!.resolve();
    await runs[1];
    await Bun.sleep(1);
    expect(started).toEqual([0, 1, 2]);
    // A failure releases its slot too.
    gates[0]!.resolve();
    gates[2]!.resolve();
    gates[3]!.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    await expect(
      pool.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(pool.snapshot()).toEqual({ active: 0, waiting: 0 });
  });

  test("production limits are small and bounded", () => {
    expect(CONTAINER_ADMISSION_LIMITS.copy.concurrent).toBeLessThanOrEqual(2);
    expect(CONTAINER_ADMISSION_LIMITS.start.waiting).toBeGreaterThan(0);
  });
});
