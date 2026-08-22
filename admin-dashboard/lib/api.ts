const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:8081';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? '';

export async function cpFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CONTROL_PLANE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Control plane ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface Overview {
  users_total: string | number;
  users_active: string | number;
  engines_running: string | number;
  engines_error: string | number;
  subs_active: string | number;
  pnl_total: string | number;
}

export interface UserRow {
  id: string;
  telegram_id: string | number;
  telegram_username: string | null;
  status: string;
  plan_id: string | null;
  plan_name: string | null;
  engine_status: string | null;
  pnl_total: string | number | null;
  daily_entries_used: string | number | null;
}
