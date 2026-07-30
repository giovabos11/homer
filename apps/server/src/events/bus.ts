// SSE event bus. Workers/API emit typed SseEvents; connected dashboard clients receive them.
import type { Response } from 'express';
import type { SseEvent } from '@shared/types';

export class EventBus {
  private clients = new Set<Response>();
  private listeners = new Set<(e: SseEvent) => void>();
  private heartbeat: NodeJS.Timeout | null = null;

  /** Register an SSE client response (headers must already be sent). */
  addClient(res: Response): void {
    this.clients.add(res);
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.ping(), 15000);
      this.heartbeat.unref?.();
    }
    res.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    });
  }

  /** Subscribe in-process (used by tests and the ask endpoint). Returns unsubscribe. */
  subscribe(fn: (e: SseEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: SseEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* listener errors never break the bus */
      }
    }
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** Write an SSE frame to one client only (snapshot on connect). */
  sendTo(res: Response, event: SseEvent): void {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private ping(): void {
    // The comment satisfies the contract heartbeat; the `ping` event makes the
    // heartbeat OBSERVABLE to the browser EventSource API (comments are not),
    // so the dashboard can detect a silently-dead stream (e.g. a dev proxy
    // that keeps the client socket open after the server dies) and reconnect.
    for (const res of this.clients) {
      try {
        res.write(': hb\n\nevent: ping\ndata: {"type":"ping"}\n\n');
      } catch {
        this.clients.delete(res);
      }
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.listeners.clear();
  }
}
