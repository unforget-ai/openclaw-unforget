/**
 * HTTP client for Unforget API.
 */

import type { MemoryItem, AutoRecallResponse } from "./types.js";

export class UnforgetClient {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl: string, timeout = 10_000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeout = timeout;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async write(
    content: string,
    orgId: string,
    agentId: string,
    opts?: {
      memoryType?: string;
      tags?: string[];
      importance?: number;
    }
  ): Promise<MemoryItem> {
    const res = await fetch(`${this.baseUrl}/v1/memory/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        org_id: orgId,
        agent_id: agentId,
        memory_type: opts?.memoryType ?? "event",
        tags: opts?.tags ?? [],
        importance: opts?.importance ?? 0.5,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!res.ok) {
      throw new Error(`Write failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  async recall(
    query: string,
    orgId: string,
    agentId: string,
    limit = 10
  ): Promise<MemoryItem[]> {
    const res = await fetch(`${this.baseUrl}/v1/memory/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        org_id: orgId,
        agent_id: agentId,
        limit,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!res.ok) {
      throw new Error(`Recall failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  async autoRecall(
    query: string,
    orgId: string,
    agentId: string,
    limit = 10
  ): Promise<AutoRecallResponse> {
    const res = await fetch(`${this.baseUrl}/v1/memory/auto-recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        org_id: orgId,
        agent_id: agentId,
        limit,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!res.ok) {
      throw new Error(`Auto-recall failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  async search(
    query: string,
    orgId: string,
    agentId: string,
    limit = 5
  ): Promise<MemoryItem[]> {
    const res = await fetch(`${this.baseUrl}/v1/memory/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        org_id: orgId,
        agent_id: agentId,
        limit,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!res.ok) {
      throw new Error(`Search failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  async forget(memoryId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/memory/${memoryId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!res.ok) {
      throw new Error(`Forget failed: ${res.status} ${await res.text()}`);
    }
  }
}
