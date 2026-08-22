export interface SecretProvider {
  get(key: string): Promise<string | undefined>;
  getSync(key: string): string | undefined;
}

export class EnvSecretProvider implements SecretProvider {
  async get(key: string): Promise<string | undefined> {
    return process.env[key];
  }

  getSync(key: string): string | undefined {
    return process.env[key];
  }
}

export class InMemorySecretProvider implements SecretProvider {
  private secrets: Map<string, string> = new Map();

  set(key: string, value: string): void {
    this.secrets.set(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  getSync(key: string): string | undefined {
    return this.secrets.get(key);
  }
}

export class SecretsManager {
  private providers: SecretProvider[] = [];

  constructor(providers?: SecretProvider[]) {
    this.providers = providers ?? [new EnvSecretProvider()];
  }

  addProvider(provider: SecretProvider): void {
    this.providers.push(provider);
  }

  async require(key: string): Promise<string> {
    const value = await this.get(key);
    if (!value) {
      throw new Error(`Required secret '${key}' not found in any provider`);
    }
    return value;
  }

  async get(key: string): Promise<string | undefined> {
    for (const provider of this.providers) {
      const value = await provider.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  requireSync(key: string): string {
    const value = this.getSync(key);
    if (!value) {
      throw new Error(`Required secret '${key}' not found in any provider`);
    }
    return value;
  }

  getSync(key: string): string | undefined {
    for (const provider of this.providers) {
      const value = provider.getSync(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }
}

let globalManager: SecretsManager | null = null;

export function getSecretsManager(): SecretsManager {
  if (!globalManager) {
    globalManager = new SecretsManager();
  }
  return globalManager;
}

export function setSecretsManager(manager: SecretsManager): void {
  globalManager = manager;
}
