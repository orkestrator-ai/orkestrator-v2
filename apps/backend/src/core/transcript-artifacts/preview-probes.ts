/**
 * Declarative interaction probes, executed by application-owned Playwright
 * code inside the isolated preview worker.
 *
 * A probe names one element by a validated `data-artifact-test` identifier;
 * there is no selector, script or expression input. Steps run in order with a
 * per-step bound, record bounded observed values, and stop at the first
 * failure; later steps are reported as `skipped`.
 */
import type { Page } from "playwright-core";

import { INTERACTIVE_HTML_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type {
  ArtifactDiagnostic,
  ArtifactProbeResultV1,
  ArtifactProbeV1,
} from "@orkestrator/protocol/transcript-artifacts";

const OBSERVED_TEXT_LIMIT = 200;

export interface ProbeRunOutcome {
  results: ArtifactProbeResultV1[];
  diagnostics: ArtifactDiagnostic[];
  passed: boolean;
}

class ProbeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly observed?: string | number,
  ) {
    super(message);
  }
}

function describe(probe: ArtifactProbeV1): string {
  return `${probe.op} on "${probe.target}"`;
}

function boundedText(value: string): string {
  return value.length > OBSERVED_TEXT_LIMIT ? `${value.slice(0, OBSERVED_TEXT_LIMIT)}…` : value;
}

/** Parse the first finite number in a visible text, tolerating grouping commas. */
export function parseVisibleNumber(text: string): number | null {
  const match = /[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?|[-+]?\.\d+/.exec(text);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** Visible value of a control or element: input value for form controls, else rendered text. */
async function readValue(page: Page, target: string, timeoutMs: number): Promise<string> {
  const locator = page.locator(`[data-artifact-test="${target}"]`);
  return locator.evaluate(
    (element) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        return element.value;
      }
      if (element instanceof HTMLOutputElement) return element.value || (element.textContent ?? "");
      return element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");
    },
    undefined,
    { timeout: timeoutMs },
  );
}

async function uniqueTarget(page: Page, target: string) {
  if (!INTERACTIVE_HTML_POLICY.probeTargetPattern.test(target)) {
    throw new ProbeFailure(
      "invalid_target",
      `Target "${target.slice(0, 64)}" is not a valid data-artifact-test id`,
    );
  }
  const locator = page.locator(`[data-artifact-test="${target}"]`);
  const count = await locator.count();
  if (count === 0)
    throw new ProbeFailure("target_not_found", `No element has data-artifact-test="${target}"`);
  if (count > 1)
    throw new ProbeFailure(
      "target_not_unique",
      `${count} elements have data-artifact-test="${target}"`,
    );
  return locator;
}

