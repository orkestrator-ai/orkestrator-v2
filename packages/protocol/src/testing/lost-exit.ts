import { spyOn } from "bun:test";

/**
 * Makes `Bun.spawn` behave as Bun does when it loses a child's completion event
 * (docs/tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md):
 * the child runs and exits for real, but `exited` never settles. Returns what puts
 * Bun back.
 */
export function loseBunExitEvents(): () => void {
  const realSpawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    const child = realSpawn(...args);
    return new Proxy(child, {
      get(target, key) {
        if (key === "exited") return new Promise(() => undefined);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof Bun.spawn);
  return () => spy.mockRestore();
}
