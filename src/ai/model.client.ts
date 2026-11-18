import type { RecommendationRequest } from '../recommendations/recommendations.types.js';
import type { GroundedResponse, ExplanationPlan } from './response.policy.js';

/** No tenant authority, credentials or confirmation provenance crosses this port.
 * A transport must bound received bytes too; checking a returned string cannot
 * prevent an injected implementation from allocating an oversized response. */
export type ModelRequest =
  | Readonly<{ phase: 'initial'; constraints: RecommendationRequest }>
  | Readonly<{ phase: 'final'; facts: GroundedResponse }>;
export type InitialModelReply =
  | Readonly<{ kind: 'tool_proposals'; proposals: readonly Readonly<{ name: string; arguments: string }>[] }>
  | Readonly<{ kind: 'clarification'; fields: readonly ('budget_cents' | 'weekly_hours' | 'known_skills')[] }>
  | Readonly<{ kind: 'refusal' }>;
export interface FinalModelReply { readonly kind: 'explanation'; readonly plan: ExplanationPlan }
export interface ModelClient {
  /** JSON encoding of the phase-specific reply; always untrusted at runtime. */
  request(input: ModelRequest, signal: AbortSignal): Promise<string>;
}
