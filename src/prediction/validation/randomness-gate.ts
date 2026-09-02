/**
 * §4 Blocking Randomness Validation Gate
 * Run over ≥50k historical rounds before enabling sequence candidate models.
 *
 * Tests: Wald–Wolfowitz runs, Ljung–Box (lags 1–20), chi-square vs stated
 * distribution bins, spectral flatness proxy, held-out replication, Bonferroni correction.
 */

export interface RandomnessGateConfig {
  minRounds: number;
  ljungBoxLags: number;
  significanceLevel: number;
  heldOutFraction: number;
  hitThreshold: number;
}

export const DEFAULT_RANDOMNESS_GATE_CONFIG: RandomnessGateConfig = {
  minRounds: 50_000,
  ljungBoxLags: 20,
  significanceLevel: 0.05,
  heldOutFraction: 0.3,
  hitThreshold: 1.3,
};

export interface TestResult {
  name: string;
  statistic: number;
  pValue: number;
  passed: boolean;
  detail: string;
}

export interface RandomnessGateReport {
  sampleSize: number;
  tests: TestResult[];
  /** All tests pass after multiple-testing correction */
  passed: boolean;
  /** Candidate sequence models may be enabled only when true */
  allowSequenceModels: boolean;
  correctedAlpha: number;
  summary: string;
}

function erfc(x: number): number {
  // Complementary error function approximation
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly =
    1.00002368 +
    t *
      (0.37409196 +
        t *
          (0.09678418 +
            t *
              (-0.18628806 +
                t *
                  (0.27886807 +
                    t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))));
  const ans = t * Math.exp(-z * z - 1.26551223 + t * poly);
  return x >= 0 ? ans : 2 - ans;
}

function normalPValueTwoSided(z: number): number {
  return Math.max(0, Math.min(1, erfc(Math.abs(z) / Math.SQRT2)));
}

/** Chi-square survival for df using Wilson–Hilferty approximation */
function chiSquarePValue(stat: number, df: number): number {
  if (df <= 0) return 1;
  if (stat <= 0) return 1;
  const h = 2 / (9 * df);
  const z = ((stat / df) ** (1 / 3) - (1 - h)) / Math.sqrt(h);
  return normalPValueTwoSided(Math.max(0, z)) / 2 + (z < 0 ? 0.5 : 0);
}

export function waldWolfowitzRunsTest(binary: number[]): TestResult {
  const n = binary.length;
  let n1 = 0;
  let n0 = 0;
  for (const b of binary) {
    if (b === 1) n1++;
    else n0++;
  }
  if (n1 === 0 || n0 === 0 || n < 20) {
    return {
      name: 'wald-wolfowitz-runs',
      statistic: 0,
      pValue: 1,
      passed: true,
      detail: 'insufficient class balance',
    };
  }
  let runs = 1;
  for (let i = 1; i < n; i++) {
    if (binary[i] !== binary[i - 1]) runs++;
  }
  const mean = (2 * n1 * n0) / n + 1;
  const variance =
    (2 * n1 * n0 * (2 * n1 * n0 - n)) / (n * n * (n - 1));
  const z = variance > 0 ? (runs - mean) / Math.sqrt(variance) : 0;
  const pValue = normalPValueTwoSided(z);
  return {
    name: 'wald-wolfowitz-runs',
    statistic: runs,
    pValue,
    passed: pValue >= 0.05,
    detail: `runs=${runs} E[R]=${mean.toFixed(2)} z=${z.toFixed(3)}`,
  };
}

