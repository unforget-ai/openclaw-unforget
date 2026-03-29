/**
 * OpenClaw Plugin API types.
 */

export interface OpenClawPluginApi {
  pluginConfig: PluginConfig;
  logger: Logger;
  resolvePath(path: string): string;
  registerCli(cli: unknown): void;
  on(event: string, handler: (event: HookEvent, ctx: HookContext) => Promise<unknown> | unknown): void;
  registerHook(hook: string, handler: (event: HookEvent) => Promise<void> | void): void;
}

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface PluginConfig {
  databaseUrl?: string;
  apiUrl?: string;
  orgId?: string;
  agentId?: string;
  autoRetain?: boolean;
  autoRecall?: boolean;
  autoRecallTopK?: number;
  debug?: boolean;
}

export interface HookEvent {
  prompt?: string;
  messages?: Message[];
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface HookContext {
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface MemoryItem {
  id: string;
  content: string;
  memory_type: string;
  tags: string[];
  entities: string[];
  importance: number;
  score?: number;
  created_at: string;
  accessed_at: string;
}

export interface AutoRecallResponse {
  context: string;
  memory_count: number;
}
