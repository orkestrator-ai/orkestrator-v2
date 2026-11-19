import { defineLogAreas } from "./define.js";

export const CREDENTIALS_LOG_AREAS = defineLogAreas({
  credentials: {
    description:
      "Agent credentials: the credential vault, access requests, grants and the runs and requests that use them. Never a value, a command or output.",
    events: {
      "vault.keychain-unavailable":
        "The system keychain could not be used at startup, so saved values use the fallback store this backend reports in Settings.",
      "vault.read-failed":
        "Reading a credential value from the vault failed; the use is cancelled before anything runs.",
      "run.failed":
        "A credential run failed unexpectedly after it started; its operation is recorded as outcome unknown.",
      "sweep.failed": "The periodic expiry sweep failed; every use still checks expiry itself.",
      "start.failed":
        "The credential service could not start; agent credential tools are unavailable on this backend.",
    },
  },
});
