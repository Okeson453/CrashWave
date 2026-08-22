import { cpFetch, UserRow } from '@/lib/api';

export default async function UsersPage() {
  let users: UserRow[] = [];
  let error: string | null = null;
  try {
    const data = await cpFetch<{ users: UserRow[] }>('/admin/users');
    users = data.users ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Users</h1>
      {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#9ca3af' }}>
              <th style={th}>Telegram</th>
              <th style={th}>Status</th>
              <th style={th}>Plan</th>
              <th style={th}>Engine</th>
              <th style={th}>Daily</th>
              <th style={th}>PnL</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: '1px solid #1f2937' }}>
                <td style={td}>
                  @{u.telegram_username ?? '—'}
                  <div style={{ color: '#6b7280', fontSize: 12 }}>{String(u.telegram_id)}</div>
                </td>
                <td style={td}>{u.status}</td>
                <td style={td}>{u.plan_name ?? '—'}</td>
                <td style={td}>{u.engine_status ?? '—'}</td>
                <td style={td}>{String(u.daily_entries_used ?? 0)}</td>
                <td style={td}>{String(u.pnl_total ?? 0)}</td>
                <td style={td}>
                  <form
                    action={`/api/proxy?path=/admin/provision/${u.id}&method=POST`}
                    method="post"
                    style={{ display: 'inline' }}
                  >
                    <button type="submit" style={smallBtn}>
                      Provision
                    </button>
                  </form>{' '}
                  <form
                    action={`/api/proxy?path=/admin/destroy/${u.id}&method=POST`}
                    method="post"
                    style={{ display: 'inline' }}
                  >
                    <button type="submit" style={smallBtnDanger}>
                      Destroy
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && !error && <p>No users yet.</p>}
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 10px' };
const td: React.CSSProperties = { padding: '10px', verticalAlign: 'top' };
const smallBtn: React.CSSProperties = {
  background: '#1d4ed8',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  padding: '4px 8px',
  cursor: 'pointer',
  fontSize: 12,
};
const smallBtnDanger: React.CSSProperties = { ...smallBtn, background: '#b91c1c' };
