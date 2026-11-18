import type { TenantContext } from '../catalog/tenant-context.js';
import type { RecommendationRequest, RecommendationResponse } from '../recommendations/recommendations.types.js';
import { REASONS, validateRecommendationRequest } from '../recommendations/recommendations.policy.js';
import { TOOL_NAME, validateToolProposal, type ToolRejection } from './tool.contract.js';
import { deterministicFallback, groundResponse, type GroundedResponse } from './response.policy.js';
import type { ModelClient, ModelRequest } from './model.client.js';

export const ADVISOR_LIMITS = Object.freeze({ initialBytes: 8192, finalRequestBytes: 32768,
  finalReplyBytes: 8192, factsBytes: 32768, offers: 10,
  initialMs: 2000, businessMs: 2500, finalMs: 1000, overallMs: 6000 });
interface AdvisorDeadlines {
  readonly initialMs: number;
  readonly businessMs: number;
  readonly finalMs: number;
  readonly overallMs: number;
}

export interface BusinessExecutor {
  /** Must supply authorized facts. Shape/suitability checks do not prove ownership.
   * A future RecommendationsService adapter must retain server-authenticated scope. */
  execute(tenant: TenantContext, args: RecommendationRequest, signal: AbortSignal): Promise<unknown>;
}
export interface AdvisorInput {
  readonly tenant: TenantContext;
  /** Supplied independently by a trusted caller, never extracted from the model.
   * This API validates declarations, not the provenance of human confirmation. */
  readonly confirmed: unknown;
  readonly signal?: AbortSignal;
}
export type AdvisorOutcome =
  | Readonly<{ status: 'completed'; response: GroundedResponse }>
  | Readonly<{ status: 'clarification_required'; code: 'UNCONFIRMED_CONSTRAINTS' | 'MODEL_CLARIFICATION' }>
  | Readonly<{ status: 'rejected'; code: ToolRejection | 'INVALID_TENANT' | 'MODEL_PROTOCOL' }>
  | Readonly<{ status: 'refused'; code: 'MODEL_REFUSAL' }>
  | Readonly<{ status: 'cancelled'; code: 'CANCELLED' }>
  | Readonly<{ status: 'unavailable'; code: 'MODEL_ERROR' | 'TIMEOUT' | 'BUSINESS_ERROR' | 'INVALID_FACTS' | 'INTERNAL_ERROR' }>;

/** Injectable only for deterministic tests; production callers use defaults.
 * now must be monotonic and timers must follow the same clock. */
export interface AdvisorRuntime {
  now(): number;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(handle: unknown): void;
}
const runtime: AdvisorRuntime = {
  now: () => performance.now(),
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
class PhaseFailure extends Error {
  constructor(readonly code: 'TIMEOUT' | 'CANCELLED') { super(code); }
}
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((k) => typeof k === 'string' && keys.includes(k));
};

/** Copy only bounded JSON data, without invoking accessors or toJSON. Proxies
 * can still run traps; injected trusted code cannot be sandboxed in-process. */
