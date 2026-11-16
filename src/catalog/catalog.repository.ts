import { Inject, Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { CourseOffer } from './catalog.types.js';
import type { TenantContext } from './tenant-context.js';

// At most 1,000 active candidates; fetch a sentinel row and refuse overflow, never rank a partial page.
export const MAX_RECOMMENDATION_CANDIDATES = 1000;
export const DATABASE_POOL = Symbol('database-pool');
export const CATALOG_SQL = `SELECT offer_id, title, price_cents, currency, required_skills, weekly_study_hours
  FROM course_offers WHERE tenant_id = $1 AND active = TRUE ORDER BY offer_id ASC`;

@Injectable()
export class CatalogRepository implements OnModuleDestroy {
  private readonly logger = new Logger(CatalogRepository.name);
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}
  async activeOffers(tenant: TenantContext): Promise<CourseOffer[]> {
    try {
      const result = await this.pool.query<CourseOffer>(CATALOG_SQL, [tenant.tenantId]);
      return result.rows;
    } catch {
      this.logger.warn('Catalog dependency request failed; details redacted.');
      throw new ServiceUnavailableException('Catalog temporarily unavailable.');
    }
  }
  async recommendationCandidates(tenant: TenantContext): Promise<CourseOffer[]> {
    try {
      const result = await this.pool.query<CourseOffer>(`${CATALOG_SQL} LIMIT $2`,
        [tenant.tenantId, MAX_RECOMMENDATION_CANDIDATES + 1]);
      if (result.rows.length > MAX_RECOMMENDATION_CANDIDATES) throw new Error('Candidate bound exceeded.');
      return result.rows;
    } catch {
      this.logger.warn('Recommendation catalog unavailable; details redacted.');
      throw new ServiceUnavailableException('Catalog temporarily unavailable.');
    }
  }
  async onModuleDestroy(): Promise<void> { await this.pool.end(); }
}
