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

function cleanContent(text: string): string {
  // Strip injected memory context
  let cleaned = text.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "");
  // Strip OpenClaw metadata prefix from user messages
  const metaMatch = cleaned.match(/^Sender \(untrusted metadata\):[\s\S]*?```\s*\n([\s\S]*)$/);
  if (metaMatch) {
    return metaMatch[1].trim();
  }
  // Strip JSON metadata blocks at the start
  const jsonBlockMatch = cleaned.match(/^```json[\s\S]*?```\s*\n([\s\S]*)$/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }
  return cleaned.trim();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;

  // Array of content blocks: [{ type: "text", text: "..." }, ...]
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (typeof block?.content === "string") return block.content;
        if (typeof block?.text === "string") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // Single object with text/content field
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }

  return "";
}

function extractLastUserMessage(event: HookEvent): string | null {
  if (event.prompt && typeof event.prompt === "string") {
    return event.prompt;
  }

  if (event.messages && Array.isArray(event.messages)) {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      if (event.messages[i].role === "user") {
        return extractText(event.messages[i].content);
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

  // ── Auto-Recall: inject memories via before_agent_start ──
  // Must return { prependContext: "..." } — OpenClaw prepends this to the system context.
  api.on("before_agent_start", async (event: HookEvent, ctx: HookContext) => {
    if (!config.autoRecall) return;

    try {
      await ensureReady();
      if (!client) return;

      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      const userMessage = cleanContent(prompt) || extractLastUserMessage(event);
      if (!userMessage || userMessage.length < MIN_RECALL_LENGTH) return;

      const agentId = getAgentId(ctx);
      const result = await client.autoRecall(
        userMessage,
        config.orgId!,
        agentId,
        config.autoRecallTopK
      );

      if (result.memory_count > 0) {
        const memoryBlock = [
          "<relevant-memories>",
          "Facts and context from previous conversations with this user. Use these to answer questions.",
          "",
          result.context,
          "</relevant-memories>",
        ].join("\n");

        if (config.debug) {
          logger.info(
            `[Unforget] Returning prependContext (${result.memory_count} memories) for: "${userMessage.slice(0, 50)}..."`
          );
        }

        return { prependContext: memoryBlock };
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

      if (config.debug) {
        logger.info(
          `[Unforget] agent_end: agentId=${agentId}, messages=${messages?.length ?? "none"}, orgId=${config.orgId}`
        );
      }

      if (!messages || !Array.isArray(messages)) {
        if (config.debug) logger.info("[Unforget] No messages in agent_end event");
        return;
      }

      // Store user and assistant messages from this turn
      let stored = 0;
      const lastTwo = messages.slice(-2);
      for (const msg of lastTwo) {
        // Extract text from message content (may be string, array of blocks, or object)
        const text = extractText(msg.content);

        if (config.debug) {
          logger.info(
            `[Unforget] Checking msg: role=${msg.role}, type=${typeof msg.content}, isArray=${Array.isArray(msg.content)}, text="${text.slice(0, 80)}"`
          );
        }
        if (msg.role === "system") continue;
        if (!text) continue;
        // Clean metadata prefix and skip session control messages
        const cleaned = cleanContent(text);
        if (!cleaned) continue;
        if (cleaned.startsWith("A new session was started")) continue;
        if (isNoise(cleaned)) {
          if (config.debug) logger.info(`[Unforget] Skipped noise: "${text.slice(0, 50)}"`);
          continue;
        }

        try {
          const result = await client.write(
            cleaned,
            config.orgId!,
            agentId,
            {
              memoryType: "event",
              tags: [msg.role],
              importance: msg.role === "user" ? 0.6 : 0.4,
            }
          );
          stored++;
          if (config.debug) {
            logger.info(
              `[Unforget] Wrote memory: ${(result as any)?.id ?? "ok"} — "${msg.content.slice(0, 50)}..."`
            );
          }
        } catch (writeErr) {
          logger.warn(`[Unforget] Write failed for ${msg.role}: ${writeErr}`);
        }
      }

      if (config.debug) {
        logger.info(`[Unforget] Stored ${stored} memories from conversation turn`);
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
