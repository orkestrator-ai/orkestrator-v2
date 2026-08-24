/**
 * The bridge's one-shot interactive sign-in.
 *
 * Invoked as `cursor-bridge --login`. It emits one JSON object per line so the
 * spawning backend can read the URL as soon as it exists and learn the outcome
 * when the browser flow finishes:
 *
 *   {"loginUrl":"https://…"}     the URL the user must open
 *   {"ok":true}                  the credential was minted and persisted
 *   {"error":"…"}                a readable reason it did not complete
 *
 * The minted key itself is never printed. It goes only to the credential store
 * the SDK writes, which the backend points at Orkestrator's data directory.
 */
import { authStatus, beginLogin } from "./credentials.js";
import { errorText } from "./prompt.js";

export async function runLogin(emit: (line: string) => void): Promise<number> {
  // This child is spawned by the backend on the user's own machine, so it is
  // the right place to open a browser — and the only one. The Electron window
  // denies `window.open` and `target="_blank"` outright, so the renderer
  // cannot do it, and a bridge serving a session may be inside a container.
  // The SDK skips the launch under SSH or NO_OPEN_BROWSER, and the URL is
  // emitted regardless, so a failed launch still leaves the user a link.
  const handle = beginLogin({ openBrowser: true });
  // Cancelling the process must cancel the poll rather than orphan it, or a
  // killed login keeps holding its challenge open until the SDK's own timeout.
  const onSignal = () => handle.cancel();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    emit(JSON.stringify({ loginUrl: await handle.loginUrl }));
  } catch (error) {
    emit(JSON.stringify({ error: errorText(error) }));
    return 1;
  }

  try {
    await handle.completion;
  } catch (error) {
    emit(JSON.stringify({ error: errorText(error) }));
    return 1;
  }

  // Report the persisted result rather than the login's own return value: what
  // matters to the caller is whether the credential is now readable, which is
  // the same question every later session asks.
  const status = await authStatus();
  if (!status.authenticated) {
    emit(JSON.stringify({ error: "Cursor sign-in completed but no credential was stored" }));
    return 1;
  }
  emit(JSON.stringify({ ok: true, ...(status.email ? { email: status.email } : {}) }));
  return 0;
}
