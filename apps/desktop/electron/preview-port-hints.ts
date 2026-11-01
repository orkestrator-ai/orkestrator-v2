import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PreviewPortHints } from "./preview-transport-manager.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("preview");

const MAX_HINTS = 256;

/**
 * Remembered local ingress ports, so a service usually keeps its loopback
 * origin (and therefore its localStorage) across app restarts. A hint is only
 * ever *bound* directly — never probed and released — and a taken port falls
 * back to an OS-assigned one. Hints carry no credential.
 */
export function createPreviewPortHints(file: string): PreviewPortHints {
  const hints = new Map<string, number>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed).slice(-MAX_HINTS)) {
        if (
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 1024 &&
          value <= 65_535
        ) {
          hints.set(key, value);
        }
      }
    }
  } catch {
    // Missing or unreadable hints only cost origin continuity.
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    timer = null;
    const temporary = `${file}.${process.pid}.tmp`;
    void mkdir(path.dirname(file), { recursive: true })
      .then(() =>
        writeFile(temporary, `${JSON.stringify(Object.fromEntries(hints))}\n`, { mode: 0o600 }),
      )
      .then(() => rename(temporary, file))
      .catch((error: unknown) => {
        log.warn("port-hints.persist-failed", { error: formatLogError(error, { stack: false }) });
      });
  };
  return {
    get: (key) => hints.get(key),
    set: (key, port) => {
      if (hints.get(key) === port) return;
      hints.delete(key);
      hints.set(key, port);
      while (hints.size > MAX_HINTS) hints.delete(hints.keys().next().value!);
      if (!timer) {
        timer = setTimeout(persist, 1_000);
        timer.unref?.();
      }
    },
  };
}
