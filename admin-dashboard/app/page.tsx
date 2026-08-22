import { cpFetch, Overview } from '@/lib/api';

export default async function OverviewPage() {
  let data: Overview | null = null;
  let error: string | null = null;
  try {
    data = await cpFetch<Overview>('/admin/overview');
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const cards = data
    ? [
        { label: 'Users', value: data.users_total },
        { label: 'Active users', value: data.users_active },
        { label: 'Engines running', value: data.engines_running },
        { label: 'Engines error', value: data.engines_error },
        { label: 'Active subs', value: data.subs_active },
        { label: 'PnL total', value: data.pnl_total },
      ]
    : [];

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Platform overview</h1>
      {error && (
        <p style={{ color: '#fca5a5' }}>
          Cannot reach control plane. Set CONTROL_PLANE_URL and ADMIN_API_TOKEN.{' '}
          <code>{error}</code>
        </p>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 12,
        }}
      >
        {cards.map((c) => (
          <div
            key={c.label}
            style={{
              background: '#111827',
              border: '1px solid #1f2937',
              borderRadius: 10,
              padding: 16,
            }}
          >
            <div style={{ color: '#9ca3af', fontSize: 12 }}>{c.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6 }}>{String(c.value)}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24, display: 'flex', gap: 8 }}>
        <form action="/api/proxy?path=/admin/pause-all&method=POST" method="post">
          <button type="submit" style={btnStyle('#7f1d1d')}>
            Global pause
          </button>
        </form>
        <form action="/api/proxy?path=/admin/resume-all&method=POST" method="post">
          <button type="submit" style={btnStyle('#14532d')}>
            Global resume
          </button>
        </form>
      </div>
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: 'white',
    border: 'none',
    borderRadius: 8,
    padding: '8px 14px',
    cursor: 'pointer',
  };
}
