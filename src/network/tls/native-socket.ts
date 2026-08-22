/**
 * Native Socket Worker — Latency-Compensated Execution
 * Isolates WS/TCP I/O into a Worker thread so main-thread GC
 * cannot delay cash-out frames. Uses hrtime RTT + pre-send.
 */
import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { getLogger } from '../../observability/logger';
import type { Ja4Profile } from './ja4-fingerprint';

const logger = () => getLogger().child({ component: 'NativeSocket' });

export interface SocketWorkerConfig {
  url: string;
  headers: Record<string, string>;
  ja4Profile: Ja4Profile;
  noDelay?: boolean;
  sendBufferSize?: number;
  recvBufferSize?: number;
  heartbeatIntervalMs?: number;
}

export interface PreSendParams {
  currentMultiplier: number;
  multiplierVelocity: number;
  targetMultiplier: number;
  rttP99Ms: number;
  safetyMarginMs?: number;
}

export function computeTriggerMultiplier(p: PreSendParams): number {
  const safety = p.safetyMarginMs ?? 15;
  const leadTimeSec = (p.rttP99Ms + safety) / 1000;
  const compensation = p.multiplierVelocity * leadTimeSec;
  const trigger = p.targetMultiplier - compensation;
  return Math.max(1.01, Math.round(trigger * 10000) / 10000);
}

export class RttEstimator {
  private samples: number[] = [];
  constructor(private maxSamples = 64) {}
  record(rttMs: number): void {
    this.samples.push(rttMs);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }
  p99(): number {
    if (!this.samples.length) return 80;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(s.length * 0.99) - 1)]!;
  }
  p50(): number {
    if (!this.samples.length) return 40;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }
}

export class NativeSocketWorker extends EventEmitter {
  private worker: Worker | null = null;
  private readonly config: SocketWorkerConfig;
  private readonly rtt = new RttEstimator();
  private connected = false;

  constructor(config: SocketWorkerConfig) {
    super();
    this.config = {
      noDelay: true,
      sendBufferSize: 256 * 1024,
      recvBufferSize: 256 * 1024,
      heartbeatIntervalMs: 15_000,
      ...config,
    };
  }

  get rttP99Ms(): number { return this.rtt.p99(); }
  get isConnected(): boolean { return this.connected; }

  async start(): Promise<void> {
    if (this.worker) return;
    const workerSource = `
      const { parentPort, workerData } = require('worker_threads');
      const WebSocket = require('ws');
      let ws = null, heartbeatTimer = null, lastPingNs = null;
      function applyOpts(s) {
        try {
          if (s && s.setNoDelay) s.setNoDelay(!!workerData.noDelay);
        } catch (_) {}
      }
      parentPort.on('message', (cmd) => {
        if (cmd.type === 'connect') {
          if (ws) try { ws.close(); } catch(_){}
          ws = new WebSocket(cmd.url, { headers: cmd.headers, perMessageDeflate: false, handshakeTimeout: 10000 });
          ws.on('open', () => {
            if (ws._socket) applyOpts(ws._socket);
            parentPort.postMessage({ type: 'open' });
            if (workerData.heartbeatIntervalMs > 0) {
              heartbeatTimer = setInterval(() => {
                if (ws && ws.readyState === 1) {
                  lastPingNs = process.hrtime.bigint();
                  ws.ping();
                }
              }, workerData.heartbeatIntervalMs);
            }
          });
          ws.on('message', (d) => parentPort.postMessage({ type: 'message', data: d.toString() }));
          ws.on('pong', () => {
            if (lastPingNs) {
              const rttMs = Number(process.hrtime.bigint() - lastPingNs) / 1e6;
              parentPort.postMessage({ type: 'pong', rttMs });
            }
          });
          ws.on('close', (c, r) => {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            parentPort.postMessage({ type: 'close', code: c, reason: (r||'').toString() });
          });
          ws.on('error', (e) => parentPort.postMessage({ type: 'error', message: e.message }));
        } else if (cmd.type === 'send') {
          if (!ws || ws.readyState !== 1) {
            parentPort.postMessage({ type: 'error', message: 'socket not open' });
            return;
          }
          const sentAtNs = process.hrtime.bigint().toString();
          ws.send(cmd.payload, (err) => {
            if (err) parentPort.postMessage({ type: 'error', message: err.message });
            else parentPort.postMessage({ type: 'sent', id: cmd.id, sentAtNs });
          });
        } else if (cmd.type === 'close') {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          if (ws) ws.close();
        }
      });
    `;
    this.worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        noDelay: this.config.noDelay,
        sendBufferSize: this.config.sendBufferSize,
        recvBufferSize: this.config.recvBufferSize,
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      },
    });
    this.worker.on('message', (ev: any) => {
      if (ev.type === 'open') { this.connected = true; this.emit('open'); }
      else if (ev.type === 'message') this.emit('message', ev.data);
      else if (ev.type === 'close') { this.connected = false; this.emit('close', ev.code, ev.reason); }
      else if (ev.type === 'error') this.emit('error', new Error(ev.message));
      else if (ev.type === 'sent') this.emit('sent', ev.id);
      else if (ev.type === 'pong') { this.rtt.record(ev.rttMs); this.emit('pong', ev.rttMs); }
    });
    this.worker.on('error', (err) => {
      logger().error({ err }, 'Socket worker crashed');
      this.connected = false;
      this.emit('error', err);
    });
    this.worker.postMessage({ type: 'connect', url: this.config.url, headers: this.config.headers });
  }

  send(payload: string | Buffer, id?: string): string {
    const cmdId = id ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!this.worker) throw new Error('NativeSocketWorker not started');
    this.worker.postMessage({ type: 'send', payload, id: cmdId });
    return cmdId;
  }

  scheduleCashOut(
    payloadFactory: (triggerM: number) => string | Buffer,
    params: Omit<PreSendParams, 'rttP99Ms'>,
  ): { triggerMultiplier: number; commandId: string } {
    const rttP99Ms = this.rtt.p99();
    const triggerMultiplier = computeTriggerMultiplier({ ...params, rttP99Ms });
    const payload = payloadFactory(triggerMultiplier);
    const commandId = this.send(payload);
    logger().debug({ triggerMultiplier, rttP99Ms, target: params.targetMultiplier }, 'Latency-compensated cash-out');
    return { triggerMultiplier, commandId };
  }

  async stop(): Promise<void> {
    if (this.worker) {
      this.worker.postMessage({ type: 'close' });
      await this.worker.terminate();
      this.worker = null;
      this.connected = false;
    }
  }
}
