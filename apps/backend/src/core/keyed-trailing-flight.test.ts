import { expect, test } from "bun:test";
import { KeyedTrailingFlight } from "./keyed-trailing-flight.js";

function gate<T>() {
  let release!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

test("a caller arriving mid-run waits for a fresh run that callers queued meanwhile share", async () => {
  const flights = new KeyedTrailingFlight<number>();
  const gates = [gate<number>(), gate<number>()];
  let starts = 0;
  const start = () => gates[starts++]!.promise;

  const first = flights.run("env", start);
  const second = flights.run("env", start);
  const third = flights.run("env", start);
  expect(starts).toBe(1);

  gates[0]!.release(1);
  expect(await first).toBe(1);
  // The follow-up started only once the first run settled.
  expect(starts).toBe(2);
  gates[1]!.release(2);
  expect(await second).toBe(2);
  expect(await third).toBe(2);
  expect(flights.size).toBe(0);
});

test("keys run independently", async () => {
  const flights = new KeyedTrailingFlight<string>();
  const a = gate<string>();
  const b = gate<string>();
  const first = flights.run("a", () => a.promise);
  const second = flights.run("b", () => b.promise);
  expect(flights.size).toBe(2);
  b.release("b");
  expect(await second).toBe("b");
  a.release("a");
  expect(await first).toBe("a");
});

test("a failed run rejects only its own callers and still starts the queued one", async () => {
  const flights = new KeyedTrailingFlight<number>();
  const failing = gate<number>();
  const first = flights.run("env", () => failing.promise);
  const second = flights.run("env", async () => 7);
  failing.fail(new Error("boom"));
  await expect(first).rejects.toThrow("boom");
  expect(await second).toBe(7);
  expect(flights.size).toBe(0);
});

test("a start that throws synchronously rejects and frees the key", async () => {
  const flights = new KeyedTrailingFlight<number>();
  await expect(
    flights.run("env", () => {
      throw new Error("sync");
    }),
  ).rejects.toThrow("sync");
  expect(await flights.run("env", async () => 3)).toBe(3);
});