function data(value: unknown, maxBytes: number): unknown {
  let nodes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 12) throw new Error('Data bound');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string' && Buffer.byteLength(v) <= maxBytes) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!v || typeof v !== 'object') throw new Error('Non-data value');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      throw new Error('Non-data prototype');
    }
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 4096) throw new Error('Data bound');
    if (array) {
      const length = descriptors.length?.value as unknown;
      if (!Number.isInteger(length) || (length as number) > 4096 || keys.length !== (length as number) + 1) {
        throw new Error('Invalid array');
      }
      return Array.from({ length: length as number }, (_, i) => {
        const d = descriptors[String(i)];
        if (!d || !('value' in d)) throw new Error('Invalid array element');
        return copy(d.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const d = typeof key === 'string' ? descriptors[key] : undefined;
      if (!d || !('value' in d) || !d.enumerable) throw new Error('Non-data property');
      result[key as string] = copy(d.value, depth + 1);
    }
    return result;
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error('Data bound');
  return result;
}
function parse(raw: unknown, bytes: number): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > bytes) throw new Error('Model bound');
  // Duplicate keys retain JSON.parse semantics, inherited from B1.
  return data(JSON.parse(raw), bytes);
}
function factsFrom(value: unknown, confirmed: RecommendationRequest): RecommendationResponse {
  const facts = data(value, ADVISOR_LIMITS.factsBytes);
  if (!exact(facts, ['recommendations']) || !Array.isArray(facts.recommendations) ||
      facts.recommendations.length > ADVISOR_LIMITS.offers) throw new Error('Invalid facts');
  const ids = new Set<string>();
  for (const offer of facts.recommendations) {
    if (!exact(offer, ['offer_id', 'title', 'price_cents', 'currency', 'weekly_study_hours', 'required_skills', 'reasons']) ||
        typeof offer.offer_id !== 'string' || !offer.offer_id.length || offer.offer_id.length > 128 || ids.has(offer.offer_id) ||
        typeof offer.title !== 'string' || !offer.title.length || offer.currency !== 'USD' ||
        !Array.isArray(offer.reasons) || offer.reasons.length !== REASONS.length ||
        !REASONS.every((reason, i) => offer.reasons instanceof Array && offer.reasons[i] === reason)) {
      throw new Error('Invalid facts');
    }
    const declaration = validateRecommendationRequest({ budget_cents: offer.price_cents,
      weekly_hours: offer.weekly_study_hours, known_skills: offer.required_skills });
    if (declaration.budget_cents > confirmed.budget_cents || declaration.weekly_hours > confirmed.weekly_hours ||
        !declaration.known_skills.every((skill) => confirmed.known_skills.includes(skill))) throw new Error('Unsuitable facts');
    ids.add(offer.offer_id);
  }
  // B1 returns a deeply frozen detached snapshot. The mutable legacy type is
  // used only at the B1 call boundary; this service never mutates that snapshot.
  const detached = deterministicFallback(facts as unknown as RecommendationResponse);
  return detached as unknown as RecommendationResponse;
}

export class AdvisorService {
  readonly #deadlines: AdvisorDeadlines;

  constructor(private readonly model: ModelClient, private readonly business: BusinessExecutor,
    private readonly clock: AdvisorRuntime = runtime, deadlines: AdvisorDeadlines = ADVISOR_LIMITS) {
    this.#deadlines = Object.freeze({ ...deadlines });
  }