async function runStep(
  page: Page,
  probe: ArtifactProbeV1,
  stepMs: number,
): Promise<string | number | undefined> {
  switch (probe.op) {
    case "wait-visible": {
      const timeout = Math.min(
        stepMs,
        Math.max(0, probe.timeoutMs ?? INTERACTIVE_HTML_POLICY.defaultWaitVisibleMs),
      );
      const locator = page.locator(`[data-artifact-test="${probe.target}"]`);
      if (!INTERACTIVE_HTML_POLICY.probeTargetPattern.test(probe.target)) {
        throw new ProbeFailure("invalid_target", "Invalid target");
      }
      try {
        await locator.first().waitFor({ state: "visible", timeout });
      } catch {
        throw new ProbeFailure(
          "not_visible",
          `data-artifact-test="${probe.target}" was not visible within ${timeout} ms`,
        );
      }
      const count = await locator.count();
      if (count > 1)
        throw new ProbeFailure(
          "target_not_unique",
          `${count} elements have data-artifact-test="${probe.target}"`,
        );
      return undefined;
    }
    case "click": {
      const locator = await uniqueTarget(page, probe.target);
      await locator.click({ timeout: stepMs, noWaitAfter: true });
      return undefined;
    }
    case "fill": {
      const locator = await uniqueTarget(page, probe.target);
      const text = probe.text.slice(0, INTERACTIVE_HTML_POLICY.maxProbeTextCharacters);
      await locator.fill(text, { timeout: stepMs, noWaitAfter: true });
      return boundedText(await readValue(page, probe.target, stepMs));
    }
    case "set-number": {
      if (!Number.isFinite(probe.value))
        throw new ProbeFailure("invalid_value", "set-number requires a finite value");
      const locator = await uniqueTarget(page, probe.target);
      const type = await locator.evaluate(
        (element) =>
          element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
        undefined,
        { timeout: stepMs },
      );
      if (type !== "number" && type !== "range") {
        throw new ProbeFailure(
          "not_numeric_control",
          `data-artifact-test="${probe.target}" is a ${type}, not a number or range input`,
        );
      }
      await locator.fill(String(probe.value), { timeout: stepMs, noWaitAfter: true });
      const observed = await readValue(page, probe.target, stepMs);
      const value = Number(observed);
      if (!Number.isFinite(value) || value !== probe.value) {
        throw new ProbeFailure(
          "value_rejected",
          `The control kept ${boundedText(observed)} instead of ${probe.value}`,
          boundedText(observed),
        );
      }
      return value;
    }
    case "expect-text": {
      await uniqueTarget(page, probe.target);
      const observed = (await readValue(page, probe.target, stepMs)).trim();
      if (observed !== probe.equals.trim()) {
        throw new ProbeFailure(
          "expectation_failed",
          `Expected text ${JSON.stringify(boundedText(probe.equals))}, observed ${JSON.stringify(boundedText(observed))}`,
          boundedText(observed),
        );
      }
      return boundedText(observed);
    }
    case "expect-number": {
      await uniqueTarget(page, probe.target);
      const text = await readValue(page, probe.target, stepMs);
      const observed = parseVisibleNumber(text);
      if (observed === null) {
        throw new ProbeFailure(
          "not_a_number",
          `Expected a number, observed ${JSON.stringify(boundedText(text.trim()))}`,
          boundedText(text.trim()),
        );
      }
      const tolerance = probe.tolerance ?? 0;
      if (!(Math.abs(observed - probe.equals) <= tolerance)) {
        throw new ProbeFailure(
          "expectation_failed",
          `Expected ${probe.equals}${tolerance ? ` ± ${tolerance}` : ""}, observed ${observed}`,
          observed,
        );
      }
      return observed;
    }
  }
}

export async function runProbes(
  page: Page,
  probes: readonly ArtifactProbeV1[],
  options: { stepMs: number; onStep?: () => Promise<void> },
): Promise<ProbeRunOutcome> {
  const results: ArtifactProbeResultV1[] = [];
  const diagnostics: ArtifactDiagnostic[] = [];
  const steps = probes.slice(0, INTERACTIVE_HTML_POLICY.maxProbeSteps);
  let failed = false;
  for (const [index, probe] of steps.entries()) {
    const base = { index, op: probe.op, target: String(probe.target).slice(0, 64) };
    if (failed) {
      results.push({ ...base, status: "skipped" });
      continue;
    }
    const stepMs = Math.min(options.stepMs, INTERACTIVE_HTML_POLICY.maxProbeStepMs);
    try {
      const observed = await withDeadline(runStep(page, probe, stepMs), stepMs + 250);
      await options.onStep?.();
      results.push({ ...base, status: "passed", ...(observed === undefined ? {} : { observed }) });
    } catch (error) {
      failed = true;
      const failure =
        error instanceof ProbeFailure
          ? error
          : new ProbeFailure(
              error instanceof StepTimeout ? "step_timeout" : "action_failed",
              error instanceof StepTimeout
                ? `The step did not finish within ${stepMs} ms`
                : `The ${probe.op} action could not be performed (${firstLine(error)})`,
            );
      results.push({
        ...base,
        status: "failed",
        errorCode: failure.code,
        ...(failure.observed === undefined ? {} : { observed: failure.observed }),
      });
      diagnostics.push({
        severity: "error",
        code: `probe_${failure.code}`,
        message: `Probe ${index} (${describe(probe)}): ${failure.message}`.slice(0, 1_000),
        location: `probes[${index}]`,
      });
    }
  }
  return { results, diagnostics, passed: !failed };
}

class StepTimeout extends Error {}

/** First line of a driver error, bounded; it is author-facing diagnostics, never logged. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n")[0] ?? "").replace(/\s+/g, " ").slice(0, 200);
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
