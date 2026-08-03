import { type FormEvent, type ReactNode, useEffect, useState } from 'react';

type AccessState = 'checking' | 'open' | 'locked';

export default function DemoAccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccessState>('checking');
  const [accessCode, setAccessCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/demo-auth/status', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('status unavailable');
        return response.json() as Promise<{ enabled?: boolean; authenticated?: boolean }>;
      })
      .then((status) => {
        if (!cancelled) setState(!status.enabled || status.authenticated ? 'open' : 'locked');
      })
      .catch(() => {
        if (!cancelled) setState('locked');
      });
    return () => { cancelled = true; };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/demo-auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessCode }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '访问失败。');
      setAccessCode('');
      setState('open');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '访问失败。');
    } finally {
      setSubmitting(false);
    }
  };

  if (state === 'open') return children;

  return (
    <main className="demo-access-shell">
      <section className="demo-access-panel" aria-busy={state === 'checking'}>
        <div className="demo-access-mark" aria-hidden="true">M</div>
        <p className="demo-access-eyebrow">Muse Mirror</p>
        <h1>{state === 'checking' ? '正在打开团队演示' : '团队演示'}</h1>
        {state === 'checking' ? (
          <p className="demo-access-copy">正在确认访问状态...</p>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="team-demo-access-code">团队访问码</label>
            <input
              id="team-demo-access-code"
              type="password"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
            {error && <p className="demo-access-error" role="alert">{error}</p>}
            <button type="submit" disabled={submitting || !accessCode}>
              {submitting ? '正在验证...' : '进入 Muse Mirror'}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
