# Analytics Runbook

Operational guide for interpreting analytics output, responding to alerts, and maintaining the analytics engine.

---

## Table of Contents

1. [Daily Operations](#daily-operations)
2. [Interpreting Metrics](#interpreting-metrics)
3. [Responding to Alerts](#responding-to-alerts)
4. [Telegram Commands](#telegram-commands)
5. [Troubleshooting](#troubleshooting)
6. [Maintenance](#maintenance)

---

## Daily Operations

### Morning Check (Before First Bet)

1. Run `/analytics summary` to review recent performance
2. Check for unresolved anomalies from previous session
3. Verify observation confidence is `high`
4. Confirm balance matches expected value

### During Session (Every 30 Minutes)

1. Run `/analytics today` to monitor daily progress
2. Review any anomaly alerts in Telegram
3. Check latency P95 is under 1000ms
4. Verify cash-out success rate is above 95%

### End of Day (Last Bet or 23:55 UTC)

1. Run `/analytics summary` for final review
2. Run `/analytics drawdown` to check max drawdown
3. Review daily report for trends
4. Export data if needed for external analysis

---

## Interpreting Metrics

### Hit Rate

| Observed | CI vs Break-Even | Interpretation | Action |
|----------|-----------------|----------------|--------|
| > 80% | Lower CI > 76.9% | Statistically profitable | Continue |
| 77-80% | CI contains 76.9% | Inconclusive | Continue, collect more data |
| < 77% | Upper CI < 76.9% | Statistically unprofitable | Switch to dry-run |
| < 75% | Well below BE | Significantly unprofitable | Stop and review |

### Drawdown

| Severity | Max Drawdown | Action |
|----------|-------------|--------|
| none | < 500 | Normal, continue |
| mild | 500-1,499 | Monitor closely |
| moderate | 1,500-3,499 | Consider reducing exposure |
| severe | 3,500-6,999 | Pause and reassess |
| critical | ≥ 7,000 | Stop for the day |

### Cash-Out Success Rate

| Rate | Status | Action |
|------|--------|--------|
| ≥ 99% | Excellent | Continue |
| 97-98% | Good | Monitor |
| 95-96% | Acceptable | Investigate if trend worsens |
| 90-94% | Poor | Pause and investigate |
| < 90% | Critical | Stop immediately |

### Latency

| P95 Latency | Status | Action |
|-------------|--------|--------|
| < 500ms | Healthy | Continue |
| 500-999ms | Stable | Monitor |
| 1000-1999ms | Degraded | Investigate network/browser |
| ≥ 2000ms | Critical | Pause and investigate |

---

## Responding to Alerts

### 🔴 Critical Anomalies

#### Cash-Out Failure Spike
- **Trigger**: Success rate drops below 85%
- **Immediate Action**: Stop all betting
- **Investigation**:
  1. Check browser console for JavaScript errors
  2. Verify WebSocket connection is stable
  3. Check if game UI has changed (button selectors)
  4. Review cash-out latency trend
- **Resolution**: Fix execution pipeline before resuming

#### Balance Mismatch
- **Trigger**: Observed balance differs from expected by > 1%
- **Immediate Action**: Stop betting
- **Investigation**:
  1. Run full reconciliation: compare all bets vs ledger
  2. Check for unrecorded outcomes
  3. Verify no manual bets were placed
- **Resolution**: Fix reconciliation logic, verify data integrity

#### Drawdown Critical
- **Trigger**: Max drawdown exceeds 7,000 or 25% of bankroll
- **Immediate Action**: Stop for the day
- **Investigation**:
  1. Review recent bet history for patterns
  2. Check if hit rate is genuinely below break-even
  3. Verify no execution issues (failed cash-outs)
- **Resolution**: Do not chase losses. Resume next day with same stake.

### 🟡 Moderate Anomalies

#### Hit Rate Drop
- **Trigger**: Hit rate 2.5 sigma below break-even
- **Action**: Switch to dry-run mode
- **Investigation**: Collect 50+ more samples before deciding

#### Latency Spike
- **Trigger**: P95 latency 3 sigma above baseline
- **Action**: Pause and investigate
- **Investigation**: Check network, VPS load, browser performance

#### Losing Streak
- **Trigger**: Loss streak exceeds expected maximum by 2.5 sigma
- **Action**: Consider dry-run mode
- **Note**: This can happen by chance; do not overreact to single streaks

---

## Telegram Commands

### `/analytics summary`
Shows aggregated metrics for the best available window (100 → 50 → 10).

Output includes:
- Entries, wins, losses
- Hit rate with 95% CI
- Net P&L vs expected P&L
- Max and current drawdown
- Cash-out success rate
- Top recommendation

### `/analytics today`
Shows metrics for the current calendar day only.

### `/analytics <window>`
Shows metrics for a specific window:
- `10`, `50`, `100`, `500` — last N entries
- `session` — current session
- `day` — today
- `week` — last 7 days
- `month` — last 30 days
- `all` — all time

### `/analytics drawdown`
Shows detailed drawdown analysis including:
- Max drawdown and current drawdown
- Peak and current equity
- Underwater duration
- Recovery count
- Severity classification

### `/analytics learning`
Shows learning curve with:
- Progressive hit rate as sample size grows
- Confidence interval narrowing
- Trend direction (improving/stable/declining)
- Convergence estimate

---

## Troubleshooting

### "No data available yet"
- Cause: Fewer resolved bets than minimum for window
- Resolution: Wait for more bets or use a smaller window (`/analytics 10`)

### "Insufficient data for window"
- Cause: Window requires more samples than available
- Resolution: Use a smaller window or wait for more data

### Hit rate CI is very wide
- Cause: Small sample size
- Resolution: Collect at least 100 entries for reliable CI

### EV accuracy is very low (< 50%)
- Cause: Execution issues (failed cash-outs, latency)
- Resolution: Check cash-out success rate and latency metrics

### Anomalies keep firing
- Cause: Thresholds may be too sensitive for current conditions
- Resolution: Review anomaly config; consider temporary adjustment

---

## Maintenance

### Weekly
- Review all anomaly flags for patterns
- Check if hit rate CI has narrowed
- Verify latency trends are stable

### Monthly
- Export full dataset for external analysis
- Review learning curve for long-term trends
- Adjust anomaly thresholds if false positive rate is high

### Quarterly
- Re-evaluate stake and target settings based on accumulated data
- Review recommendation engine rules for effectiveness
- Update this runbook based on operational experience

---

## Emergency Procedures

### If Balance Drops Unexpectedly

1. Run `/analytics drawdown` immediately
2. Check for cash-out failure spike
3. Run `/analytics summary` to check hit rate
4. If drawdown is severe or critical: **STOP**
5. Export all data for manual review
6. Do not resume until root cause is identified

### If Telegram Commands Stop Responding

1. Check if analytics engine is running
2. Verify database connection
3. Check logs for errors
4. Restart if necessary; data is persisted in database

### If Hit Rate Appears Manipulated

1. Verify round observations match actual game outcomes
2. Check for duplicate or missing bet records
3. Cross-reference with game history if available
4. Report discrepancy to operator
