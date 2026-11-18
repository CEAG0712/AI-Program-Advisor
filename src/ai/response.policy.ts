import { REASONS } from '../recommendations/recommendations.policy.js';
import type { Recommendation, RecommendationResponse } from '../recommendations/recommendations.types.js';

export const REASON_IDS = Object.freeze(['budget', 'hours', 'skills'] as const);
export interface ExplanationPlan {
  readonly offers: readonly Readonly<{ offer_id: string; reason_ids: readonly typeof REASON_IDS[number][] }>[];
}
export type GroundedRecommendation = Readonly<Omit<Recommendation, 'required_skills' | 'reasons'> & {
  required_skills: readonly string[];
  reasons: readonly string[];
}>;
export interface GroundedResponse {
  readonly source: 'accepted_plan' | 'deterministic_fallback';
  readonly recommendations: readonly GroundedRecommendation[];
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

function requireFacts(facts: RecommendationResponse): void {
  if (!facts || !Array.isArray(facts.recommendations)) {
    throw new TypeError('Successful authorized recommendation facts are required.');
  }
}

/** Facts must already come from a successful authorized recommendation read.
 * This validates a complete plan, never re-ranks facts or authenticates scope.
 * Each offer must reference all three fixed reasons in their existing order. */
export function validateExplanationPlan(plan: unknown, facts: RecommendationResponse): plan is ExplanationPlan {
  requireFacts(facts);
  if (!exactKeys(plan, ['offers']) || !Array.isArray(plan.offers) ||
      plan.offers.length !== facts.recommendations.length) return false;
  const seen = new Set<string>();
  // Use an indexed loop so sparse arrays cannot skip validation.
  for (let i = 0; i < plan.offers.length; i++) {
    const offer: unknown = plan.offers[i];
    if (!exactKeys(offer, ['offer_id', 'reason_ids']) || typeof offer.offer_id !== 'string' ||
        offer.offer_id !== facts.recommendations[i].offer_id || seen.has(offer.offer_id) ||
        !Array.isArray(offer.reason_ids) || offer.reason_ids.length !== REASON_IDS.length) return false;
    for (let j = 0; j < REASON_IDS.length; j++) {
      if (offer.reason_ids[j] !== REASON_IDS[j]) return false;
    }
    seen.add(offer.offer_id);
  }
  return true;
}

function copyFacts(facts: RecommendationResponse, source: GroundedResponse['source']): GroundedResponse {
  requireFacts(facts);
  return Object.freeze({ source, recommendations: Object.freeze(facts.recommendations.map((offer) => Object.freeze({
    offer_id: offer.offer_id, title: offer.title, price_cents: offer.price_cents,
    currency: offer.currency, weekly_study_hours: offer.weekly_study_hours,
    required_skills: Object.freeze([...offer.required_skills]), reasons: Object.freeze([...REASONS]),
  }))) });
}

/** Never call this with a failed/absent read. Empty successful facts are valid.
 * Structured catalog text is preserved verbatim, not HTML-sanitized. A future
 * presentation boundary must escape it for its actual rendering context. */
export function deterministicFallback(facts: RecommendationResponse): GroundedResponse {
  return copyFacts(facts, 'deterministic_fallback');
}

/** Invalid plans are rejected by validation and replaced with fixed rendering.
 * No model-supplied text, prices or policy assertions enter the result. */
export function groundResponse(facts: RecommendationResponse, plan: unknown): GroundedResponse {
  return validateExplanationPlan(plan, facts) ? copyFacts(facts, 'accepted_plan') : deterministicFallback(facts);
}