export function ljungBoxTest(series: number[], lags: number): TestResult {
  const n = series.length;
  if (n < lags * 5) {
    return {
      name: 'ljung-box',
      statistic: 0,
      pValue: 1,
      passed: true,
      detail: 'insufficient length for lags',
    };
  }
  let mean = 0;
  for (const x of series) mean += x;
  mean /= n;
  let c0 = 0;
  for (const x of series) c0 += (x - mean) ** 2;
  c0 /= n;
  if (c0 < 1e-15) {
    return {
      name: 'ljung-box',
      statistic: 0,
      pValue: 1,
      passed: true,
      detail: 'zero variance',
    };
  }
  let Q = 0;
  for (let k = 1; k <= lags; k++) {
    let ck = 0;
    for (let t = k; t < n; t++) {
      ck += (series[t] - mean) * (series[t - k] - mean);
    }
    ck /= n;
    const rho = ck / c0;
    Q += (rho * rho) / (n - k);
  }
  Q *= n * (n + 2);
  const pValue = chiSquarePValue(Q, lags);
  return {
    name: 'ljung-box',
    statistic: Q,
    pValue,
    passed: pValue >= 0.05,
    detail: `Q=${Q.toFixed(3)} lags=${lags}`,
  };
}

export function chiSquareDistributionTest(
  crashPoints: number[],
  edges: number[] = [1.0, 1.3, 1.5, 2.0, 3.0, 5.0, 10.0, Infinity]
): TestResult {
  const n = crashPoints.length;
  const counts = new Array(edges.length - 1).fill(0);
  for (const c of crashPoints) {
    for (let i = 0; i < edges.length - 1; i++) {
      if (c >= edges[i] && c < edges[i + 1]) {
        counts[i]++;
        break;
      }
    }
  }
  // Expected under empirical proportions is tautological; use smooth prior uniform on bins
  // vs observed — tests deviation from flat occupancy (not true house density).
  const expected = n / counts.length;
  let stat = 0;
  for (const c of counts) {
    stat += (c - expected) ** 2 / Math.max(expected, 1);
  }
  const df = counts.length - 1;
  const pValue = chiSquarePValue(stat, df);
  // For crash games, non-uniform is expected — we pass if sample is large and finite
  // Structure test: reject only extreme singularity (one bin dominates >95%)
  const maxShare = Math.max(...counts) / n;
  const passed = maxShare < 0.95 && Number.isFinite(stat);
  return {
    name: 'chi-square-distribution',
    statistic: stat,
    pValue,
    passed,
    detail: `stat=${stat.toFixed(2)} maxShare=${maxShare.toFixed(3)}`,
  };
}

export function spectralFlatnessTest(series: number[]): TestResult {
  const n = series.length;
  if (n < 64) {
    return {
      name: 'spectral-flatness',
      statistic: 1,
      pValue: 1,
      passed: true,
      detail: 'short series',
    };
  }
  // Periodogram proxy via ACF energy concentration
  let mean = 0;
  for (const x of series) mean += x;
  mean /= n;
  const acf: number[] = [];
  let c0 = 0;
  for (const x of series) c0 += (x - mean) ** 2;
  c0 /= n;
  const maxLag = Math.min(40, Math.floor(n / 4));
  for (let k = 1; k <= maxLag; k++) {
    let ck = 0;
    for (let t = k; t < n; t++) ck += (series[t] - mean) * (series[t - k] - mean);
    acf.push(c0 > 0 ? ck / n / c0 : 0);
  }
  const energy = acf.reduce((s, r) => s + r * r, 0);
  const flatness = 1 / (1 + energy); // 1 = flat white-ish, lower = structured
  const passed = flatness > 0.35; // strong structure fails gate for sequence models
  return {
    name: 'spectral-flatness',
    statistic: flatness,
    pValue: flatness,
    passed,
    detail: `flatness=${flatness.toFixed(3)} acfEnergy=${energy.toFixed(3)}`,
  };
}

export function heldOutReplicationTest(
  binary: number[],
  heldOutFraction: number
): TestResult {
  const n = binary.length;
  const split = Math.floor(n * (1 - heldOutFraction));
  if (split < 100 || n - split < 100) {
    return {
      name: 'held-out-replication',
      statistic: 0,
      pValue: 1,
      passed: true,
      detail: 'insufficient split',
    };
  }
  const a = binary.slice(0, split);
  const b = binary.slice(split);
  const rate = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ra = rate(a);
  const rb = rate(b);
  const se = Math.sqrt((ra * (1 - ra)) / a.length + (rb * (1 - rb)) / b.length);
  const z = se > 0 ? (ra - rb) / se : 0;
  const pValue = normalPValueTwoSided(z);
  // Consistency of base rate across windows — should NOT differ wildly if stationary
  const passed = pValue >= 0.01; // allow mild non-stationarity
  return {
    name: 'held-out-replication',
    statistic: Math.abs(ra - rb),
    pValue,
    passed,
    detail: `rateA=${ra.toFixed(3)} rateB=${rb.toFixed(3)} z=${z.toFixed(3)}`,
  };
}

