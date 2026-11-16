import { BadRequestException } from '@nestjs/common';
import type { CourseOffer } from '../catalog/catalog.types.js';
import type { RecommendationRequest, RecommendationResponse } from './recommendations.types.js';

const KEYS = ['budget_cents', 'weekly_hours', 'known_skills'];
const SKILL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_RECOMMENDATIONS = 10;
export const REASONS = Object.freeze([
  'Within the declared budget.',
  'Fits the weekly study-hour limit.',
  'Required skills match the declared skills.',
]);

export function validateRecommendationRequest(body: unknown): RecommendationRequest {
  const invalid = () => { throw new BadRequestException('Invalid recommendation request.'); };
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return invalid();
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== KEYS.length || !keys.every((key) => KEYS.includes(key))) return invalid();
  const { budget_cents, weekly_hours, known_skills } = input;
  if (typeof budget_cents !== 'number' || !Number.isSafeInteger(budget_cents) ||
      budget_cents < 0 || budget_cents > 100000000) return invalid();
  if (typeof weekly_hours !== 'number' || !Number.isInteger(weekly_hours) ||
      weekly_hours < 1 || weekly_hours > 168) return invalid();
  if (!Array.isArray(known_skills) || known_skills.length > 32 ||
      ![...known_skills].every((skill) => typeof skill === 'string' && skill.length <= 64 &&
        skill.trim() === skill && SKILL.test(skill)) ||
      new Set(known_skills).size !== known_skills.length) return invalid();
  // Canonical lowercase identifiers only: no case folding or inferred/related skills.
  return Object.freeze({ budget_cents, weekly_hours, known_skills: Object.freeze([...known_skills]) });
}

/** Input must already be the verified tenant's active catalog. Declared-skill suitability
 * only: no formal admission, competency verification, reservation or checkout authority. */
export function recommend(offers: readonly CourseOffer[], request: RecommendationRequest): RecommendationResponse {
  const skills = new Set(request.known_skills);
  const eligible = offers.filter((offer) => offer.currency === 'USD' &&
    offer.price_cents <= request.budget_cents && offer.weekly_study_hours <= request.weekly_hours &&
    offer.required_skills.every((skill) => skills.has(skill)));
  eligible.sort((a, b) => b.weekly_study_hours - a.weekly_study_hours ||
    a.price_cents - b.price_cents || (a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0));
  return { recommendations: eligible.slice(0, MAX_RECOMMENDATIONS).map((offer) => ({
    offer_id: offer.offer_id, title: offer.title, price_cents: offer.price_cents,
    currency: offer.currency, required_skills: [...offer.required_skills],
    weekly_study_hours: offer.weekly_study_hours, reasons: [...REASONS],
  })) };
}
