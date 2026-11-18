import { BadRequestException } from '@nestjs/common';
import { validateRecommendationRequest } from '../recommendations/recommendations.policy.js';
import type { RecommendationRequest } from '../recommendations/recommendations.types.js';

export const TOOL_NAME = 'find_suitable_courses';
export const MAX_TOOL_ARGUMENT_BYTES = 4096;
export type ToolRejection = 'UNSUPPORTED_TOOL' | 'INVALID_TOOL_ARGUMENTS' |
  'UNCONFIRMED_CONSTRAINTS' | 'CONSTRAINT_MISMATCH';
export type ToolContractResult =
  | Readonly<{ ok: true; arguments: RecommendationRequest }>
  | Readonly<{ ok: false; code: ToolRejection }>;

function reject(code: ToolRejection): ToolContractResult {
  return Object.freeze({ ok: false, code });
}

// Translate only expected validation failures. Programmer errors remain visible.
function validated(value: unknown): RecommendationRequest | undefined {
  try { return validateRecommendationRequest(value); }
  catch (error) {
    if (error instanceof BadRequestException) return undefined;
    throw error;
  }
}

/** The caller must obtain confirmation independently of the model. This function
 * checks equality, not confirmation provenance, identity or tenant membership.
 * Proposal envelope: exactly { name, arguments }, where arguments is raw JSON. */
export function validateToolProposal(proposal: unknown, confirmed: unknown): ToolContractResult {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return reject('INVALID_TOOL_ARGUMENTS');
  }
  const input = proposal as Record<string, unknown>;
  if (input.name !== TOOL_NAME) return reject('UNSUPPORTED_TOOL');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.every((key) => key === 'name' || key === 'arguments') ||
      typeof input.arguments !== 'string' ||
      Buffer.byteLength(input.arguments, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) {
    return reject('INVALID_TOOL_ARGUMENTS');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(input.arguments); }
  catch (error) {
    if (error instanceof SyntaxError) return reject('INVALID_TOOL_ARGUMENTS');
    throw error;
  }
  const args = validated(parsed);
  if (!args) return reject('INVALID_TOOL_ARGUMENTS');
  const declarations = validated(confirmed);
  if (!declarations) return reject('UNCONFIRMED_CONSTRAINTS');
  const skills = new Set(declarations.known_skills);
  if (args.budget_cents !== declarations.budget_cents || args.weekly_hours !== declarations.weekly_hours ||
      args.known_skills.length !== skills.size || !args.known_skills.every((skill) => skills.has(skill))) {
    return reject('CONSTRAINT_MISMATCH');
  }
  return Object.freeze({ ok: true, arguments: args });
}
