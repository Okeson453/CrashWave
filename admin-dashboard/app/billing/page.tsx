import { cpFetch } from '@/lib/api';

interface Plan {
  id: string;
  name: string;
  priceMonthly: number;
  maxDailyEntries: number;
  fixedStake: number;
  fixedTarget: number;
  allowedModes: string[];
}

export default async function BillingPage() {
  let plans: Plan[] = [];
  let error: string | null = null;
  try {
    const data = await cpFetch<{ plans: Plan[] }>('/admin/plans');
    plans = data.plans ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Plans & billing</h1>
      {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      <p style={{ color: '#9ca3af' }}>
        Stripe webhooks: <code>POST /webhooks/stripe</code> on the control plane. Stake and target
        are plan-locked.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {plans.map((p) => (
          <div
            key={p.id}
            style={{
              background: '#111827',
              border: '1px solid #1f2937',
              borderRadius: 10,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700 }}>{p.name}</div>
            <div style={{ color: '#93c5fd', marginTop: 4 }}>${p.priceMonthly}/mo</div>
            <ul style={{ margin: '12px 0 0', paddingLeft: 18, color: '#d1d5db', fontSize: 13 }}>
              <li>{p.maxDailyEntries} entries/day</li>
              <li>Stake {p.fixedStake}</li>
              <li>Target {p.fixedTarget}x</li>
              <li>Modes: {p.allowedModes?.join(', ')}</li>
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
