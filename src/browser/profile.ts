import { mkdir, readdir, stat, rm, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { BrowserProfile } from './types';
import { getLogger } from '../observability/logger';
import { CriticalError } from '../utils/errors';

const PROFILE_META_FILE = 'profile-meta.json';
const MAX_PROFILES = 5;
const PROFILE_RETENTION_DAYS = 30;

export interface ProfileManagerOptions {
  baseDirectory: string;
  maxProfiles?: number;
  retentionDays?: number;
}

export class ProfileManager {
  private readonly options: Required<ProfileManagerOptions>;
  private readonly logger = getLogger();
  private profiles: Map<string, BrowserProfile> = new Map();

  constructor(options: ProfileManagerOptions) {
    this.options = {
      maxProfiles: options.maxProfiles ?? MAX_PROFILES,
      retentionDays: options.retentionDays ?? PROFILE_RETENTION_DAYS,
      baseDirectory: options.baseDirectory,
    };
  }

  /**
   * Initialize the profile manager and load existing profiles.
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.options.baseDirectory)) {
      await mkdir(this.options.baseDirectory, { recursive: true });
    }

    await this.scanProfiles();
    this.logger.info(
      { component: 'ProfileManager', profileCount: this.profiles.size, baseDir: this.options.baseDirectory },
      'Profile manager initialized'
    );
  }

  /**
   * Scan the base directory for existing profiles.
   */
  private async scanProfiles(): Promise<void> {
    const entries = await readdir(this.options.baseDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const profileDir = join(this.options.baseDirectory, entry.name);
      const metaPath = join(profileDir, PROFILE_META_FILE);

      if (existsSync(metaPath)) {
        try {
          const { readFile } = await import('fs/promises');
          const raw = await readFile(metaPath, 'utf-8');
          const profile: BrowserProfile = JSON.parse(raw);
          this.profiles.set(profile.id, profile);
        } catch (err) {
          this.logger.warn(
            { component: 'ProfileManager', dir: entry.name, error: String(err) },
            'Failed to load profile metadata'
          );
        }
      }
    }
  }

  /**
   * Create a new browser profile.
   */
  async createProfile(): Promise<BrowserProfile> {
    // Clean up old profiles if at limit
    if (this.profiles.size >= this.options.maxProfiles) {
      await this.rotateProfiles();
    }

    const id = randomUUID();
    const directory = join(this.options.baseDirectory, `profile-${id}`);
    const now = new Date().toISOString();

    await mkdir(directory, { recursive: true });

    const profile: BrowserProfile = {
      id,
      directory,
      createdAt: now,
      lastUsedAt: now,
      useCount: 0,
      sessionCount: 0,
    };

    await this.saveProfileMeta(profile);
    this.profiles.set(id, profile);

    this.logger.info({ component: 'ProfileManager', profileId: id }, 'Created new browser profile');
    return profile;
  }

  /**
   * Get an existing profile or create a new one.
   */
  async getOrCreateProfile(preferredId?: string): Promise<BrowserProfile> {
    if (preferredId && this.profiles.has(preferredId)) {
      const profile = this.profiles.get(preferredId)!;
      profile.lastUsedAt = new Date().toISOString();
      profile.useCount++;
      await this.saveProfileMeta(profile);
      return profile;
    }

    // Return the most recently used profile if available
    const sorted = Array.from(this.profiles.values()).sort(
      (a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
    );

    if (sorted.length > 0) {
      const profile = sorted[0];
      profile.lastUsedAt = new Date().toISOString();
      profile.useCount++;
      await this.saveProfileMeta(profile);
      return profile;
    }

    return this.createProfile();
  }

  /**
   * Mark a profile as used for a session.
   */
  async markSessionUsed(profileId: string): Promise<void> {
    const profile = this.profiles.get(profileId);
    if (profile) {
      profile.sessionCount++;
      profile.lastUsedAt = new Date().toISOString();
      await this.saveProfileMeta(profile);
    }
  }

  /**
   * Save profile metadata to disk.
   */
  private async saveProfileMeta(profile: BrowserProfile): Promise<void> {
    const metaPath = join(profile.directory, PROFILE_META_FILE);
    const { writeFile } = await import('fs/promises');
    await writeFile(metaPath, JSON.stringify(profile, null, 2), 'utf-8');
  }

  /**
   * Rotate out old profiles when at the limit.
   */
  /**
   * Public entry for SessionRotator-driven lifecycle rotation.
   */
  async requestRotation(): Promise<void> {
    await this.rotateProfiles();
  }

  private async rotateProfiles(): Promise<void> {
    const sorted = Array.from(this.profiles.values()).sort(
      (a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime()
    );

    const toRemove = sorted.slice(0, Math.ceil(sorted.length / 2));
    for (const profile of toRemove) {
      await this.deleteProfile(profile.id);
    }
  }

  /**
   * Delete a profile and its directory.
   */
  async deleteProfile(profileId: string): Promise<void> {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      this.logger.warn({ component: 'ProfileManager', profileId }, 'Profile not found for deletion');
      return;
    }

    try {
      await rm(profile.directory, { recursive: true, force: true });
      this.profiles.delete(profileId);
      this.logger.info({ component: 'ProfileManager', profileId }, 'Deleted browser profile');
    } catch (error) {
      this.logger.error(
        { component: 'ProfileManager', profileId, error: String(error) },
        'Failed to delete profile'
      );
    }
  }

  /**
   * Clean up profiles older than retention period.
   */
  async cleanupOldProfiles(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.options.retentionDays);

    let deleted = 0;
    for (const profile of this.profiles.values()) {
      if (new Date(profile.lastUsedAt) < cutoff) {
        await this.deleteProfile(profile.id);
        deleted++;
      }
    }

    this.logger.info(
      { component: 'ProfileManager', deleted, retentionDays: this.options.retentionDays },
      'Profile cleanup complete'
    );
    return deleted;
  }

  /**
   * Get profile directory path.
   */
  getProfileDirectory(profileId: string): string | undefined {
    return this.profiles.get(profileId)?.directory;
  }

  /**
   * List all profiles.
   */
  listProfiles(): BrowserProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Get the base directory for profiles.
   */
  getBaseDirectory(): string {
    return this.options.baseDirectory;
  }

  /**
   * Clone a profile to a new directory (useful for backup/testing).
   */
  async cloneProfile(sourceId: string, targetDirectory: string): Promise<void> {
    const source = this.profiles.get(sourceId);
    if (!source) {
      throw new CriticalError(`Source profile not found: ${sourceId}`, 'PROFILE_NOT_FOUND');
    }

    await mkdir(targetDirectory, { recursive: true });

    const entries = await readdir(source.directory);
    for (const entry of entries) {
      const srcPath = join(source.directory, entry);
      const dstPath = join(targetDirectory, entry);
      const entryStat = await stat(srcPath);

      if (entryStat.isFile()) {
        await copyFile(srcPath, dstPath);
      }
      // Directories are skipped for simplicity; Playwright profiles are mostly flat
    }

    this.logger.info(
      { component: 'ProfileManager', sourceId, targetDirectory },
      'Profile cloned'
    );
  }
}
