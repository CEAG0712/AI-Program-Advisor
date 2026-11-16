import { Inject, Injectable } from '@nestjs/common';
import { CatalogRepository } from './catalog.repository.js';
import type { TenantContext } from './tenant-context.js';

@Injectable()
export class CatalogService {
  constructor(@Inject(CatalogRepository) private readonly repository: CatalogRepository) {}
  offers(tenant: TenantContext) { return this.repository.activeOffers(tenant); }
}
