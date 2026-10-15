import type { ProviderListResponse } from "@opencode-ai/sdk/v2/types";

/**
 * A real `GET /provider` response from OpenCode 1.19.0, trimmed for size.
 *
 * Captured on 2026-10-15 from a login with `opencode` and `opencode-go`
 * connected. Kept verbatim apart from: three of the 229 providers, a few of
 * each one's models, and the provider-level `key` and `options` removed so no
 * credential is committed. Provider order, the `default` map and `connected`
 * are as OpenCode reported them.
 *
 * `default` is a map of provider id to that provider's default model id, with
 * an entry for every provider OpenCode knows — connected or not.
 */
export const OPENCODE_PROVIDER_LIST_RESPONSE: ProviderListResponse = {
  all: [
    {
      id: "anthropic",
      name: "Anthropic",
      source: "custom",
      env: ["ANTHROPIC_API_KEY"],
      options: {},
      models: {
        "claude-sonnet-4-6": {
          id: "claude-sonnet-4-6",
          providerID: "anthropic",
          api: {
            id: "claude-sonnet-4-6",
            url: "",
            npm: "@ai-sdk/anthropic",
          },
          name: "Claude Sonnet 4.6",
          family: "claude-sonnet",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: true,
              video: false,
              pdf: true,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: false,
          },
          cost: {
            input: 3,
            output: 15,
            cache: {
              read: 0.3,
              write: 3.75,
            },
          },
          limit: {
            context: 1000000,
            output: 128000,
          },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-02-17",
          variants: {
            low: {
              thinking: {
                type: "adaptive",
              },
              effort: "low",
            },
            medium: {
              thinking: {
                type: "adaptive",
              },
              effort: "medium",
            },
            high: {
              thinking: {
                type: "adaptive",
              },
              effort: "high",
            },
            max: {
              thinking: {
                type: "adaptive",
              },
              effort: "max",
            },
          },
        },
        "claude-opus-4-6": {
          id: "claude-opus-4-6",
          providerID: "anthropic",
          api: {
            id: "claude-opus-4-6",
            url: "",
            npm: "@ai-sdk/anthropic",
          },
          name: "Claude Opus 4.6",
          family: "claude-opus",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: true,
              video: false,
              pdf: true,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: false,
          },
          cost: {
            input: 5,
            output: 25,
            cache: {
              read: 0.5,
              write: 6.25,
            },
          },
          limit: {
            context: 1000000,
            output: 128000,
          },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-02-04",
          variants: {
            low: {
              thinking: {
                type: "adaptive",
              },
              effort: "low",
            },
            medium: {
              thinking: {
                type: "adaptive",
              },
              effort: "medium",
            },
            high: {
              thinking: {
                type: "adaptive",
              },
              effort: "high",
            },
            max: {
              thinking: {
                type: "adaptive",
              },
              effort: "max",
            },
          },
        },
      },
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      source: "api",
      env: ["OPENCODE_API_KEY"],
      options: {},
      models: {
        "mimo-v2.6-pro": {
          id: "mimo-v2.6-pro",
          providerID: "opencode-go",
          api: {
            id: "mimo-v2.6-pro",
            url: "https://opencode.ai/inference/go/v1",
            npm: "@ai-sdk/openai-compatible",
          },
          name: "MiMo-V2.6-Pro",
          family: "mimo",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: {
              text: true,
              audio: true,
              image: true,
              video: true,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: {
              field: "reasoning_content",
            },
          },
          cost: {
            input: 0.435,
            output: 0.87,
            cache: {
              read: 0.003625,
              write: 0,
            },
          },
          limit: {
            context: 1048576,
            output: 131072,
          },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-09-22",
          variants: {},
        },
        "deepseek-v4.1-flash": {
          id: "deepseek-v4.1-flash",
          providerID: "opencode-go",
          api: {
            id: "deepseek-v4.1-flash",
            url: "https://opencode.ai/inference/go/v1",
            npm: "@ai-sdk/openai-compatible",
          },
          name: "DeepSeek V4.1 Flash",
          family: "deepseek-flash",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: true,
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: {
              field: "reasoning_content",
            },
          },
          cost: {
            input: 0.15,
            output: 0.6,
            cache: {
              read: 0.003,
              write: 0,
            },
          },
          limit: {
            context: 1000000,
            output: 384000,
          },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-09-10",
          variants: {
            low: {
              reasoningEffort: "low",
            },
            high: {
              reasoningEffort: "high",
            },
            max: {
              reasoningEffort: "max",
            },
          },
        },
        "gpt-5.6-luna": {
          id: "gpt-5.6-luna",
          providerID: "opencode-go",
          api: {
            id: "gpt-5.6-luna",
            url: "https://opencode.ai/inference/go/v1",
            npm: "@ai-sdk/openai",
          },
          name: "GPT-5.6 Luna",
          family: "gpt-luna",
          capabilities: {
            temperature: false,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: true,
              video: false,
              pdf: true,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: false,
          },
          cost: {
            input: 0.2,
            output: 1.2,
            cache: {
              read: 0.02,
              write: 0.25,
            },
            tiers: [
              {
                input: 0.4,
                output: 1.8,
                cache: {
                  read: 0.04,
                  write: 0.5,
                },
                tier: {
                  type: "context",
                  size: 272000,
                },
              },
            ],
            experimentalOver200K: {
              input: 0.4,
              output: 1.8,
              cache: {
                read: 0.04,
                write: 0.5,
              },
            },
          },
          limit: {
            context: 1050000,
            input: 922000,
            output: 128000,
          },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-07-09",
          variants: {
            none: {
              reasoningEffort: "none",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
            low: {
              reasoningEffort: "low",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
            medium: {
              reasoningEffort: "medium",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
            high: {
              reasoningEffort: "high",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
            xhigh: {
              reasoningEffort: "xhigh",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
            max: {
              reasoningEffort: "max",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          },
        },
      },
    },
    {
      id: "opencode",
      name: "OpenCode",
      source: "custom",
      env: ["OPENCODE_API_KEY"],
      options: {},
      models: {
        "longcat-2.5-preview-free": {
          id: "longcat-2.5-preview-free",
          providerID: "opencode",
          api: {
            id: "longcat-2.5-preview-free",
            url: "https://opencode.ai/inference/v1",
            npm: "@ai-sdk/openai-compatible",
          },
          name: "LongCat 2.5 Preview Free",
          family: "longcat",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: true,
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: {
              field: "reasoning_content",
            },
          },
          cost: {
            input: 0,
            output: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
          limit: {
            context: 1000000,
            output: 131072,
          },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-09-25",
          variants: {
            low: {
              reasoningEffort: "low",
            },
            medium: {
              reasoningEffort: "medium",
            },
            high: {
              reasoningEffort: "high",
            },
          },
        },
        "big-pickle": {
          id: "big-pickle",
          providerID: "opencode",
          api: {
            id: "big-pickle",
            url: "https://opencode.ai/inference/v1",
            npm: "@ai-sdk/openai-compatible",
          },
          name: "Big Pickle",
          family: "big-pickle",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: {
              field: "reasoning_content",
            },
          },
          cost: {
            input: 0,
            output: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
          limit: {
            context: 200000,
            input: 160000,
            output: 32000,
          },
          status: "active",
          options: {},
          headers: {},
          release_date: "2025-10-17",
          variants: {},
        },
      },
    },
  ],
  default: {
    anthropic: "claude-sonnet-4-6",
    "opencode-go": "gpt-5.6-luna",
    opencode: "big-pickle",
  },
  connected: ["opencode-go", "opencode"],
};

/** The same response from a login whose only connected provider is `opencode-go`. */
export const OPENCODE_GO_ONLY_PROVIDER_LIST_RESPONSE: ProviderListResponse = {
  ...OPENCODE_PROVIDER_LIST_RESPONSE,
  connected: ["opencode-go"],
};
