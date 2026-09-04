/**
 * Lightweight realtime broadcaster. The HTTP layer attaches a Socket.io server
 * to `live.bind`. Agents/tools push run/step updates here; the UI consumes them
 * over a WebSocket without exposing chain-of-thought (only action/status/tool).
 *
 * This is the "Real-Time Communication" seam — swappable for the equivalent
 * SignalR-style channel. It deliberately publishes only status + step + result,
 * never model CoT.
 */
type LiveEvent =
  | { type: "run.updated"; runId: string; data: Record<string, unknown> }
  | { type: "step.updated"; runId: string; data: Record<string, unknown> }
  | { type: "notification"; data: Record<string, unknown> }
  | { type: "task.updated"; taskId: string; data: Record<string, unknown> };

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
