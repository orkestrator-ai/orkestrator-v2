import { calleeName, memberName, unwrap, type AnyNode } from "./ast";
import type { GuardVisitor, ScannedFile, SourceGuard } from "./guard";
import { isTestSource } from "./paths";

/**
 * A webRequest listener installed in Electron main without the shared wrapper
 * (docs/architecture/renderer-security.md, "webRequest listeners"). A
 * listener that throws before calling Electron's callback leaves its request
 * unanswered and gives main an uncaught exception; on
 * 2026-10-21 that stopped main before a closed window released its preview
 * attachments (flake 0622). `answering` and `observing`
 * (`apps/desktop/electron/webrequest-listener.ts`) always answer, so every
 * `webRequest.on*(...)` call in main must pass one of them, or `null` to
 * remove a listener. The baseline is zero.
 */

/** Electron main's production sources. */
export const RAW_WEBREQUEST_LISTENER_ROOTS = ["apps/desktop/electron"] as const;

/** Every `WebRequest` event, as Electron names its installer. */
export const WEBREQUEST_EVENTS: ReadonlySet<string> = new Set([
  "onBeforeRequest",
  "onBeforeSendHeaders",
  "onSendHeaders",
  "onHeadersReceived",
  "onResponseStarted",
  "onBeforeRedirect",
  "onCompleted",
  "onErrorOccurred",
]);

/** The wrappers that make a listener always answer. */
const WRAPPERS: ReadonlySet<string> = new Set(["answering", "observing"]);

/** `webRequest.onX(...)` or `x.webRequest.onX(...)`. */
function isWebRequestInstall(call: AnyNode): boolean {
  const callee = unwrap(call.callee);
  if (callee.type !== "MemberExpression") return false;
  const event = memberName(callee);
  if (!event || !WEBREQUEST_EVENTS.has(event)) return false;
  const owner = unwrap(callee.object);
  return (
    (owner.type === "Identifier" && owner.name === "webRequest") ||
    memberName(owner) === "webRequest"
  );
}

/** A wrapped listener, or `null` (which removes one). */
function isAnsweringListener(argument: AnyNode | undefined): boolean {
  if (!argument) return false;
  const listener = unwrap(argument);
  if (listener.type === "Literal" && listener.value === null) return true;
  if (listener.type !== "CallExpression") return false;
  const name = calleeName(listener);
  return name !== undefined && WRAPPERS.has(name);
}

function visitInstalls(): GuardVisitor {
  const findings: number[] = [];
  return {
    handlers: {
      CallExpression(node) {
        if (!isWebRequestInstall(node)) return;
        const listener = node.arguments?.[node.arguments.length - 1];
        if (!isAnsweringListener(listener)) findings.push(node.start);
      },
    },
    finish: () => findings,
  };
}

export function appliesToElectronMainSource(file: Pick<ScannedFile, "path">): boolean {
  return (
    RAW_WEBREQUEST_LISTENER_ROOTS.some((root) => file.path.startsWith(`${root}/`)) &&
    !isTestSource(file.path)
  );
}

export const rawWebRequestListener: SourceGuard = {
  id: "raw-webrequest-listener",
  advice:
    "Electron main installs every webRequest listener through answering(name, decide, " +
    "failClosed) or observing(name, observe, onFailure) from " +
    "apps/desktop/electron/webrequest-listener.ts, so a listener that throws still answers " +
    "its request with a fail-closed response (flake 0622; docs/architecture/renderer-security.md). Pass null to remove one.",
  productionRoots: RAW_WEBREQUEST_LISTENER_ROOTS,
  appliesTo: appliesToElectronMainSource,
  mayOffend: (source) => source.includes("webRequest"),
  visit: () => visitInstalls(),
};
