import type { GatewayStartInfo } from "./gateway.js";
import type { WebClientStatus } from "../src/types/webClient.js";

export type WebClientGateway = {
  start(): Promise<GatewayStartInfo | null>;
  stop(): Promise<void>;
};

export class WebClientController {
  private startInfo: GatewayStartInfo | null = null;
  private enabled = true;
  private error: string | null = null;
  private transition: Promise<WebClientStatus>;

  constructor(
    private readonly gateway: WebClientGateway,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly logger: Pick<Console, "error"> = console,
  ) {
    this.transition = Promise.resolve(this.getStatus());
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
    this.transition = this.transition
      .catch(() => this.getStatus())
      .then(() => this.applyEnabled(enabled));
    return this.transition;
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
