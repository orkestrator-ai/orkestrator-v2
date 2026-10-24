/**
 * Opening the agent information panel from elsewhere in the same document,
 * such as the composer's account chip. The panel's button owns its open state;
 * inside a workspace realm that button is the realm's own, which reports the
 * change to its window like any other open.
 */
const AGENT_INFORMATION_REQUEST_EVENT = "orkestrator:open-agent-information";

export function requestAgentInformation(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AGENT_INFORMATION_REQUEST_EVENT));
}

export function onAgentInformationRequest(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(AGENT_INFORMATION_REQUEST_EVENT, listener);
  return () => window.removeEventListener(AGENT_INFORMATION_REQUEST_EVENT, listener);
}
