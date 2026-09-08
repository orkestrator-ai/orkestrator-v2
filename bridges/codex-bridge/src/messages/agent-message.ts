/**
 * Display treatment for provider-authored assistant channels.
 *
 * Codex applies a turn's final-output JSON schema to every model sample in that
 * turn, including `commentary`. A model can therefore send a useful progress
 * sentence only by placing it inside one of the schema's string fields. The
 * provider phase is the authoritative distinction: schema-shaped commentary is
 * progress, while an unphased/final schema-shaped message may still be a draft
 * that the structured-output renderer must withhold.
 */
import type { AgentMessageItem } from "../codex-item-types.js";
import {
  isWithheldMachineOutput,
  lastMachineJsonDocument,
} from "@orkestrator/protocol/structured-output";

const COMMENTARY_TEXT_FIELDS = [
  "progress",
  "update",
  "message",
  "commentary",
  "summary",
  "notes",
  "limitations",
] as const;
const MAX_COMMENTARY_SCAN_NODES = 4_096;
const MAX_COMMENTARY_SCAN_DEPTH = 32;
const MAX_COMMENTARY_SNIPPETS = 32;

function commentaryStrings(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const byField = new Map<string, string[]>();
  const seen = new Set<string>();
  const append = (field: string, candidate: unknown) => {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const entry of values) {
      if (seen.size >= MAX_COMMENTARY_SNIPPETS) return;
      if (typeof entry !== "string") continue;
      const text = entry.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const entries = byField.get(field) ?? [];
      entries.push(text);
      byField.set(field, entries);
    }
  };

  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_COMMENTARY_SCAN_NODES) {
    const current = stack.pop()!;
    visited += 1;
    if (
      current.depth > MAX_COMMENTARY_SCAN_DEPTH ||
      !current.value ||
      typeof current.value !== "object"
    ) {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        if (child && typeof child === "object") {
          stack.push({ value: child, depth: current.depth + 1 });
        }
      }
      continue;
    }
    const record = current.value as Record<string, unknown>;
    for (const field of COMMENTARY_TEXT_FIELDS) append(field, record[field]);
    for (const child of Object.values(record)) {
      if (child && typeof child === "object") {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }

  return COMMENTARY_TEXT_FIELDS.flatMap((field) => byField.get(field) ?? []);
}

/** Make schema-shaped provider commentary readable without exposing it as final output. */
export function visibleCommentaryText(text: string): string {
  if (!isWithheldMachineOutput(text)) return text;

  const document = lastMachineJsonDocument(text);
  if (document) {
    try {
      const snippets = commentaryStrings(JSON.parse(document));
      if (snippets.length > 0) return snippets.join("\n\n");
    } catch {
      // A delimiter-complete but invalid document is still provider-formatted
      // commentary. The labelled fallback below keeps it visible and honest.
    }
  }

  return `Progress update (provider-formatted):\n\n${document ?? text}`;
}

export function agentMessageDisplayText(item: AgentMessageItem): string {
  return item.phase === "commentary" ? visibleCommentaryText(item.text) : item.text;
}
