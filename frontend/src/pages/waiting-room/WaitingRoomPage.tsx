import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { clearDemoTicket, joinQueue, type QueueClient } from './queue';
import type { Concert, QueueStatus } from './types';
import './waiting-room.css';

const POLL_MS = 5_000;

type ConcertState =
  | { kind: 'loading' }
  | { kind: 'ready'; concert: Concert }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const count = (n: number) => n.toLocaleString('en-SG');

/** Re-renders every `ms` so countdowns and "updated Xs ago" stay current. */
function useNow(ms = 1_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function useConcert(concertId: string) {
  const [state, setState] = useState<ConcertState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    api<Concert>(`/api/concerts/${encodeURIComponent(concertId)}`)
      .then((concert) => !cancelled && setState({ kind: 'ready', concert }))
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) setState({ kind: 'not-found' });
        else setState({ kind: 'error', message: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [concertId]);
  return state;
}

/** Joins once, then polls the status until the fan is admitted or their window expires. */
function useQueue(concertId: string, userId: string, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<QueueClient['mode'] | null>(null);
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [startAhead, setStartAhead] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(null);
    setStartAhead(null);
    setError(null);

    const poll = async (client: QueueClient) => {
      try {
        const next = await client.status();
        if (cancelled) return;
        setStatus(next);
        setStartAhead((prev) => prev ?? next.peopleAhead);
        setUpdatedAt(Date.now());
        setError(null);
        if (next.state === 'admitted' || next.state === 'expired') return;
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
      timer = setTimeout(() => poll(client), POLL_MS);
    };

    joinQueue(concertId, userId)
      .then((client) => {
        if (cancelled) return;
        setMode(client.mode);
        void poll(client);
      })
      .catch((e) => !cancelled && setError((e as Error).message));

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [concertId, userId, enabled, attempt]);

  const rejoin = () => {
    clearDemoTicket(concertId, userId);
    setAttempt((a) => a + 1);
  };

  return { mode, status, startAhead, updatedAt, error, rejoin };
}

export function WaitingRoomPage() {
  const { concertId = '' } = useParams();
  const { session } = useAuth();
  const concertState = useConcert(concertId);
  const queue = useQueue(concertId, session?.userId ?? '', concertState.kind === 'ready');
  const now = useNow();

  if (concertState.kind === 'loading') return <div className="wr-card glass wr-skeleton" />;
  if (concertState.kind === 'not-found' || concertState.kind === 'error') {
    return (
      <section className="card">
        <h1>{concertState.kind === 'not-found' ? 'Concert not found' : "Couldn't load this concert"}</h1>
        {concertState.kind === 'error' && <p className="muted">{concertState.message}</p>}
        <div className="row">
          <Link to="/" className="btn">
            Back to concerts
          </Link>
        </div>
      </section>
    );
  }

  const { concert } = concertState;
  const saleUpcoming = now < Date.parse(concert.saleStartsAt);

  return (
    <>
      <Link to={`/concerts/${concert.id}`} className="wr-back">
        ‹ Back to concert
      </Link>

      <section className="wr-card glass">
        <header className="wr-head">
          <p className="eyebrow">Waiting room · {concert.artist}</p>
          <h1>{concert.title}</h1>
          <p className="muted">
            {dateTime(concert.startsAt)} · {concert.venueName}
          </p>
        </header>

        <QueuePanel concertId={concert.id} queue={queue} now={now} />

        {saleUpcoming && queue.status?.state !== 'admitted' && (
          <p className="wr-note">
            Tickets go on sale {dateTime(concert.saleStartsAt)}. You're in line early and will keep your place.
          </p>
        )}
        {queue.error && queue.status && <p className="wr-note bad">Lost connection, retrying… ({queue.error})</p>}
      </section>

      {queue.mode === 'demo' && (
        <p className="wr-demo">
          <strong>Demo mode.</strong> <code>/api/waiting-room</code> isn't built yet, so this queue is simulated in your
          browser and starts moving straight away.
        </p>
      )}

      <section className="wr-tips glass">
        <h2>While you wait</h2>
        <ul>
          <li>
            <strong>Keep this tab open.</strong> Your place is tied to your account, so refreshing won't lose it.
          </li>
          <li>
            <strong>Be ready.</strong> When it's your turn you'll have 10 minutes to choose seats and check out.
          </li>
        </ul>
      </section>
    </>
  );
}

function QueuePanel({ concertId, queue, now }: { concertId: string; queue: ReturnType<typeof useQueue>; now: number }) {
  const { status, error, startAhead, rejoin } = queue;

  if (!status) {
    if (error) {
      return (
        <div className="wr-panel">
          <p className="wr-title">Couldn't join the queue</p>
          <p className="muted">{error}</p>
          <button type="button" onClick={rejoin}>
            Try again
          </button>
        </div>
      );
    }
    return <Joining label="Joining the queue…" />;
  }

  if (status.state === 'pending') return <Joining label="Assigning your queue number…" />;

  if (status.state === 'admitted') {
    const left = Math.max(0, Date.parse(status.admittedUntil ?? '') - now);
    return (
      <div className="wr-panel wr-admitted">
        <p className="wr-label">Queue number #{count(status.position ?? 0)}</p>
        <p className="wr-title">It's your turn!</p>
        <p className="muted">
          Your spot is held for <strong className="wr-countdown">{clock(left)}</strong>. Choose your seats before it runs out.
        </p>
        <Link to={`/concerts/${concertId}/checkout`} className="btn wr-cta">
          Continue to seat selection
        </Link>
      </div>
    );
  }

  if (status.state === 'expired') {
    return (
      <div className="wr-panel">
        <p className="wr-title">Your turn has expired</p>
        <p className="muted">You didn't start checkout within 10 minutes, so your spot went to the next fan.</p>
        <button type="button" onClick={rejoin}>
          Rejoin the queue
        </button>
      </div>
    );
  }

  const ahead = status.peopleAhead ?? 0;
  const progress = startAhead ? Math.min(1, 1 - ahead / startAhead) : 0;

  return (
    <div className="wr-panel">
      <div className="wr-panel-top">
        <p className="wr-label">Your queue number</p>
        <span className="wr-live">Live</span>
      </div>
      <p className="wr-number">#{count(status.position ?? 0)}</p>
      <p className="wr-ahead">
        <strong>{count(ahead)}</strong> {ahead === 1 ? 'person' : 'people'} ahead of you
      </p>

      <div
        className="wr-progress"
        role="progressbar"
        aria-label="Progress through the queue"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <span style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

function Joining({ label }: { label: string }) {
  return (
    <div className="wr-panel wr-joining" role="status">
      <span className="wr-spinner" aria-hidden="true" />
      <p className="wr-title">{label}</p>
      <p className="muted">This only takes a moment. Please don't close this tab.</p>
    </div>
  );
}

function clock(ms: number) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
