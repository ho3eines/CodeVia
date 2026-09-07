/**
 * Lightweight realtime broadcaster. The HTTP layer attaches a Socket.io server
 * to `live.bind`. Agents/tools push run/step updates here; the UI consumes them
 * over a WebSocket without exposing chain-of-thought (only action/status/tool).
 *
 * This is the "Real-Time Communication" seam — swappable for the equivalent
 * SignalR-style channel. It deliberately publishes only status + step + result,
 * never model CoT.
 *
 * Security (A03): every event is project-scoped. The Socket.io layer routes
 * each event to the room of its project (`project:<id>`), and only sockets
 * that subscribed to a project they may access join that room — so a client
 * can never receive another tenant's live events. `projectId` is therefore a
 * required field (enforced by the compiler at every emit site).
 */
export type LiveEvent =
  | { type: "run.updated"; runId: string; projectId: string; data: Record<string, unknown> }
  | { type: "step.updated"; runId: string; projectId: string; data: Record<string, unknown> }
  | { type: "notification"; projectId: string; data: Record<string, unknown> }
  | { type: "task.updated"; taskId: string; projectId: string; data: Record<string, unknown> };

interface Emitter {
  emit(event: LiveEvent): void;
}

class LiveBus {
  private emitter: Emitter | null = null;

  bind(emitter: Emitter): void {
    this.emitter = emitter;
  }

  emit(event: LiveEvent): void {
    try {
      this.emitter?.emit(event);
    } catch {
      /* ignore */
    }
  }
}

export const live = new LiveBus();
