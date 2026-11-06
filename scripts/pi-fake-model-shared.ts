import path from "node:path";

export function profilePiAgentDirectory(dataDir: string): string {
  return path.join(dataDir, "agent-credentials", "home", ".pi", "agent");
}

export function piCompletionChunk(
  model: string,
  id: string,
  delta: Record<string, unknown>,
  finish: string | null,
  usage?: object,
) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

export function piProviderConfig(options: {
  provider: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelName: string;
}) {
  return {
    providers: {
      [options.provider]: {
        name: options.providerName,
        baseUrl: options.baseUrl,
        api: "openai-completions",
        apiKey: options.apiKey,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        },
        models: [
          {
            id: options.model,
            name: options.modelName,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32_000,
            maxTokens: 256,
          },
        ],
      },
    },
  };
}
