/**
 * Wires RoundObserver / orchestrator events → EntryDecisionService → DryRunController.
 *
 * Personal-use adaptation: in the original Crash implementation, the bridge
 * reached into SessionSupervisor for the live session, the dry-run controller,
 * and the state. In the personal-use build, the SessionSupervisor only exists
 * for live-mode browser session management; for dry-run (the default) it adds
 * no value. So this bridge takes the dry-run controller and risk-state
 * provider directly, and reads session state from the runtime closure in
 * composition.ts.
 *
 * Wires three things:
 *
 *   1. onRoundStartedForDryRun   — invoked by the orchestrator when a new
 *      round begins. Builds a feature snapshot, runs the EntryDecisionService,
 *      and (if the decision is ENTER) calls dryRunController.evaluateAndSimulate
 *      to open a virtual trade.
 *
 *   2. onRoundCrashedForDryRun   — invoked by the orchestrator when a round
 *      ends. Calls dryRunController.onRoundCompleted(roundId, crashPoint) so
 *      the virtual ledger resolves the trade as WIN or LOSS, and pushes the
 *      crash point into the EntryDecisionService for ACIE calibration.
 *
 *   3. wireDryRunSignalBridge    — convenience wrapper that subscribes both
 *      handlers to the supplied orchestrator (or, in legacy mode, the
 *      SessionSupervisor.setSignalEvaluator callback).
 */
import type { AppConfig } from '../../config/schema';
import type { EntryDecisionService } from '../../prediction/entry-decision-service';
import type { RiskStateProvider } from '../../betting/risk-state-provider';
import type { DryRunController } from './dry-run-controller';
import { getLogger } from '../../observability/logger';

const logger = getLogger();

export interface DryRunBridgeDeps {
  /** Source-of-truth for mode (`dry-run` vs `observe-only` vs `live`). */
  config: AppConfig;
  /** The dry-run controller that owns the virtual ledger. */
  dryRunController: DryRunController;
  /** Builds a fresh risk input snapshot per round. */
  riskStateProvider: RiskStateProvider;
  /** The prediction / decision service that produces signals. */
  entryDecisionService: EntryDecisionService;
  /** Session id assigned at composition time. */
  sessionId: string;
}

/**
 * Handle a RoundStarted event: evaluate the entry decision and, if ENTER,
 * open a virtual trade on the dry-run controller.
 */
export async function onRoundStartedForDryRun(
  deps: DryRunBridgeDeps,
  roundId: string
): Promise<void> {
  try {
    const mode = String(deps.config.system?.mode ?? 'dry-run').toLowerCase();
    if (mode !== 'dry-run' && mode !== 'observe-only') return;
    if (!deps.dryRunController.isRunning()) return;

    deps.dryRunController.recordPrediction();
    const riskInput = await deps.riskStateProvider.buildFresh();

    const target = Number(deps.config.betting?.cashOutTarget ?? 1.3);

    const result = await deps.entryDecisionService.evaluateEntry({
      roundId,
      sessionId: deps.sessionId,
      decisionTimestamp: new Date().toISOString(),
      riskInput: {
        ...riskInput,
        // Per spec §3.6: dry-run is by definition authless; force
        // sessionAuthenticated: true (the entry-decision service is the
        // only consumer of this field, and it gates on it).
        sessionAuthenticated: true,
        currentBalance: riskInput.currentBalance ?? 10_000,
      },
      target,
    });
    const signal = result.signal;
    if (!signal) return;
    deps.dryRunController.evaluateAndSimulate({
      signalId: signal.predictionId ?? roundId,
      predictionId: signal.predictionId,
      roundId,
      probability: signal.probability,
      confidence: signal.confidence,
      target: signal.target,
      stake: Number(deps.config.betting?.stakePerEntry ?? 700),
    });
  } catch (err) {
    logger.warn(
      { component: 'DryRunBridge', roundId, error: String(err) },
      'Dry-run signal evaluation failed'
    );
  }
}

/**
 * Handle a RoundCrashed event: resolve the virtual trade (WIN/LOSS) and
 * push the crash point into the entry-decision service for ACIE calibration.
 */
export function onRoundCrashedForDryRun(
  deps: DryRunBridgeDeps,
  payload: { roundId?: string; crashPoint?: number }
): void {
  try {
    const rid = String(payload.roundId ?? '');
    const cp = Number(payload.crashPoint ?? 0);
    if (!rid || !Number.isFinite(cp) || cp <= 0) return;
    deps.entryDecisionService.observeCrash(rid, cp);
    deps.dryRunController.onRoundCompleted(rid, cp);
  } catch (e) {
    logger.warn(
      { component: 'DryRunBridge', error: String(e) },
      'Dry-run/ACIE onRoundComplete failed'
    );
  }
}

/**
 * Backwards-compatible entry point for callers (e.g. legacy tests) that
 * still pass a SessionSupervisor-like object. Returns no-op shims that
 * simply call the typed handlers above with a synthesized roundId.
 *
 * @deprecated Use {@link onRoundStartedForDryRun} / {@link onRoundCrashedForDryRun} directly.
 */
export function wireDryRunSignalBridge(opts: {
  // The original signature used SessionSupervisor; we accept the minimal
  // surface area so existing callers compile.
  supervisor?: {
    setSignalEvaluator?: (cb: (roundId: string) => Promise<void>) => void;
    getDryRunController?: () => DryRunController | null | undefined;
    getState?: () => { sessionId?: string | null } | null;
  };
  entryDecisionService: EntryDecisionService;
  riskStateProvider: RiskStateProvider;
  config: AppConfig;
}): void {
  const ctl = opts.supervisor?.getDryRunController?.();
  if (!ctl) {
    logger.debug(
      { component: 'DryRunBridge' },
      'wireDryRunSignalBridge: no dry-run controller on supervisor; bridge inactive'
    );
    return;
  }
  const deps: DryRunBridgeDeps = {
    config: opts.config,
    dryRunController: ctl,
    riskStateProvider: opts.riskStateProvider,
    entryDecisionService: opts.entryDecisionService,
    sessionId: opts.supervisor?.getState?.()?.sessionId ?? 'session-unknown',
  };
  opts.supervisor?.setSignalEvaluator?.(async (roundId: string) => {
    await onRoundStartedForDryRun(deps, roundId);
  });
}
