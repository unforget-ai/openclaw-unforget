/**
 * Unforget Memory Plugin for OpenClaw
 *
 * Zero-LLM long-term memory with 4-channel hybrid retrieval.
 * Auto-starts an embedded PostgreSQL + Unforget server when needed.
 */

import type {
  PluginConfig,
  HookEvent,
  HookContext,
} from "./types.js";
import { Type } from "@sinclair/typebox";
import { UnforgetClient } from "./client.js";
import { UnforgetDaemon } from "./daemon.js";

// Module state
let client: UnforgetClient | null = null;
let daemon: UnforgetDaemon | null = null;
let config: PluginConfig = {};
let logger: any = console;
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
export default function init(api: any): void {
  // Prevent double registration
  if (registeredApis.has(api)) return;
  registeredApis.add(api);

  logger = api.logger;
  config = parseConfig(api.pluginConfig as Record<string, unknown>);

  if (config.debug) {
    logger.info("[Unforget] Plugin loaded with config:", JSON.stringify(config));
  }

  // ── Auto-Recall + Intent Detection via before_agent_start ──
  api.on("before_agent_start", async (event: HookEvent, ctx: HookContext) => {
    if (!config.autoRecall) return;

    try {
      await ensureReady();
      if (!client) return;

      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      const userMessage = cleanContent(prompt) || extractLastUserMessage(event);
      if (!userMessage || userMessage.length < MIN_RECALL_LENGTH) return;

      const agentId = getAgentId(ctx);

      // Detect "forget" intent and handle it directly
      const forgetMatch = userMessage.match(
        /(?:forget|remove|delete|erase)\s+(?:that\s+)?(?:(?:i|my)\s+)?(?:(?:like|love|prefer|am|is|name|want)\s+)?(.+)/i
      );
      if (forgetMatch) {
        const searchQuery = forgetMatch[1].trim().replace(/[.!?]+$/, "");
        if (config.debug) {
          logger.info(`[Unforget] Forget intent detected: "${searchQuery}"`);
        }

        const results = await client.search(searchQuery, config.orgId!, agentId, 5);
        let deleted = 0;
        for (const m of results) {
          try {
            await client.forget((m as any).id);
            deleted++;
            if (config.debug) {
              logger.info(`[Unforget] Deleted memory: ${(m as any).id} — "${(m as any).content?.slice(0, 60)}"`);
            }
          } catch { /* skip */ }
        }

        if (deleted > 0) {
          return {
            prependContext: `<memory-action>\nDeleted ${deleted} memories matching "${searchQuery}". Confirm to the user that you've forgotten this.\n</memory-action>`,
          };
        }
      }

      // Detect "remember" intent and handle it directly
      const rememberMatch = userMessage.match(
        /(?:remember|save|store|note)\s+(?:that\s+)?(.+)/i
      );
      if (rememberMatch) {
        const fact = rememberMatch[1].trim().replace(/[.!?]+$/, "");
        if (fact.length > 5) {
          try {
            await client.write(fact, config.orgId!, agentId, { importance: 0.8 });
            if (config.debug) {
              logger.info(`[Unforget] Stored explicit memory: "${fact.slice(0, 60)}"`);
            }
            return {
              prependContext: `<memory-action>\nStored to memory: "${fact}". Confirm to the user.\n</memory-action>`,
            };
          } catch { /* fall through to normal recall */ }
        }
      }

      // Normal recall
      const result = await client.autoRecall(
        userMessage,
        config.orgId!,
        agentId,
        config.autoRecallTopK
      );

      if (result.memory_count > 0) {
        const memoryBlock = [
          "<relevant-memories>",
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

  // ── Memory tool instructions via bootstrap ──
  try {
    api.registerHook("agent:bootstrap", async () => {
      return {
        prependContext: [
          "## Long-Term Memory",
          "You have 3 memory tools: memory_store, memory_recall, memory_forget.",
          "- When the user asks you to REMEMBER something → use memory_store",
          "- When the user asks you to FORGET something → use memory_recall to find the ID, then memory_forget to delete it",
          "- When you need to look up past information → use memory_recall",
          "- Do NOT use markdown files for memory. Use only the memory tools.",
          "- Do NOT just acknowledge forget/remember requests — always call the tool.",
          "",
        ].join("\n"),
      };
    });
  } catch {
    // Bootstrap not available
  }

  // ── Memory tools: let the agent store/search/forget ──
  try {
    api.registerTool(
      (toolCtx: any) => {
        const agentId = getAgentId(toolCtx);
        return {
          name: "memory_recall",
          label: "Memory Recall",
          description: "Search long-term memories. Returns memory IDs and content. Use when you need context or before deleting a memory.",
          parameters: Type.Object({
            query: Type.String({ description: "Search query for finding relevant memories" }),
            limit: Type.Optional(Type.Number({ description: "Max results to return (default: 5)" })),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            await ensureReady();
            if (!client) return { content: [{ type: "text", text: "Memory not available" }] };
            const results = await client.search(
              params.query as string, config.orgId!, agentId, (params.limit as number) || 5
            );
            const formatted = results.map((m: any, i: number) =>
              `${i + 1}. [ID: ${m.id}] ${m.content}`
            ).join("\n");
            return {
              content: [{ type: "text", text: formatted || "No memories found." }],
              details: { count: results.length },
            };
          },
        };
      },
      { name: "memory_recall" }
    );

    api.registerTool(
      (toolCtx: any) => {
        const agentId = getAgentId(toolCtx);
        return {
          name: "memory_store",
          label: "Memory Store",
          description: "Save important information to long-term memory. Use for user preferences, facts, and decisions worth remembering.",
          parameters: Type.Object({
            text: Type.String({ description: "The fact or information to remember" }),
            importance: Type.Optional(Type.Number({ description: "Importance score 0-1 (default: 0.7)" })),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            await ensureReady();
            if (!client) return { content: [{ type: "text", text: "Memory not available" }] };
            const result = await client.write(
              params.text as string, config.orgId!, agentId,
              { importance: (params.importance as number) || 0.7 }
            );
            return {
              content: [{ type: "text", text: `Remembered: "${(params.text as string).slice(0, 80)}"` }],
              details: { id: (result as any)?.id },
            };
          },
        };
      },
      { name: "memory_store" }
    );

    api.registerTool(
      (toolCtx: any) => ({
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete a specific memory by its ID. Use memory_recall first to find the ID, then call this to delete it.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search query to find memory to delete" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID (UUID) to delete" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          await ensureReady();
          if (!client) return { content: [{ type: "text", text: "Memory not available" }] };
          const agentId = getAgentId(toolCtx);

          // If query provided, search first then delete matches
          if (params.query && !params.memoryId) {
            const results = await client.search(
              params.query as string, config.orgId!, agentId, 3
            );
            if (results.length === 0) {
              return { content: [{ type: "text", text: "No matching memories found to delete." }] };
            }
            const deleted: string[] = [];
            for (const m of results) {
              try {
                await client.forget((m as any).id);
                deleted.push((m as any).content?.slice(0, 60));
              } catch { /* skip */ }
            }
            return {
              content: [{ type: "text", text: `Deleted ${deleted.length} memories:\n${deleted.map(d => `- ${d}`).join("\n")}` }],
            };
          }

          // Direct ID delete
          if (params.memoryId) {
            try {
              await client.forget(params.memoryId as string);
              return { content: [{ type: "text", text: `Deleted memory ${params.memoryId}` }] };
            } catch (err) {
              return { content: [{ type: "text", text: `Failed to delete: ${err}` }] };
            }
          }

          return { content: [{ type: "text", text: "Provide either a query or memoryId to delete." }] };
        },
      }),
      { name: "memory_forget" }
    );

    logger.info("[Unforget] Registered 3 memory tools: memory_recall, memory_store, memory_forget");
  } catch (err) {
    logger.warn("[Unforget] Tool registration not available:", err);
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
