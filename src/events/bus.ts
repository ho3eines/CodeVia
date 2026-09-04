import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { CorrelationId } from "../types.js";

export type DomainEventName =
  | "github.push"
  | "github.pull_request"
  | "github.issue"
  | "github.release"
  | "github.workflow_completed"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "test.failed"
  | "test.passed"
  | "approval.required"
  | "approval.granted"
  | "approval.rejected"
  | "telegram.command"
  | "task.created"
  | "task.completed"
  | "workflow.started"
  | "workflow.completed"
  | "notification"
  | "model.call"
  | "error.reported";

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  name: DomainEventName;
  correlationId: CorrelationId;
  projectId?: string;
  payload: T;
  timestamp: string;
}

export type EventHandler<T = Record<string, unknown>> = (event: DomainEvent<T>) => void | Promise<void>;

/**
 * Lightweight in-process pub/sub event bus. Event producers publish domain events;
 * subscribers (agents, workflow engine, notifications, websocket broadcaster)
 * react. Swappable for a broker (Redis/pubsub) in scale-out deployments.
 */
export class EventBus {
  private handlers = new Map<DomainEventName, EventHandler[]>();

  on<T = Record<string, unknown>>(name: DomainEventName, handler: EventHandler<T>): () => void {
    const list = this.handlers.get(name) ?? [];
    const wrapped = handler as EventHandler;
    list.push(wrapped);
    this.handlers.set(name, list);
    return () => this.off(name, wrapped);
  }

  off<T = Record<string, unknown>>(name: DomainEventName, handler: EventHandler<T>): void {
    const list = this.handlers.get(name) ?? [];
    this.handlers.set(
      name,
      list.filter((h) => h !== (handler as EventHandler)),
    );
  }

  async publish<T = Record<string, unknown>>(
    name: DomainEventName,
    payload: T,
    opts: { correlationId: CorrelationId; projectId?: string } = {
      correlationId: generateCorrelationId(),
    },
  ): Promise<void> {
    const event: DomainEvent<T> = {
      id: randomUUID(),
      name,
      correlationId: opts.correlationId,
      projectId: opts.projectId,
      payload,
      timestamp: new Date().toISOString(),
    };
    const list = this.handlers.get(name) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typedEvent = event as any;
    for (const handler of list) {
      try {
        await handler(typedEvent);
      } catch (err) {
        logger.error(`event handler for ${name} failed`, {
          eventId: event.id,
          err: String(err),
        });
      }
    }
  }
}

export const eventBus = new EventBus();

export function generateCorrelationId(): CorrelationId {
  return `corr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
