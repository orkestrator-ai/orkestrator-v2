import { configure, prettyDOM } from "@testing-library/dom";
import {
  installBoundedConsoleDiagnostics,
  summarizeValue,
  TEST_DIAGNOSTIC_STRING_BYTES,
  truncateUtf8,
} from "./bounded-console-diagnostics";

export { TEST_DIAGNOSTIC_ERROR_BYTES } from "./bounded-console-diagnostics";
export { summarizeValue, TEST_DIAGNOSTIC_STRING_BYTES, truncateUtf8 };

export const TEST_DIAGNOSTIC_DOM_BYTES = 2_000;

const INSTALL_MARK = Symbol.for("orkestrator.test.bounded-dom-diagnostics");

/**
 * Assert that a DOM query found nothing without handing the received node to
 * Bun's matcher formatter. The latter can serialize an arbitrarily large DOM
 * tree; summarizeValue keeps the useful element identity while bounding it.
 */
export function expectDomAbsent(
  value: Element | null,
  description = "DOM query",
): asserts value is null {
  if (value !== null) {
    throw new Error(
      `${description}: expected no matching element; received ${summarizeValue(value)}`,
    );
  }
}

export function installBoundedTestDiagnostics(): void {
  const globalWithMark = globalThis as typeof globalThis & Record<symbol, boolean | undefined>;
  if (globalWithMark[INSTALL_MARK]) return;
  globalWithMark[INSTALL_MARK] = true;

  process.env.DEBUG_PRINT_LIMIT ??= String(TEST_DIAGNOSTIC_DOM_BYTES);
  configure({
    getElementError(message, container) {
      const rendered = prettyDOM(container, TEST_DIAGNOSTIC_DOM_BYTES, { highlight: false }) ?? "";
      const error = new Error(
        `${truncateUtf8(message ?? "Testing Library query failed", TEST_DIAGNOSTIC_STRING_BYTES)}` +
          (rendered ? `\n\nDOM snapshot (bounded):\n${rendered}` : ""),
      );
      error.name = "TestingLibraryElementError";
      return error;
    },
  });
  installBoundedConsoleDiagnostics();
}
