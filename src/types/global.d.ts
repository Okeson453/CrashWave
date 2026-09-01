declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV?: string;
      DATABASE_URL?: string;
      REDIS_URL?: string;
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_ALLOWED_USER_IDS?: string;
      ENCRYPTION_KEY?: string;
      LOG_LEVEL?: string;
      METRICS_PORT?: string;
      BC_GAME_URL?: string;
      BC_GAME_LOGIN_URL?: string;
      BROWSER_HEADLESS?: string;
      BROWSER_PROFILE_DIR?: string;
      [key: string]: string | undefined;
    }
  }
}

export {};
