import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Config } from '../config.js';
import { attachTenant, type CatalogRequest, type TenantContext } from './tenant-context.js';

export const APP_CONFIG = Symbol('app-config');
const digest = (value: string) => createHash('sha256').update(value).digest();

export function resolveCredential(header: unknown, config: Config): TenantContext {
  if (typeof header !== 'string' || header.length > 264 || !/^Bearer [A-Za-z0-9_-]{32,256}$/i.test(header)) {
    throw new UnauthorizedException('Valid demo bearer credential required.');
  }
  const supplied = digest(header.slice(7));
  const matchesA = timingSafeEqual(supplied, digest(config.tokenA));
  const matchesB = timingSafeEqual(supplied, digest(config.tokenB));
  if (matchesA) return Object.freeze({ tenantId: 'academy-a' });
  if (matchesB) return Object.freeze({ tenantId: 'academy-b' });
  throw new UnauthorizedException('Valid demo bearer credential required.');
}

@Injectable()
export class DemoAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: Config) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CatalogRequest>();
    attachTenant(request, resolveCredential(request.headers.authorization, this.config));
    return true;
  }
}
