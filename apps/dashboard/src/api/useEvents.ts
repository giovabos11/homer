import { useEffect, useRef } from 'react';
import type { SseEvent } from '@shared';
import { IS_MOCK } from './client';
import { mockBus, startSimulation } from './mock/mockApi';
import { useStore } from '@/store/useStore';

const EVENT_TYPES: SseEvent['type'][] = [
  'job.discovered',
  'job.scored',
  'application.updated',
  'queue.updated',
  'queue.snapshot',
  'task.needs_human',
  'email.received',
  'outbox.updated',
  'connection.updated',
  'schedule.updated',
  'ask.delta',
  'toast',
];

/**
 * Live event stream. Real mode: EventSource on /api/events with auto-reconnect
 * (native retry + a hard reopen on stall) and a data refresh on every (re)connect,
 * since the server replays queue.snapshot + connections on connect but not the rest.
 * Mock mode: subscribes to the in-process mock bus and starts the ambient simulation.
 */
export function useEvents(): void {
  const applyEvent = useStore((s) => s.applyEvent);
  const setSseConnected = useStore((s) => s.setSseConnected);
  const loadAll = useStore((s) => s.loadAll);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (IS_MOCK) {
      startSimulation();
      setSseConnected(true);
      const off = mockBus.on((e) => applyEvent(e));
      return () => {
        off();
        startedRef.current = false;
      };
    }

    let es: EventSource | null = null;
    let closed = false;
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;
    let firstConnect = true;
    let lastSeenAt = Date.now();

    const open = () => {
      if (closed) return;
      es = new EventSource('/api/events');
      lastSeenAt = Date.now();

      es.onopen = () => {
        lastSeenAt = Date.now();
        setSseConnected(true);
        // re-sync everything the snapshot doesn't cover after a reconnect
        if (!firstConnect) void loadAll();
        firstConnect = false;
      };

      es.onerror = () => {
        setSseConnected(false);
        // EventSource retries on its own; if the connection object died
        // completely (readyState CLOSED) recreate it with backoff.
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          if (reopenTimer) clearTimeout(reopenTimer);
          reopenTimer = setTimeout(open, 3000);
        }
      };

      // Server heartbeat (every 15 s) — only feeds the stall watchdog.
      es.addEventListener('ping', () => {
        lastSeenAt = Date.now();
      });

      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (raw) => {
          lastSeenAt = Date.now();
          try {
            const data = JSON.parse((raw as MessageEvent).data) as Record<string, unknown>;
            applyEvent({ ...data, type } as SseEvent);
          } catch {
            /* malformed event — ignore */
          }
        });
      }
    };

    // Stall watchdog: a proxy (e.g. Vite dev) can keep the client socket open
    // after the server dies, so EventSource never errors. No heartbeat for
    // >40 s ⇒ the stream is dead: drop it and reconnect through the normal
    // backoff path, which also flips the UI to "Reconnecting…".
    const watchdog = setInterval(() => {
      if (closed || !es || es.readyState !== EventSource.OPEN) return;
      if (Date.now() - lastSeenAt > 40000) {
        setSseConnected(false);
        es.close();
        if (reopenTimer) clearTimeout(reopenTimer);
        reopenTimer = setTimeout(open, 1000);
      }
    }, 5000);

    open();
    return () => {
      closed = true;
      startedRef.current = false;
      clearInterval(watchdog);
      if (reopenTimer) clearTimeout(reopenTimer);
      es?.close();
      setSseConnected(false);
    };
  }, [applyEvent, setSseConnected, loadAll]);
}
