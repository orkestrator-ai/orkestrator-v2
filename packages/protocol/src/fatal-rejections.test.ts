import { describe, expect, test } from "bun:test";
import { installFatalRejectionGuard } from "./fatal-rejections.js";

type Listener = (reason: unknown) => void;

function fakeProcess() {
  const listeners: Listener[] = [];
  return {
    listeners,
    on(_event: "unhandledRejection", listener: Listener) {
      listeners.push(listener);
      return this;
    },
    off(_event: "unhandledRejection", listener: Listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
      return this;
    },
  };
}

describe("fatal rejection guard", () => {
  test("serialized workers can install the guard without module dependencies", () => {
    const install = new Function(
      `return (${installFatalRejectionGuard.toString()})`,
    )() as typeof installFatalRejectionGuard;
    const target = fakeProcess();
    const warnings: string[] = [];
    install({
      label: "[worker]",
      force: true,
      onProcess: target,
      warn: (message) => warnings.push(message),
    });
    target.listeners[0]!(new Error("fixture"));
    expect(warnings[0]).toContain("[worker] Unhandled promise rejection (continuing): fixture");
  });
  test("reports an Error by name, message and stack", () => {
    const target = fakeProcess();
    const warnings: string[] = [];
    installFatalRejectionGuard({
      label: "[Backend]",
      force: true,
      warn: (message) => warnings.push(message),
      onProcess: target,
    });

    const abort = new DOMException("The operation was aborted.", "AbortError");
    target.listeners[0]?.(abort);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[Backend] Unhandled promise rejection (continuing)");
    // The name is the only part that identifies an abort; its message is generic.
    expect(warnings[0]).toContain("AbortError: The operation was aborted.");
  });

  test("reports non-Error rejection values without throwing", () => {
    const target = fakeProcess();
    const warnings: string[] = [];
    installFatalRejectionGuard({
      label: "[claude-bridge]",
      force: true,
      warn: (message) => warnings.push(message),
      onProcess: target,
    });

    for (const reason of [undefined, null, "plain string", 42, { code: "E_NOPE" }]) {
      expect(() => target.listeners[0]?.(reason)).not.toThrow();
    }
    expect(warnings).toHaveLength(5);
    expect(warnings[4]).toContain('{"code":"E_NOPE"}');
  });

  test("survives a reason that cannot be serialized", () => {
    const target = fakeProcess();
    const warnings: string[] = [];
    installFatalRejectionGuard({
      label: "[Backend]",
      force: true,
      warn: (message) => warnings.push(message),
      onProcess: target,
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => target.listeners[0]?.(circular)).not.toThrow();
    expect(warnings[0]).toContain("[object Object]");
  });

  test("the returned stop function removes the listener", () => {
    const target = fakeProcess();
    const stop = installFatalRejectionGuard({
      label: "[Backend]",
      force: true,
      warn: () => {},
      onProcess: target,
    });
    expect(target.listeners).toHaveLength(1);
    stop();
    expect(target.listeners).toHaveLength(0);
  });

  test("does not install under the test runner unless forced", () => {
    // Suites import the bridge entrypoints directly. Installing there would
    // downgrade a genuine unhandled rejection from a failed run to a log line.
    const target = fakeProcess();
    const stop = installFatalRejectionGuard({
      label: "[Backend]",
      warn: () => {},
      onProcess: target,
    });
    expect(process.env.NODE_ENV).toBe("test");
    expect(target.listeners).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });
});
