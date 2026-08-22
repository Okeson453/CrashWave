import { cpFetch } from '@/lib/api';

interface InstanceRow {
  id: string;
  user_id: string;
  status: string;
  mode: string;
  container_id: string | null;
  container_host: string | null;
  daily_entries_used: number;
  pnl_today: string | number;
  pnl_total: string | number;
  last_heartbeat: string | null;
  telegram_username: string | null;
  telegram_id: string | number;
  user_status: string;
}

export default async function InstancesPage() {
  let rows: InstanceRow[] = [];
  let error: string | null = null;
  try {
    const data = await cpFetch<{ instances: InstanceRow[] }>('/admin/instances');
    rows = data.instances ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Engines</h1>
      {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      <div style={{ display: 'grid', gap: 12 }}>
        {rows.map((r) => (
          <div
            key={r.id}
            style={{
              background: '#111827',
              border: '1px solid #1f2937',
              borderRadius: 10,
              padding: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <strong>@{r.telegram_username ?? r.telegram_id}</strong>
                <span style={{ color: '#9ca3af', marginLeft: 8 }}>{r.status}</span>
              </div>
              <span style={{ color: '#93c5fd' }}>{r.mode}</span>
            </div>
            <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 8 }}>
              host: {r.container_host ?? '—'} · daily {r.daily_entries_used} · PnL today{' '}
              {String(r.pnl_today)} · total {String(r.pnl_total)}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
              heartbeat: {r.last_heartbeat ?? 'never'}
            </div>
          </div>
        ))}
        {rows.length === 0 && !error && <p>No instances.</p>}
      </div>
    </div>
  );
}
