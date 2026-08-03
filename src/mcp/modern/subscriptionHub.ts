import { randomUUID } from "node:crypto";

export interface ModernMcpSubscriptionEvent {
  cursor: number;
  eventId: string;
  topic: string;
  emittedAt: string;
  data: Record<string, unknown>;
}

export class ModernMcpSubscriptionHub {
  private readonly instanceId = randomUUID();
  private readonly events: ModernMcpSubscriptionEvent[] = [];
  private cursor = 0;

  constructor(private readonly capacity = 500) {}

  publish(topic: string, data: Record<string, unknown>): ModernMcpSubscriptionEvent {
    const event: ModernMcpSubscriptionEvent = {
      cursor: ++this.cursor,
      eventId: randomUUID(),
      topic,
      emittedAt: new Date().toISOString(),
      data
    };
    this.events.push(event);
    while (this.events.length > this.capacity) this.events.shift();
    return event;
  }

  listen(input: { cursor?: number; topics?: string[]; limit?: number; instanceId?: string }): Record<string, unknown> {
    const earliest = this.events[0]?.cursor ?? this.cursor;
    const requested = Math.max(0, Number(input.cursor ?? 0));
    const instanceMismatch = Boolean(input.instanceId && input.instanceId !== this.instanceId);
    const gap = requested > 0 && requested < earliest - 1;
    if (instanceMismatch || gap) {
      return {
        instanceId: this.instanceId,
        cursor: this.cursor,
        events: [],
        resyncRequired: true,
        reason: instanceMismatch ? "server_restarted" : "cursor_gap"
      };
    }
    const topics = new Set((input.topics ?? []).filter(Boolean));
    const limit = Math.max(1, Math.min(200, Number(input.limit ?? 100)));
    const events = this.events
      .filter((event) => event.cursor > requested && (topics.size === 0 || topics.has(event.topic)))
      .slice(0, limit);
    return {
      instanceId: this.instanceId,
      cursor: events.at(-1)?.cursor ?? requested,
      latestCursor: this.cursor,
      events,
      resyncRequired: false
    };
  }
}

export const modernMcpSubscriptionHub = new ModernMcpSubscriptionHub();
