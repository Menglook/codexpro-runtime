import { randomUUID } from "node:crypto";
import { McpProtocolError } from "../protocolAdapter.js";
import type { CanonicalMcpRequestContext } from "./requestContext.js";

interface AppSessionBinding {
  appSessionId: string;
  toolName: string;
  actorId?: string;
  conversationId?: string;
  workspaceId?: string;
  workspaceGeneration?: number;
  createdAt: string;
  expiresAt: number;
}

export class ModernMcpAppSessionStore {
  private readonly sessions = new Map<string, AppSessionBinding>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 500
  ) {}

  create(toolName: string, context: CanonicalMcpRequestContext): AppSessionBinding {
    this.sweep();
    if (this.sessions.size >= this.maxEntries) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest) this.sessions.delete(oldest);
    }
    const binding: AppSessionBinding = {
      appSessionId: randomUUID(),
      toolName,
      actorId: context.actorId,
      conversationId: context.conversationId,
      workspaceId: context.workspaceId,
      workspaceGeneration: context.workspaceGeneration,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + this.ttlMs
    };
    this.sessions.set(binding.appSessionId, binding);
    return binding;
  }

  assert(appSessionId: string, toolName: string, context: CanonicalMcpRequestContext): AppSessionBinding {
    this.sweep();
    const binding = this.sessions.get(appSessionId);
    if (!binding) throw new McpProtocolError("MCP App session is missing or expired.", -32004);
    const expected = {
      toolName,
      actorId: context.actorId,
      conversationId: context.conversationId,
      workspaceId: context.workspaceId,
      workspaceGeneration: context.workspaceGeneration
    };
    for (const [key, value] of Object.entries(expected)) {
      if (binding[key as keyof AppSessionBinding] !== value) {
        throw new McpProtocolError(`MCP App session ${key} binding mismatch.`, -32004);
      }
    }
    return binding;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, binding] of this.sessions) if (binding.expiresAt <= now) this.sessions.delete(id);
  }
}

export const modernMcpAppSessionStore = new ModernMcpAppSessionStore();
