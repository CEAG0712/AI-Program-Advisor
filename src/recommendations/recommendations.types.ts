import type { CourseOffer } from '../catalog/catalog.types.js';

export interface RecommendationRequest {
  readonly budget_cents: number;
  readonly weekly_hours: number;
  readonly known_skills: readonly string[];
}
export interface Recommendation extends CourseOffer { reasons: string[] }
export interface RecommendationResponse { recommendations: Recommendation[] }
