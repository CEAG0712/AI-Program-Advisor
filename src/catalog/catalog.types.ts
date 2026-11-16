export type TenantId = 'academy-a' | 'academy-b';

/** Fictional catalog facts; these fields make no learner eligibility decision. */
export interface CourseOffer {
  offer_id: string;
  title: string;
  price_cents: number;
  currency: string;
  required_skills: string[];
  weekly_study_hours: number;
}
