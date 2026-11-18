import { Inject, Injectable } from '@nestjs/common';
import type { TenantContext } from '../catalog/tenant-context.js';
import { RecommendationsService } from '../recommendations/recommendations.service.js';
import type { RecommendationRequest } from '../recommendations/recommendations.types.js';
import type { BusinessExecutor } from './advisor.service.js';

/** Server-owned adapter: tenant provenance belongs to the guarded caller.
 * Abort checks are cooperative. The service has no AbortSignal parameter;
 * a query already running in PostgreSQL may continue after cancellation. */
@Injectable()
export class RecommendationsExecutor implements BusinessExecutor {
  constructor(@Inject(RecommendationsService) private readonly service: RecommendationsService) {}

  async execute(trustedTenant: TenantContext, validatedArguments: RecommendationRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await this.service.recommendations(trustedTenant, validatedArguments);
    signal.throwIfAborted();
    return result;
  }
}
