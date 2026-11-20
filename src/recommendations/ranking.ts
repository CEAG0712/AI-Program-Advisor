import { ServiceUnavailableException } from '@nestjs/common';
import { MAX_RECOMMENDATION_CANDIDATES } from '../catalog/catalog.repository.js';
import type { CourseOffer } from '../catalog/catalog.types.js';

export const OFFER_RANKER = Symbol('offer-ranker');

export type RankingCandidate = Readonly<Pick<CourseOffer, 'offer_id' | 'price_cents' | 'weekly_study_hours'>>;

export interface OfferRanker {
  rank(offers: readonly RankingCandidate[], signal?: AbortSignal): Promise<readonly string[]>;
}

export function rankingUnavailable() {
  return new ServiceUnavailableException('Recommendation ranking temporarily unavailable.');
}

export function isCatalogText(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
}

export function validateRankingCandidates(offers: readonly RankingCandidate[]): void {
  if (!Array.isArray(offers) || offers.length > MAX_RECOMMENDATION_CANDIDATES) throw rankingUnavailable();
  const ids = new Set<string>();
  for (const offer of offers) {
    if (!offer || typeof offer !== 'object' || Array.isArray(offer) ||
        !isCatalogText(offer.offer_id) || !offer.offer_id || [...offer.offer_id].length > 80 ||
        !Number.isInteger(offer.price_cents) || offer.price_cents < 0 || offer.price_cents > 2_147_483_647 ||
        !Number.isInteger(offer.weekly_study_hours) || offer.weekly_study_hours < 1 ||
        offer.weekly_study_hours > 168 || ids.has(offer.offer_id)) throw rankingUnavailable();
    ids.add(offer.offer_id);
  }
}
