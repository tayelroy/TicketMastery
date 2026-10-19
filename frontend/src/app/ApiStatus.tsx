import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface Health {
  status: string;
  db: string;
  version?: string;
}

/** Footer badge that calls GET /health, so you can see at a glance whether the API (and its DB) is reachable. */
export function ApiStatus() {
  const [state, setState] = useState<'checking' | 'ok' | 'down'>('checking');
  const [version, setVersion] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    api<Health>('/health')
      .then((h) => {
        if (cancelled) return;
        setState(h.status === 'ok' ? 'ok' : 'down');
        setVersion(h.version);
      })
      .catch(() => !cancelled && setState('down'));
    return () => {
      cancelled = true;
    };
  }, []);

  const label = { checking: 'checking API…', ok: `API ok${version ? ` (${version})` : ''}`, down: 'API unreachable' }[
    state
  ];
  return <span className={`status status-${state}`}>{label}</span>;
}
