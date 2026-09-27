/**
 * Small renderer-local memory for capture workflow context that the desktop
 * pending descriptor does not carry:
 *
 * - why a capture was started ("result" captures belong to a request), keyed
 *   by the desktop capture id so it survives a renderer reload, bounded to the
 *   desktop spool's own process limit;
 * - the selection mode chosen in this review session (in memory, per tab);
 * - a stable per-install client id used to build draft editor ids.
 *
 * None of this is annotation content.
 */
import {
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationTargetKind,
} from "@orkestrator/protocol/web-annotations";
import type { BrowserPreviewCaptureMode } from "@orkestrator/protocol/browser-preview";
import { boundedId } from "./client";

export type CaptureIntent =
  | { kind: "result"; requestId: string; annotationId: string; createdAt: number }
  | { kind: "reselect"; annotationId: string; createdAt: number };

const INTENT_KEY = "orkestrator.web-annotations.capture-intents.v1";
const CLIENT_KEY = "orkestrator.web-annotations.client-id.v1";
const MAX_INTENTS = WEB_ANNOTATION_LIMITS.pendingCapturesPerProcess;

function readIntents(): Record<string, CaptureIntent> {
  try {
    const raw = window.localStorage?.getItem(INTENT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, CaptureIntent>)
      : {};
  } catch {
    return {};
  }
}

function writeIntents(intents: Record<string, CaptureIntent>) {
  const cutoff = Date.now() - WEB_ANNOTATION_LIMITS.pendingCaptureTtlMs;
  const entries = Object.entries(intents)
    .filter(([, intent]) => intent && intent.createdAt >= cutoff)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, MAX_INTENTS);
  try {
    window.localStorage?.setItem(INTENT_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage full or unavailable: the capture still works as a new note.
  }
}

export function rememberCaptureIntent(captureId: string, intent: CaptureIntent) {
  writeIntents({ ...readIntents(), [captureId]: intent });
}

export function captureIntent(captureId: string): CaptureIntent | null {
  return readIntents()[captureId] ?? null;
}

export function forgetCaptureIntent(captureId: string) {
  const intents = readIntents();
  if (!(captureId in intents)) return;
  delete intents[captureId];
  writeIntents(intents);
}

/**
 * A Save the user already asked for. It is written before the backend commit
 * so a transport failure, reload, or reconnect can finish the same save with
 * the same operation ids instead of silently leaving the capture pending.
 */
export interface CaptureSaveIntent {
  body: string;
  title?: string;
  draftId?: string;
  expectedContentRevision?: number;
  createdAt: number;
}

const SAVE_INTENT_KEY = "orkestrator.web-annotations.save-intents.v1";
const SCOPE_KEY = "orkestrator.web-annotations.capture-scopes.v1";

function readRecord<T>(key: string): Record<string, T> {
  try {
    const raw = window.localStorage?.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {};
  } catch {
    return {};
  }
}

function writeRecord<T extends { createdAt: number }>(key: string, record: Record<string, T>) {
  const cutoff = Date.now() - WEB_ANNOTATION_LIMITS.pendingCaptureTtlMs;
  const entries = Object.entries(record)
    .filter(
      ([, value]) => value && typeof value.createdAt === "number" && value.createdAt >= cutoff,
    )
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, MAX_INTENTS);
  try {
    window.localStorage?.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Unavailable storage only loses automatic retry; the capture stays pending.
  }
}

export function rememberSaveIntent(captureId: string, intent: CaptureSaveIntent) {
  writeRecord(SAVE_INTENT_KEY, {
    ...readRecord<CaptureSaveIntent>(SAVE_INTENT_KEY),
    [captureId]: intent,
  });
}

export function saveIntent(captureId: string): CaptureSaveIntent | null {
  const value = readRecord<CaptureSaveIntent>(SAVE_INTENT_KEY)[captureId];
  return value && typeof value.body === "string" ? value : null;
}

export function forgetSaveIntent(captureId: string) {
  const record = readRecord<CaptureSaveIntent>(SAVE_INTENT_KEY);
  if (!(captureId in record)) return;
  delete record[captureId];
  writeRecord(SAVE_INTENT_KEY, record);
}

/**
 * Draft scope of a capture. A recapture replaces a pending capture with a new
 * id; it keeps the original scope so text typed for the old one follows it.
 */
export function captureDraftScope(captureId: string): string {
  return readRecord<{ scope: string; createdAt: number }>(SCOPE_KEY)[captureId]?.scope ?? captureId;
}

/** Link a recapture to the capture it replaced (scope, intent, and save intent). */
export function linkRecapture(captureId: string, replacedCaptureId: string) {
  const scope = captureDraftScope(replacedCaptureId);
  writeRecord(SCOPE_KEY, {
    ...readRecord<{ scope: string; createdAt: number }>(SCOPE_KEY),
    [captureId]: { scope, createdAt: Date.now() },
  });
  const intent = captureIntent(replacedCaptureId);
  if (intent && !captureIntent(captureId)) rememberCaptureIntent(captureId, intent);
}

const sessionModes = new Map<string, BrowserPreviewCaptureMode>();

/** The selection mode chosen for this tab in the current review session. */
export function sessionCaptureMode(tabId: string): BrowserPreviewCaptureMode {
  return sessionModes.get(tabId) ?? "element";
}

export function setSessionCaptureMode(tabId: string, mode: BrowserPreviewCaptureMode) {
  sessionModes.set(tabId, mode);
}

export const CAPTURE_MODE_TARGET: Record<BrowserPreviewCaptureMode, WebAnnotationTargetKind> = {
  element: "element",
  text: "text-range",
  region: "region",
  page: "page",
};

let clientId: string | null = null;

export function webAnnotationClientId(): string {
  if (clientId) return clientId;
  try {
    const stored = window.localStorage?.getItem(CLIENT_KEY);
    if (stored && /^[A-Za-z0-9-]{8,64}$/.test(stored)) {
      clientId = stored;
      return stored;
    }
  } catch {
    // Fall through to an in-memory id.
  }
  const generated = boundedId(
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36)}`,
  ).slice(0, 64);
  clientId = generated;
  try {
    window.localStorage?.setItem(CLIENT_KEY, generated);
  } catch {
    // An in-memory id still keeps this session's drafts coherent.
  }
  return generated;
}

export function editorIdFor(scope: string): string {
  return boundedId(`${webAnnotationClientId()}:${scope}`);
}
