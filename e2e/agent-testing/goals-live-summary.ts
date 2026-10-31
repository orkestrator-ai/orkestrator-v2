import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Playwright restarts workers on failure; later cases retain earlier evidence. */
export function writeGoalSummary(file: string, current: Record<string, unknown>): void {
  let previous: Record<string, unknown> = {};
  try {
    const loaded = record(JSON.parse(readFileSync(file, "utf8")));
    if (loaded.platform === current.platform && loaded.environmentKind === current.environmentKind)
      previous = loaded;
  } catch {
    // A new run, or an incomplete old summary. The current evidence still saves.
  }
  const combined = {
    ...previous,
    ...current,
    scenarios: { ...record(previous.scenarios), ...record(current.scenarios) },
  };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(combined, null, 2)}\n`, { mode: 0o600 });
}