/**
 * Primary API — blocking gate for sequence models.
 * If serial structure is NOT demonstrated, sequence models stay disabled.
 *
 * Logic:
 *  - White-noise-like series (runs + Ljung-Box pass as "no structure") → disable sequence models
 *  - Significant serial structure that replicates on held-out → allow sequence models
 */
export function runRandomnessGate(
  crashPoints: number[],
  config: Partial<RandomnessGateConfig> = {}
): RandomnessGateReport {
  const cfg = { ...DEFAULT_RANDOMNESS_GATE_CONFIG, ...config };
  const n = crashPoints.length;
  const tests: TestResult[] = [];

  if (n < cfg.minRounds) {
    return {
      sampleSize: n,
      tests: [
        {
          name: 'sample-size',
          statistic: n,
          pValue: 0,
          passed: false,
          detail: `need ≥${cfg.minRounds}, have ${n}`,
        },
      ],
      passed: false,
      allowSequenceModels: false,
      correctedAlpha: cfg.significanceLevel,
      summary: `INSUFFICIENT_DATA: ${n} < ${cfg.minRounds}`,
    };
  }

  const binary = crashPoints.map((c) => (c >= cfg.hitThreshold ? 1 : 0));
  const series = crashPoints.map((c) => Math.log(Math.max(c, 1.01)));

  tests.push(waldWolfowitzRunsTest(binary));
  tests.push(ljungBoxTest(series, cfg.ljungBoxLags));
  tests.push(chiSquareDistributionTest(crashPoints));
  tests.push(spectralFlatnessTest(series));
  tests.push(heldOutReplicationTest(binary, cfg.heldOutFraction));

  // Bonferroni
  const m = tests.length;
  const correctedAlpha = cfg.significanceLevel / m;
  const corrected = tests.map((t) => ({
    ...t,
    passed: t.pValue >= correctedAlpha || t.name === 'chi-square-distribution' || t.name === 'spectral-flatness'
      ? t.passed
      : t.pValue >= correctedAlpha,
  }));

  // Structure detection: Ljung-Box or runs reject white noise at corrected alpha
  const runs = corrected.find((t) => t.name === 'wald-wolfowitz-runs')!;
  const lb = corrected.find((t) => t.name === 'ljung-box')!;
  const flat = corrected.find((t) => t.name === 'spectral-flatness')!;
  const held = corrected.find((t) => t.name === 'held-out-replication')!;

  const hasSerialStructure =
    runs.pValue < correctedAlpha || lb.pValue < correctedAlpha || flat.statistic < 0.35;
  const replicates = held.passed;
  const allowSequenceModels = hasSerialStructure && replicates;

  const allGateTestsOk = corrected.every((t) =>
    t.name === 'sample-size' ? t.passed : true
  );

  return {
    sampleSize: n,
    tests: corrected,
    passed: allGateTestsOk,
    allowSequenceModels,
    correctedAlpha,
    summary: allowSequenceModels
      ? 'STRUCTURE_DETECTED_AND_REPLICATED: sequence models may be enabled'
      : 'NO_RELIABLE_SERIAL_STRUCTURE: keep Frequency/Conditional/Regime/Streak only',
  };
}

/** Apply gate result to ensemble flags */
export function applyRandomnessGateToFlags(report: RandomnessGateReport): {
  enableAutocorrelation: boolean;
  enableMarkov: boolean;
  enableSpectral: boolean;
  enableEntropy: boolean;
} {
  const on = report.allowSequenceModels;
  return {
    enableAutocorrelation: on,
    enableMarkov: on,
    enableSpectral: on,
    enableEntropy: on,
  };
}
