import { Inject, Injectable } from '@nestjs/common';
import { CatalogRepository } from '../catalog/catalog.repository.js';
import type { TenantContext } from '../catalog/tenant-context.js';
import { recommend } from './recommendations.policy.js';
import type { RecommendationRequest } from './recommendations.types.js';

@Injectable()
export class RecommendationsService {
  constructor(@Inject(CatalogRepository) private readonly repository: CatalogRepository) {}
  async recommendations(tenant: TenantContext, request: RecommendationRequest) {
    return recommend(await this.repository.recommendationCandidates(tenant), request);
  }
}
