# ACIE v3 — Continuous 1.30× Threshold-Probability Intelligence

## Central question

**P(next crash ≥ 1.30× | sequence, regime, temporal state, historical evidence)**

## Event-driven loop (every crash)

```
NEW CRASH
   → SOL record outcome
   → TPL update sequence + regime
   → PSI re-estimate P(≥1.30) with online ensemble weights
   → Incremental calibration + drift check
   → Strategy evaluate next opportunity
   → ENTRY / SKIP / REDUCED_ENTRY
   → wait for next crash → repeat
```

There is **no** “wait 500 rounds → batch analyze → unlock” gate.

## Adaptation tiers

| Layer | Frequency |
|-------|-----------|
| Sequence state | Every crash |
| Rolling / EWMA probabilities | Every crash |
| Online ensemble weights | Every crash |
| Incremental calibration buckets | Every crash |
| Drift detection | Every crash |
| Heavy SAFE / Evidence batch | Every N crashes (default 50) |
| Full offline retrain | Optional / scheduled (hook) |

## Signal definition

A **signal** is an ACIE-scored 1.30× opportunity that passes the configured **strategy** (and later risk/entitlement).  
It is **not** synonymous with “statistically proven edge.”

## Strategy policies

- `strict` — skip when evidence INSUFFICIENT/DEGRADED  
- `adaptive` (default) — higher bar, still evaluates  
- `frequency_fallback` — baseline P so product can still deliver entries  

Entitlement (100/200 daily caps) sits **after** strategy and is not part of ACIE.

## Usage

```ts
const acie = new ACIEEngine({
  strategyPolicy: { mode: 'adaptive', defaultStake: 700 },
  heavyValidationEvery: 50,
});

// every completed crash:
const { evaluation, online, heavyValidationRan } = acie.onCrash(
  { roundId, crashPoint },
  { dailyEntriesUsed, dailyEntriesLimit, balance }
);

if (evaluation.signal) {
  // → RiskEngine → BetExecutor
}
```

## Modules

`src/prediction/acie/` — `engine`, `online-state`, `sol`, `tpl`, `psi`, `safe`, `evidence`, `strategy`, `entitlement`.
