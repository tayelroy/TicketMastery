import { api, ApiError } from '../../api/client';
import type { QueueStatus } from './types';

/** Fans the queue-manager admits per minute (EventBridge Scheduler batch). */
export const ADMIT_PER_MINUTE = 500;
/** How long an admitted fan has to start checkout. */
export const ADMISSION_WINDOW_MS = 10 * 60_000;

export interface QueueClient {
  /** 'demo' while the API still returns 501 not_implemented. */
  mode: 'live' | 'demo';
  status(): Promise<QueueStatus>;
}

/** Joins the queue (idempotent per user + concert) and returns a client for polling the status. */
export async function joinQueue(concertId: string, userId: string): Promise<QueueClient> {
  const base = `/api/waiting-room/${encodeURIComponent(concertId)}`;
  try {
    await api(`${base}/join`, { method: 'POST' });
    return { mode: 'live', status: () => api<QueueStatus>(`${base}/status`) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 501) return demoQueue(concertId, userId);
    throw e;
  }
}

// ---------- Demo mode: simulates the queue in the browser until the API exists ----------

interface DemoTicket {
  position: number;
  joinedAt: number;
}

/** Simulated delay before queue-manager assigns a number. */
const DEMO_ASSIGN_MS = 2_000;

const demoKey = (concertId: string, userId: string) => `tm.demoQueue.${concertId}.${userId}`;

export function clearDemoTicket(concertId: string, userId: string) {
  try {
    sessionStorage.removeItem(demoKey(concertId, userId));
  } catch {
    // Storage blocked; nothing to clear.
  }
}

function loadDemoTicket(key: string): DemoTicket {
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return JSON.parse(saved) as DemoTicket;
  } catch {
    // Storage blocked or corrupt; start a fresh ticket.
  }
  const ticket = { position: 800 + Math.floor(Math.random() * 700), joinedAt: Date.now() };
  try {
    sessionStorage.setItem(key, JSON.stringify(ticket));
  } catch {
    // The place just won't survive a reload.
  }
  return ticket;
}

function demoQueue(concertId: string, userId: string): QueueClient {
  const ticket = loadDemoTicket(demoKey(concertId, userId));
  return {
    mode: 'demo',
    async status() {
      const elapsed = Date.now() - ticket.joinedAt - DEMO_ASSIGN_MS;
      if (elapsed < 0) return { state: 'pending', position: null, peopleAhead: null, admittedUntil: null };

      const admitted = Math.floor((elapsed / 60_000) * ADMIT_PER_MINUTE);
      const peopleAhead = Math.max(0, ticket.position - 1 - admitted);
      if (peopleAhead > 0) return { state: 'waiting', position: ticket.position, peopleAhead, admittedUntil: null };

      const admittedAt = ticket.joinedAt + DEMO_ASSIGN_MS + ((ticket.position - 1) / ADMIT_PER_MINUTE) * 60_000;
      const admittedUntil = admittedAt + ADMISSION_WINDOW_MS;
      return {
        state: Date.now() > admittedUntil ? 'expired' : 'admitted',
        position: ticket.position,
        peopleAhead: 0,
        admittedUntil: new Date(admittedUntil).toISOString(),
      };
    },
  };
}
