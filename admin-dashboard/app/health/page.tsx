import { cpFetch } from '@/lib/api';

interface AuditLog {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_user_id: string | null;
  created_at: string;
}

export default async function HealthPage() {
  let logs: AuditLog[] = [];
  let error: string | null = null;
  try {
    const data = await cpFetch<{ logs: AuditLog[] }>('/admin/audit');
    logs = data.logs ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Health & audit</h1>
      {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      <p style={{ color: '#9ca3af', fontSize: 14 }}>
        Control plane runs a 60s health sweep (stale heartbeats → restart). Audit log is append-only.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
            <th style={{ padding: 8 }}>Time</th>
            <th style={{ padding: 8 }}>Actor</th>
            <th style={{ padding: 8 }}>Action</th>
            <th style={{ padding: 8 }}>Target</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id} style={{ borderTop: '1px solid #1f2937' }}>
              <td style={{ padding: 8 }}>{new Date(l.created_at).toLocaleString()}</td>
              <td style={{ padding: 8 }}>
                {l.actor_type}
                {l.actor_id ? `:${l.actor_id}` : ''}
              </td>
              <td style={{ padding: 8 }}>{l.action}</td>
              <td style={{ padding: 8 }}>{l.target_user_id ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {logs.length === 0 && !error && <p>No audit events.</p>}
    </div>
  );
}
