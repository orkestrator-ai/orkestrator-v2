export function configureGrokRuntime(environment: NodeJS.ProcessEnv): void {
  const requestedProvider = environment.ACP_PROVIDER?.trim();
  if (requestedProvider && requestedProvider !== "grok") {
    throw new Error("acp-bridge only supports grok");
  }
  environment.ACP_PROVIDER = "grok";
}
