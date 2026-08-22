import type { ReactNode } from 'react';

export const metadata = {
  title: 'BC Crash — Admin',
  description: 'Multi-tenant control plane dashboard',
};

const nav = [
  { href: '/', label: 'Overview' },
  { href: '/users', label: 'Users' },
  { href: '/instances', label: 'Engines' },
  { href: '/billing', label: 'Billing' },
  { href: '/health', label: 'Health / Audit' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
          background: '#0b1220',
          color: '#e8eefc',
          minHeight: '100vh',
        }}
      >
        <header
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            padding: '12px 20px',
            borderBottom: '1px solid #1e2a44',
            background: '#0f172a',
          }}
        >
          <strong style={{ letterSpacing: 0.3 }}>BC Crash Admin</strong>
          <nav style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {nav.map((n) => (
              <a
                key={n.href}
                href={n.href}
                style={{ color: '#93c5fd', textDecoration: 'none', fontSize: 14 }}
              >
                {n.label}
              </a>
            ))}
          </nav>
        </header>
        <main style={{ padding: 20, maxWidth: 1100, margin: '0 auto' }}>{children}</main>
      </body>
    </html>
  );
}
