# Analytics & Mathematics

This document describes the mathematical foundations of the analytics and risk engine.

## Hit Rate

The hit rate is the percentage of rounds where the crash point exceeds the cash-out target.

```
Hit Rate = (Number of Wins) / (Total Number of Bets)
```

A win occurs when:
```
crash_point >= cash_out_target
```

## Break-Even Hit Rate

The break-even hit rate is the minimum hit rate required to be profitable given the cash-out target.

For a cash-out target of `T`:
```
Break-Even Hit Rate = 1 / T
```

Example for T = 1.30:
```
Break-Even Hit Rate = 1 / 1.30 = 0.7692 = 76.92%
```

If the actual hit rate exceeds the break-even rate, the strategy is profitable.

## Expected Value (EV)

The expected value per bet:
```
EV = (Hit Rate * Stake * Target) + ((1 - Hit Rate) * -Stake)
EV = Stake * (Hit Rate * Target - 1)
```

For profitable betting:
```
Hit Rate * Target > 1
```

## P&L Calculation

### Win
```
P&L = Stake * (Target - 1)
```

Example: Stake = $700, Target = 1.30
```
P&L = 700 * (1.30 - 1) = 700 * 0.30 = +$210
```

### Loss
```
P&L = -Stake
```

Example: Stake = $700
```
P&L = -$700
```

### Net P&L
```
Net P&L = Sum of all individual bet P&Ls
```

## Drawdown

Drawdown measures the peak-to-trough decline in balance.

```
Drawdown % = (Peak Balance - Current Balance) / Peak Balance * 100
```

Maximum drawdown is the largest drawdown observed over a period.

## Consecutive Losses

The number of consecutive losing bets. Used as a risk indicator.

```
Consecutive Losses = Count of most recent sequential bets where P&L < 0
```

When consecutive losses exceed the threshold (default: 10), betting is paused.

## Kelly Criterion (Reference)

The Kelly Criterion suggests the optimal fraction of bankroll to bet:

```
f* = (p * b - q) / b

Where:
  p = probability of win
  q = probability of loss = 1 - p
  b = net odds received = Target - 1
```

Example: p = 0.80, Target = 1.30
```
b = 0.30
f* = (0.80 * 0.30 - 0.20) / 0.30 = (0.24 - 0.20) / 0.30 = 0.133
```

This suggests betting 13.3% of bankroll. Our fixed stake approach is more conservative.

## Variance and Standard Deviation

Sample variance of P&L:
```
Variance = Sum((P&L_i - Mean P&L)^2) / (n - 1)
Std Dev = sqrt(Variance)
```

Higher variance indicates more volatile results.

## Confidence Intervals

95% confidence interval for hit rate:
```
CI = p +/- 1.96 * sqrt(p * (1 - p) / n)
```

Where:
- p = observed hit rate
- n = number of bets

## Monte Carlo Simulation

For strategy evaluation, we use Monte Carlo simulation:

1. Generate N random crash points from historical distribution
2. Apply betting strategy
3. Calculate P&L for each simulation
4. Aggregate results (mean, percentiles, max drawdown)

This gives a probabilistic view of strategy performance.

## Risk of Ruin

Probability of losing entire bankroll:

```
RoR = ((1 - Edge) / (1 + Edge))^Bankroll

Where:
  Edge = Expected edge per bet (as decimal)
  Bankroll = Number of bets bankroll can sustain
```

With our safeguards (max drawdown, consecutive loss limit, daily entry limit), the practical risk of ruin is minimized.
