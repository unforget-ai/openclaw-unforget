/**
 * Manages the unforget-embed daemon lifecycle.
 *
 * Auto-starts an embedded Unforget server via `uvx unforget-embed`
 * when no external API URL is configured.
 */

import { spawn, type ChildProcess } from "child_process";
import type { Logger } from "./types.js";

const DEFAULT_PORT = 9077;
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 1000;

export class UnforgetDaemon {
  private port: number;
  private process: ChildProcess | null = null;
  private logger: Logger;

  constructor(port = DEFAULT_PORT, logger: Logger) {
    this.port = port;
    this.logger = logger;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    // Check if already running
    if (await this.isRunning()) {
      this.logger.info("[Unforget] Server already running on " + this.url);
      return;
    }

    this.logger.info("[Unforget] Starting unforget-embed daemon...");

    // Try uvx first (Python package runner), then fall back to pip-installed binary
    const commands = [
      ["uvx", ["unforget-embed", "start", "--foreground", "--port", String(this.port)]],
      ["unforget-embed", ["start", "--foreground", "--port", String(this.port)]],
      ["python", ["-m", "unforget_embed.cli", "start", "--foreground", "--port", String(this.port)]],
    ] as const;

    let started = false;

    for (const [cmd, args] of commands) {
      try {
        this.process = spawn(cmd, [...args], {
          stdio: "pipe",
          detached: false,
          env: {
            ...process.env,
            // Force CPU on macOS to avoid MPS issues in daemon mode
            ...(process.platform === "darwin"
              ? { PYTORCH_ENABLE_MPS_FALLBACK: "1" }
              : {}),
          },
        });

        this.process.stdout?.on("data", (data: Buffer) => {
          const text = data.toString().trim();
          if (text) this.logger.debug("[Unforget] " + text);
        });

        this.process.stderr?.on("data", (data: Buffer) => {
          const text = data.toString().trim();
          if (text && !text.includes("WARNING")) {
            this.logger.debug("[Unforget] " + text);
          }
        });

        this.process.on("error", () => {
          // Command not found — try next
        });

        // Wait for server to be ready
        await this.waitForReady();
        started = true;
        this.logger.info("[Unforget] Server ready on " + this.url);
        break;
      } catch {
        // Kill failed attempt and try next command
        this.process?.kill();
        this.process = null;
        continue;
      }
    }

    if (!started) {
      throw new Error(
        "[Unforget] Failed to start daemon. Install with: pip install unforget-embed"
      );
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.logger.info("[Unforget] Stopping daemon...");
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (await this.isRunning()) {
        return;
      }

      // Check if process died
      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new Error(`Daemon exited with code ${this.process.exitCode}`);
      }

      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }

    throw new Error("Daemon failed to start within timeout");
  }
}