  private phase<T>(operation: (signal: AbortSignal) => Promise<T>, milliseconds: number,
    overallEnd: number, caller?: AbortSignal): Promise<T> {
    const end = Math.min(overallEnd, this.clock.now() + milliseconds);
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let timer: unknown;
      const finish = (error: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.clock.clearTimer(timer);
        caller?.removeEventListener('abort', cancel);
        // Cooperative only: the underlying implementation may ignore abort.
        if (error) { controller.abort(); reject(error); } else resolve(value as T);
      };
      const cancel = () => finish(new PhaseFailure('CANCELLED'));
      if (caller?.aborted) { cancel(); return; }
      if (this.clock.now() >= end) { finish(new PhaseFailure('TIMEOUT')); return; }
      caller?.addEventListener('abort', cancel, { once: true });
      timer = this.clock.setTimer(() => finish(new PhaseFailure('TIMEOUT')), end - this.clock.now());
      try {
        // Both handlers stay attached after timeout, consuming late rejection.
        Promise.resolve(operation(controller.signal)).then((value) => {
          if (caller?.aborted) cancel();
          else if (this.clock.now() >= end) finish(new PhaseFailure('TIMEOUT'));
          else finish(undefined, value);
        }, (error: unknown) => {
          if (caller?.aborted) cancel();
          else if (this.clock.now() >= end) finish(new PhaseFailure('TIMEOUT'));
          else finish(error || new Error('Dependency failed'));
        });
      } catch (error) { finish(error || new Error('Dependency failed')); }
    });
  }

  async advise(input: AdvisorInput): Promise<AdvisorOutcome> {
    const outcome = (value: AdvisorOutcome): AdvisorOutcome => Object.freeze(value);
    let stage: 'input' | 'initial' | 'business' | 'facts' | 'final' = 'input';
    let facts: RecommendationResponse | undefined;
    try {
      const overallEnd = this.clock.now() + this.#deadlines.overallMs;
      if (input.signal?.aborted) return outcome({ status: 'cancelled', code: 'CANCELLED' });
      const tenant = data(input.tenant, 256);
      if (!exact(tenant, ['tenantId']) || !['academy-a', 'academy-b'].includes(tenant.tenantId as string)) {
        return outcome({ status: 'rejected', code: 'INVALID_TENANT' });
      }
      let confirmed: RecommendationRequest;
      try { confirmed = validateRecommendationRequest(data(input.confirmed, 4096)); }
      catch { return outcome({ status: 'clarification_required', code: 'UNCONFIRMED_CONSTRAINTS' }); }
      const trustedTenant = Object.freeze({ tenantId: tenant.tenantId }) as TenantContext;
      const request = (message: ModelRequest, cap: number, ms: number) => {
        if (Buffer.byteLength(JSON.stringify(message)) > cap) throw new Error('Request bound');
        return this.phase((signal) => this.model.request(Object.freeze(message), signal), ms, overallEnd, input.signal);
      };
      stage = 'initial';
      let reply: unknown;
      const raw = await request({ phase: 'initial', constraints: confirmed }, ADVISOR_LIMITS.initialBytes, this.#deadlines.initialMs);
      try { reply = parse(raw, ADVISOR_LIMITS.initialBytes); }
      catch { return outcome({ status: 'rejected', code: 'MODEL_PROTOCOL' }); }
      if (exact(reply, ['kind']) && reply.kind === 'refusal') return outcome({ status: 'refused', code: 'MODEL_REFUSAL' });
      if (exact(reply, ['kind', 'fields']) && reply.kind === 'clarification' && Array.isArray(reply.fields) &&
          reply.fields.length > 0 && reply.fields.length <= 3 && new Set(reply.fields).size === reply.fields.length &&
          reply.fields.every((f) => ['budget_cents', 'weekly_hours', 'known_skills'].includes(f))) {
        return outcome({ status: 'clarification_required', code: 'MODEL_CLARIFICATION' });
      }
      if (!exact(reply, ['kind', 'proposals']) || reply.kind !== 'tool_proposals' ||
          !Array.isArray(reply.proposals) || reply.proposals.length !== 1) {
        return outcome({ status: 'rejected', code: 'MODEL_PROTOCOL' });
      }
      const accepted = validateToolProposal(reply.proposals[0], confirmed);
      if (!accepted.ok) return outcome({ status: 'rejected', code: accepted.code });
      stage = 'business';
      // Acyclic flow: exactly one dispatch site; no retries or re-entry from model output.
      const result = await this.phase((signal) => this.business.execute(trustedTenant, accepted.arguments, signal),
        this.#deadlines.businessMs, overallEnd, input.signal);
      stage = 'facts';
      facts = factsFrom(result, confirmed);
      stage = 'final';
      const finalRaw = await request({ phase: 'final', facts: facts as unknown as GroundedResponse },
        ADVISOR_LIMITS.finalRequestBytes, this.#deadlines.finalMs);
      let plan: unknown;
      try {
        const final = parse(finalRaw, ADVISOR_LIMITS.finalReplyBytes);
        if (exact(final, ['kind', 'plan']) && final.kind === 'explanation') plan = final.plan;
      } catch { /* Invalid explanation uses successful facts only. */ }
      if (input.signal?.aborted) return outcome({ status: 'cancelled', code: 'CANCELLED' });
      return outcome({ status: 'completed', response: groundResponse(facts, plan) });
    } catch (error) {
      if (input?.signal?.aborted || error instanceof PhaseFailure && error.code === 'CANCELLED') {
        return outcome({ status: 'cancelled', code: 'CANCELLED' });
      }
      if (stage === 'final' && facts) return outcome({ status: 'completed', response: deterministicFallback(facts) });
      const code = error instanceof PhaseFailure ? 'TIMEOUT' : stage === 'initial' ? 'MODEL_ERROR' :
        stage === 'business' ? 'BUSINESS_ERROR' : stage === 'facts' ? 'INVALID_FACTS' : 'INTERNAL_ERROR';
      return outcome({ status: 'unavailable', code });
    }
  }
}
