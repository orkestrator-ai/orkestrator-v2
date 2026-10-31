import type { NativeDialogs } from "./native-dialogs.js";

/** Supervised profiles report to their launcher; interactive ones wait for OK. */
export function createStartupFailureReporter<Window>(options: {
  agentTest: boolean;
  productName: string;
  dialogs: Pick<NativeDialogs<Window>, "showMessageBox">;
  logError?: (message: string, error: unknown) => void;
}): (failure: unknown) => Promise<void> {
  const logError = options.logError ?? ((message, error) => console.error(message, error));
  return async (failure) => {
    logError("[Desktop] Startup failed:", failure);
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
