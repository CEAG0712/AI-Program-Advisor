import { Inject, Injectable, Optional } from '@nestjs/common';
import { CatalogRepository } from '../catalog/catalog.repository.js';
import type { TenantContext } from '../catalog/tenant-context.js';
import { recommend, recommendationFacts, suitableOffers } from './recommendations.policy.js';
import type { RecommendationRequest } from './recommendations.types.js';
import { isCatalogText, OFFER_RANKER, rankingUnavailable, validateRankingCandidates, type OfferRanker } from './ranking.js';

@Injectable()
export class RecommendationsService {
  constructor(@Inject(CatalogRepository) private readonly repository: CatalogRepository,
    @Optional() @Inject(OFFER_RANKER) private readonly ranker?: OfferRanker) {}

  async recommendations(tenant: TenantContext, request: RecommendationRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const candidates = await this.repository.recommendationCandidates(tenant);
    // The existing SQL query has its own timeouts and does not accept an AbortSignal.
    signal?.throwIfAborted();
    if (!this.ranker) return recommend(candidates, request);

    validateRankingCandidates(candidates);
    for (const { title, currency, required_skills } of candidates) {
      // Match PostgreSQL trim(text), which removes ordinary spaces by default.
      const trimmedTitle = isCatalogText(title) ? title.replace(/^ +| +$/g, '') : '';
      if (!trimmedTitle || [...trimmedTitle].length > 200 || typeof currency !== 'string' ||
          currency.length !== 3 || !/^[A-Z]{3}$/.test(currency) || !Array.isArray(required_skills) ||
          ![...required_skills].every(isCatalogText)) throw rankingUnavailable();
    }
    const eligible = suitableOffers(candidates, request);
    if (!eligible.length) return recommendationFacts([]);
    const records = new Map(eligible.map((offer) => [offer.offer_id, offer]));
    const orderedIds = await this.ranker.rank(eligible.map(({ offer_id, price_cents, weekly_study_hours }) =>
      ({ offer_id, price_cents, weekly_study_hours })), signal);
    signal?.throwIfAborted();
    return recommendationFacts(orderedIds.map((id) => {
      const record = records.get(id);
      if (!record) throw rankingUnavailable();
      return record;
    }));
  }
}
