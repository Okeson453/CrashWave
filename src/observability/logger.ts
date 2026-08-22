import pino, { Logger as PinoLogger, LoggerOptions } from 'pino';
import { LogLevelType } from '../config/schema';

const REDACTED_PATHS = [
  'password',
  'token',
  'secret',
  'apiKey',
  'api_key',
  'encryptionKey',
  'encryption_key',
  'cookie',
  'authorization',
  'auth',
  'credentials',
  'privateKey',
  'private_key',
  'TELEGRAM_BOT_TOKEN',
  'ENCRYPTION_KEY',
  'DATABASE_URL',
  'REDIS_URL',
];

function mapLogLevel(level: LogLevelType): string {
  const mapping: Record<LogLevelType, string> = {
    trace: 'trace',
    debug: 'debug',
    info: 'info',
    warn: 'warn',
    error: 'error',
    fatal: 'fatal',
  };
  return mapping[level] || 'info';
}

export interface LogContext {
  sessionId?: string;
  roundId?: string;
  betId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

let rootLogger: PinoLogger | null = null;

export function createLogger(serviceName: string, logLevel: LogLevelType = 'info'): PinoLogger {
  const options: LoggerOptions = {
    level: mapLogLevel(logLevel),
    name: serviceName,
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: serviceName,
      pid: process.pid,
      env: process.env.NODE_ENV || 'development',
    },
  };

  if (process.env.NODE_ENV !== 'production') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  rootLogger = pino(options);
  return rootLogger;
}

export function getLogger(): PinoLogger {
  if (!rootLogger) {
    rootLogger = createLogger('bc-game-crash-automation', 'info');
  }
  return rootLogger;
}

export function setLogger(logger: PinoLogger): void {
  rootLogger = logger;
}

export function childLogger(context: LogContext): PinoLogger {
  return getLogger().child(context as Record<string, unknown>);
}

export function logWithContext(
  level: LogLevelType,
  message: string,
  context: LogContext = {}
): void {
  const logger = childLogger(context);
  switch (level) {
    case 'trace':
      logger.trace(message);
      break;
    case 'debug':
      logger.debug(message);
      break;
    case 'info':
      logger.info(message);
      break;
    case 'warn':
      logger.warn(message);
      break;
    case 'error':
      logger.error(message);
      break;
    case 'fatal':
      logger.fatal(message);
      break;
  }
}
