import type { NativeDialogs } from "./native-dialogs.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("desktop");

/** Supervised profiles report to their launcher; interactive ones wait for OK. */
export function createStartupFailureReporter<Window>(options: {
  agentTest: boolean;
  productName: string;
  dialogs: Pick<NativeDialogs<Window>, "showMessageBox">;
  logError?: (error: unknown) => void;
}): (failure: unknown) => Promise<void> {
  const logError =
    options.logError ?? ((error) => log.error("startup.failed", { error: formatLogError(error) }));
  return async (failure) => {
    logError(failure);
    if (options.agentTest) return;
    await options.dialogs.showMessageBox("startup-failure", {
      type: "error",
      title: `${options.productName} failed to start`,
      message: `${options.productName} failed to start`,
      detail: failure instanceof Error ? failure.message : String(failure),
      buttons: ["OK"],
    });
  };
}
