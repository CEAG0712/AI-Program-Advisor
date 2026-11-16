import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';
import { DemoAuthGuard } from './demo-auth.guard.js';
import { AuthenticatedTenant, type TenantContext } from './tenant-context.js';

@Controller('catalog')
@UseGuards(DemoAuthGuard)
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly service: CatalogService) {}
  @Get('offers')
  @Header('Cache-Control', 'no-store')
  offers(@AuthenticatedTenant() tenant: TenantContext) { return this.service.offers(tenant); }
}
