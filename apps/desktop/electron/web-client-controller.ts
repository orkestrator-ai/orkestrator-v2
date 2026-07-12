import type { GatewayStartInfo } from "@orkestrator/backend/gateway";
import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";

export type WebClientGateway = {
  start(): Promise<GatewayStartInfo | null>;
  stop(): Promise<void>;
  getTokenSettings(): Promise<GatewayTokenSettings>;
  setToken(token: string): Promise<GatewayTokenSettings>;
};

export class WebClientController {
  private startInfo: GatewayStartInfo | null = null;
  private enabled = true;
  private error: string | null = null;
  private transition: Promise<unknown>;

  constructor(
    private readonly gateway: WebClientGateway,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly logger: Pick<Console, "error"> = console,
  ) {
    this.transition = Promise.resolve();
  }

  getStatus(): WebClientStatus {
    return {
      enabled: this.enabled,
      running: this.startInfo !== null,
      url: this.startInfo?.url ?? null,
      error: this.error,
    };
  }

  setEnabled(enabled: boolean): Promise<WebClientStatus> {
    return this.enqueue(() => this.applyEnabled(enabled));
  }

  getTokenSettings(): Promise<GatewayTokenSettings> {
    return this.enqueue(() => this.gateway.getTokenSettings());
  }

  setToken(token: string): Promise<GatewayTokenSettings> {
    return this.enqueue(() => this.gateway.setToken(token));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.catch(() => undefined).then(operation);
    this.transition = result;
    return result;
  }

  private async applyEnabled(enabled: boolean): Promise<WebClientStatus> {
    this.enabled = enabled;
    this.error = null;

    if (!enabled) {
      try {
        await this.gateway.stop();
        this.startInfo = null;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.logger.error("[RemoteGateway] Failed to stop cleanly:", error);
      }
      return this.getStatus();
    }

    if (this.startInfo) return this.getStatus();

    try {
      this.startInfo = await this.gateway.start();
      if (!this.startInfo) {
        this.error = this.env.ORKESTRATOR_GATEWAY_DISABLED === "1"
          ? "The web client is disabled by ORKESTRATOR_GATEWAY_DISABLED."
          : "No Tailscale connection was found. Connect Tailscale, then save again to retry.";
      }
    } catch (error) {
      this.startInfo = null;
      this.error = error instanceof Error ? error.message : String(error);
      this.logger.error("[RemoteGateway] Failed to start:", error);
    }
    return this.getStatus();
  }
}
