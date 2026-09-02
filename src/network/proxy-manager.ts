/**
 * Proxy & network layer — personal-use stub.
 *
 * The advanced Crash build has a full residential/ISP proxy pool
 * manager with sticky sessions, Webshare-style pool parsing, and
 * per-request rotation. In personal use, the operator may optionally
 * configure a single HTTP/SOCKS5 proxy via env vars:
 *
 *   PROXY_URL=http://user:pass@host:port
 *   PROXY_URL=socks5://user:pass@host:port
 *
 * This stub preserves the ResolvedProxy interface so browser/manager.ts
 * can import it. If no proxy is configured, it returns null (direct
 * connection).
 */

export interface ResolvedProxy {
  server: string;
  username?: string;
  password?: string;
  stickySessionId?: string;
  poolIndex?: number;
}

export function parseProxyEndpoint(raw: string): ResolvedProxy | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const resolved: ResolvedProxy = {
      server: `${url.protocol}//${url.host}`,
    };
    if (url.username) resolved.username = decodeURIComponent(url.username);
    if (url.password) resolved.password = decodeURIComponent(url.password);
    return resolved;
  } catch {
    // host:port:user:pass format
    const parts = raw.split(':');
    if (parts.length >= 2) {
      const [host, port, user, pass] = parts;
      const resolved: ResolvedProxy = {
        server: `http://${host}:${port}`,
      };
      if (user) resolved.username = user;
      if (pass) resolved.password = pass;
      return resolved;
    }
    return null;
  }
}

/** Resolve the proxy for the current request. In personal use, there is
 *  no pool — a single proxy from PROXY_URL env var is returned (or null
 *  for direct connection). */
export function resolveProxy(_opts?: { sessionId?: string }): ResolvedProxy | null {
  const raw = process.env.PROXY_URL;
  if (!raw) return null;
  return parseProxyEndpoint(raw);
}

/** Personal-use: no proxy pool. */
export class ProxyPool {
  private endpoints: ResolvedProxy[] = [];
  private cursor = 0;

  loadFromConfig(_endpoints: string[] | undefined): void {
    // No-op in personal use
  }

  size(): number {
    return this.endpoints.length;
  }

  next(): ResolvedProxy | null {
    if (this.endpoints.length === 0) return resolveProxy();
    const proxy = this.endpoints[this.cursor % this.endpoints.length];
    this.cursor++;
    return proxy;
  }
}

/** Personal-use: single-proxy manager. */
export class ProxyManager {
  private pool = new ProxyPool();

  loadFromConfig(endpoints: string[] | undefined): void {
    this.pool.loadFromConfig(endpoints);
  }

  resolve(opts?: { sessionId?: string }): ResolvedProxy | null {
    return this.pool.next() ?? resolveProxy(opts);
  }
}
