// BC.Game Crash game constants
// These selectors and values are based on BC.Game's Crash game UI structure
// and may need adjustment if the platform changes its DOM structure.

export const BC_GAME_URLS = {
  base: 'https://bc.game',
  /** Authentication entry point — use this before navigating to Crash */
  login: 'https://bc.game/auth/signin',
  crash: 'https://bc.game/crash',
  apiBase: 'https://api.bc.game',
} as const;

// DOM Selectors for the Crash game
export const DOM_SELECTORS = {
  // Game container
  gameContainer: '[data-testid="crash-game"], .crash-game, [class*="crash"][class*="game"]',

  // Round/multiplier display
  multiplierDisplay: '[data-testid="crash-multiplier"], .crash-multiplier, [class*="multiplier"][class*="crash"]',
  multiplierValue: '[data-testid="crash-multiplier-value"], .multiplier-value, [class*="multiplier"][class*="value"]',

  // Round ID
  roundIdDisplay: '[data-testid="round-id"], .round-id, [class*="round"][class*="id"]',

  // Game phase indicators
  phaseRunning: '[data-testid="phase-running"], .phase-running, [class*="phase"][class*="running"]',
  phaseCrashed: '[data-testid="phase-crashed"], .phase-crashed, [class*="phase"][class*="crashed"]',
  phaseStarting: '[data-testid="phase-starting"], .phase-starting, [class*="phase"][class*="starting"]',

  // Crash result display
  crashResult: '[data-testid="crash-result"], .crash-result, [class*="crash"][class*="result"]',
  crashPoint: '[data-testid="crash-point"], .crash-point, [class*="crash"][class*="point"]',

  // History panel
  historyPanel: '[data-testid="history-panel"], .history-panel, [class*="history"]',
  historyItem: '[data-testid="history-item"], .history-item',

  // Balance
  balanceDisplay: '[data-testid="balance"], .balance, [class*="balance"], [class*="wallet"]',

  // Bet controls (for later batches)
  betButton: '[data-testid="bet-button"], .bet-button, [class*="bet"][class*="button"]',
  cashOutButton: '[data-testid="cashout-button"], .cashout-button, [class*="cashout"]',
  betInput: '[data-testid="bet-input"], .bet-input, input[placeholder*="amount"]',
  autoCashOutToggle: '[data-testid="auto-cashout"], .auto-cashout',
  autoCashOutInput: '[data-testid="auto-cashout-input"], .auto-cashout-input',

  // Login/auth indicators
  loginButton: '[data-testid="login"], .login-btn',
  userMenu: '[data-testid="user-menu"], .user-menu',

  // Live execution (centralised — single source of truth for canary + executors)
  placeBetButton: 'button[data-testid="place-bet-button"], button:has-text("Bet"), .game-btn:has-text("Bet")',
  activeBetIndicator: '[data-testid="active-bet"], .active-bet, .bet-active, .cashout-btn',
  betAmountInput: 'input[data-testid="bet-amount-input"], .game-input input[type="number"], input[placeholder*="amount" i]',
  cancelBetButton: 'button[data-testid="cancel-bet-button"], button:has-text("Cancel")',
  cashOutConfirmed: '[data-testid="cash-out-confirmed"], .cashout-confirmed, .win-amount',
} as const;


// WebSocket message types observed in BC.Game
export const WS_MESSAGE_TYPES = {
  roundStart: 'crash:round:start',
  roundUpdate: 'crash:round:update',
  roundCrash: 'crash:round:crash',
  roundEnd: 'crash:round:end',
  tick: 'crash:tick',
  stateChange: 'crash:state',
  playerBet: 'crash:player:bet',
  playerCashOut: 'crash:player:cashout',
  balanceUpdate: 'crash:balance',
} as const;

// API endpoints
export const API_ENDPOINTS = {
  roundHistory: '/api/game/crash/history',
  currentRound: '/api/game/crash/current',
  roundDetail: '/api/game/crash/round',
} as const;

// Timeout values (milliseconds)
export const TIMEOUTS = {
  pageLoad: 30000,
  gameLoad: 15000,
  roundStartDetection: 5000,
  crashDetection: 3000,
  multiplierPollInterval: 50,
  domAdapterPollInterval: 100,
  wsReconnectInterval: 3000,
  apiPollInterval: 500,
  staleMultiplierThreshold: 2000,
  staleRoundThreshold: 10000,
  adapterStartupTimeout: 10000,
  navigationTimeout: 30000,
} as const;

// Confidence thresholds
export const CONFIDENCE_THRESHOLDS = {
  high: {
    minAgreeingSources: 2,
    maxLatencyMs: 500,
    maxConflictScore: 0,
  },
  medium: {
    minAgreeingSources: 1,
    maxLatencyMs: 1000,
    maxConflictScore: 1,
  },
  low: {
    minAgreeingSources: 1,
    maxLatencyMs: 2000,
    maxConflictScore: 2,
  },
} as const;

// Multiplier parsing
export const MULTIPLIER_PATTERNS = {
  // Matches formats like "1.23x", "1.23X", "x1.23", "1.23"
  extract: /(?:x\s*)?(\d+\.?\d*)\s*(?:x|X)?/,
  // Minimum valid multiplier (game starts at 1.00x)
  minimum: 1.0,
  // Maximum reasonable multiplier (to filter out parsing errors)
  maximum: 100000.0,
} as const;

// Round ID patterns
export const ROUND_ID_PATTERNS = {
  // BC.Game round IDs are typically alphanumeric
  extract: /[#]?([A-Za-z0-9\-_]{4,32})/,
} as const;

// Game phases as they appear in the DOM/WS
export const PHASE_MAPPINGS: Record<string, import('../types/game').RoundPhase> = {
  'idle': 'idle',
  'starting': 'starting',
  'run': 'running',
  'running': 'running',
  'active': 'running',
  'crash': 'crashed',
  'crashed': 'crashed',
  'end': 'crashed',
  'ended': 'crashed',
  'unknown': 'unknown',
} as const;

// Retry configuration for adapters
export const ADAPTER_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 3000,
} as const;

// Stale detection
export const STALE_CONFIG = {
  multiplierMaxAgeMs: 2000,
  roundMaxAgeMs: 15000,
  wsHeartbeatIntervalMs: 5000,
  maxConsecutiveMissedTicks: 3,
} as const;
