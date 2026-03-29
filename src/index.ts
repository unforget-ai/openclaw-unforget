/**
 * Unforget Memory Plugin for OpenClaw
 *
 * Zero-LLM long-term memory with 4-channel hybrid retrieval.
 * Auto-starts an embedded PostgreSQL + Unforget server when needed.
 */

import type {
  OpenClawPluginApi,
  PluginConfig,
  HookEvent,
  HookContext,
  Logger,
} from "./types.js";
import { UnforgetClient } from "./client.js";
import { UnforgetDaemon } from "./daemon.js";

// Module state
let client: UnforgetClient | null = null;
let daemon: UnforgetDaemon | null = null;
let config: PluginConfig = {};
let logger: Logger = console;
let isInitialized = false;
let initPromise: Promise<void> | null = null;

// Guard against double registration
const registeredApis = new WeakSet<object>();

// Minimum prompt length to trigger auto-recall (skip greetings, short commands)
const MIN_RECALL_LENGTH = 15;

// Content that shouldn't be stored as memories
const NOISE_PATTERNS = [
  /^(hi|hello|hey|thanks|ok|yes|no|sure|bye)\b/i,
  /^\/\w+/,  // slash commands
  /^[👋🎉✅❌💡🤔]+$/,  // emoji-only
];

function parseConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    databaseUrl: raw.databaseUrl as string | undefined,
    apiUrl: raw.apiUrl as string | undefined,
    orgId: (raw.orgId as string) || "openclaw",
    agentId: raw.agentId as string | undefined,
    autoRetain: raw.autoRetain !== false,  // default true
    autoRecall: raw.autoRecall !== false,  // default true
    autoRecallTopK: (raw.autoRecallTopK as number) || 10,
    debug: !!raw.debug,
  };
}

function getAgentId(ctx?: HookContext): string {
  return config.agentId || ctx?.agentId as string || "default";
}

function isNoise(content: string): boolean {
  return content.length < 10 || NOISE_PATTERNS.some((p) => p.test(content.trim()));
}

function extractLastUserMessage(event: HookEvent): string | null {
  if (event.prompt && typeof event.prompt === "string") {
    return event.prompt;
  }

  if (event.messages && Array.isArray(event.messages)) {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      if (event.messages[i].role === "user") {
        return event.messages[i].content;
      }
    }
  }

  return null;
}

async function ensureReady(): Promise<void> {
  if (isInitialized) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    const apiUrl = config.apiUrl;

    if (apiUrl) {
      // External API mode — just connect
      client = new UnforgetClient(apiUrl);
      if (!(await client.health())) {
        throw new Error(`Cannot reach Unforget API at ${apiUrl}`);
      }
      logger.info("[Unforget] Connected to external API: " + apiUrl);
    } else {
      // Embedded mode — start daemon
      daemon = new UnforgetDaemon(9077, logger);
      await daemon.start();
      client = new UnforgetClient(daemon.url);
    }

    isInitialized = true;
  })();

  await initPromise;
}

/**
 * Plugin entry point — called by OpenClaw when the plugin is loaded.
 */
export default function init(api: OpenClawPluginApi): void {
  // Prevent double registration
  if (registeredApis.has(api)) return;
  registeredApis.add(api);

  logger = api.logger;
  config = parseConfig(api.pluginConfig as Record<string, unknown>);

  if (config.debug) {
    logger.info("[Unforget] Plugin loaded with config:", JSON.stringify(config));
  }

  // ── Auto-Recall: inject memories before each prompt ──
  api.on("before_prompt_build", async (event: HookEvent, ctx: HookContext) => {
    if (!config.autoRecall) return;

    try {
      await ensureReady();
      if (!client) return;

      const userMessage = extractLastUserMessage(event);
      if (!userMessage || userMessage.length < MIN_RECALL_LENGTH) return;

      const agentId = getAgentId(ctx);
      const result = await client.autoRecall(
        userMessage,
        config.orgId!,
        agentId,
        config.autoRecallTopK
      );

      if (result.memory_count > 0) {
        // Inject memories into the prompt context
        const memoryBlock = [
          "<relevant-memories>",
          result.context,
          "</relevant-memories>",
        ].join("\n");

        if (event.prompt && typeof event.prompt === "string") {
          event.prompt = memoryBlock + "\n\n" + event.prompt;
        }

        if (config.debug) {
          logger.info(
            `[Unforget] Injected ${result.memory_count} memories for: "${userMessage.slice(0, 50)}..."`
          );
        }
      }
    } catch (err) {
      logger.warn("[Unforget] Auto-recall failed:", err);
    }
  });

  // ── Auto-Retain: store conversation after response ──
  api.on("agent_end", async (event: HookEvent, ctx: HookContext) => {
    if (!config.autoRetain) return;

    try {
      await ensureReady();
      if (!client) return;

      const agentId = getAgentId(ctx);
      const messages = event.messages;
      if (!messages || !Array.isArray(messages)) return;

      // Store user and assistant messages from this turn
      for (const msg of messages.slice(-2)) {
        if (msg.role === "system") continue;
        if (isNoise(msg.content)) continue;

        await client.write(
          msg.content,
          config.orgId!,
          agentId,
          {
            memoryType: "event",
            tags: [msg.role],
            importance: msg.role === "user" ? 0.6 : 0.4,
          }
        );
      }

      if (config.debug) {
        logger.info("[Unforget] Stored conversation turn");
      }
    } catch (err) {
      logger.warn("[Unforget] Auto-retain failed:", err);
    }
  });

  // ── Memory tools: let the agent store/search/forget ──
  try {
    api.registerHook("agent:bootstrap", async (event: HookEvent) => {
      // Inject memory tool instructions into the agent's system prompt
      const toolInstructions = [
        "",
        "## Memory Tools",
        "You have access to long-term memory via the Unforget memory system.",
        "Important facts, preferences, and context from past conversations are automatically recalled.",
        "When the user shares important information (preferences, facts about themselves, decisions),",
        "it will be automatically remembered for future conversations.",
        "",
      ].join("\n");

      if (event.prompt && typeof event.prompt === "string") {
        event.prompt += toolInstructions;
      }
    });
  } catch {
    // Hook registration not available — skip
  }

  // ── Cleanup on exit ──
  api.on("session_end", async () => {
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
    isInitialized = false;
    initPromise = null;
    client = null;
  });

  logger.info("[Unforget] Memory plugin registered");
}
