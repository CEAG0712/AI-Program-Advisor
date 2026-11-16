import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { TenantId } from './catalog.types.js';

export interface TenantContext { readonly tenantId: TenantId }
const trustedTenant = Symbol('server-authenticated-tenant');
export interface CatalogRequest {
  headers: { authorization?: string };
  [trustedTenant]?: TenantContext;
}
export function attachTenant(request: CatalogRequest, context: TenantContext): void {
  request[trustedTenant] = Object.freeze(context);
}
export const AuthenticatedTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantContext => {
  const tenant = ctx.switchToHttp().getRequest<CatalogRequest>()[trustedTenant];
  if (!tenant) throw new UnauthorizedException('Valid demo bearer credential required.');
  return tenant;
});
