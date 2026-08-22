/**
 * TermsAndConditionsService — versioned T&Cs and acceptance tracking.
 */

import { getPool } from '../../persistence/client.js';
import { getLogger } from '../../observability/logger.js';

export interface TermsVersion {
  id: string;
  version: string;
  title: string;
  content: string;
  effectiveDate: Date;
  isActive: boolean;
}

export class TermsAndConditionsService {
  private readonly logger = getLogger();

  async getActiveTerms(): Promise<TermsVersion | null> {
    const result = await getPool().query(
      `SELECT * FROM terms_and_conditions WHERE is_active = true
       ORDER BY effective_date DESC LIMIT 1`
    );
    if (result.rows.length === 0) return null;
    return this.rowToTerms(result.rows[0]);
  }

  async getTermsByVersion(version: string): Promise<TermsVersion | null> {
    const result = await getPool().query(
      `SELECT * FROM terms_and_conditions WHERE version = $1`,
      [version]
    );
    if (result.rows.length === 0) return null;
    return this.rowToTerms(result.rows[0]);
  }

  async hasUserAcceptedTerms(userId: string, version?: string): Promise<boolean> {
    const activeTerms = await this.getActiveTerms();
    if (!activeTerms) return true;
    const checkVersion = version ?? activeTerms.version;
    const result = await getPool().query(
      `SELECT 1 FROM user_terms_acceptances WHERE user_id = $1 AND terms_version = $2`,
      [userId, checkVersion]
    );
    return result.rows.length > 0;
  }

  async acceptTerms(params: {
    userId: string;
    version: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await getPool().query(
      `INSERT INTO user_terms_acceptances (user_id, terms_version, ip_address, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, terms_version) DO NOTHING`,
      [
        params.userId,
        params.version,
        params.ipAddress ?? null,
        params.userAgent ?? null,
      ]
    );
    this.logger.info(
      { component: 'TermsService', userId: params.userId, version: params.version },
      'User accepted terms'
    );
  }

  async createTermsVersion(params: {
    version: string;
    title: string;
    content: string;
    effectiveDate: Date;
  }): Promise<TermsVersion> {
    await getPool().query(
      `UPDATE terms_and_conditions SET is_active = false WHERE is_active = true`
    );
    const result = await getPool().query(
      `INSERT INTO terms_and_conditions (version, title, content, effective_date)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [params.version, params.title, params.content, params.effectiveDate]
    );
    return this.rowToTerms(result.rows[0]);
  }

  private rowToTerms(row: Record<string, unknown>): TermsVersion {
    return {
      id: String(row.id),
      version: String(row.version),
      title: String(row.title),
      content: String(row.content),
      effectiveDate: row.effective_date as Date,
      isActive: Boolean(row.is_active),
    };
  }
}
