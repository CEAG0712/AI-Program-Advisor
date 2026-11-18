import { BadRequestException, Body, Catch, Controller, Headers, HttpException, Inject,
  Post, Req, Res, ServiceUnavailableException, UseGuards, type ArgumentsHost } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DemoAuthGuard } from '../catalog/demo-auth.guard.js';
import { AuthenticatedTenant, type TenantContext } from '../catalog/tenant-context.js';
import { RecommendationExceptionFilter } from '../recommendations/recommendations.controller.js';
import { validateRecommendationRequest } from '../recommendations/recommendations.policy.js';
import type { AdvisorService, AdvisorOutcome } from './advisor.service.js';

export const ADVISOR = Symbol('advisor');
export const MAX_ADVISOR_RESPONSE_BYTES = 40960;

/** Decode only to widen error sanitation, never to dispatch an encoded alias. */
export function isAdvisorPath(path: string): boolean {
  const namespace = /^\/advisor(?:\/|$)/i;
  if (namespace.test(path)) return true;
  try { return namespace.test(decodeURIComponent(path)); } catch { return false; }
}

const errorBody = (code: string) => ({ status: 'error', code });
function failure(status: number): { status: number; body: ReturnType<typeof errorBody> } {
  const mapped = status === 400 || status === 413 || status === 415 ? 400 :
    [401, 404, 408, 502, 503, 504].includes(status) ? status : 500;
  const codes: Record<number, string> = { 400: 'INVALID_ADVISOR_REQUEST', 401: 'UNAUTHORIZED',
    404: 'NOT_FOUND', 408: 'CANCELLED', 502: 'ADVISOR_PROTOCOL_ERROR',
    503: 'ADVISOR_UNAVAILABLE', 504: 'ADVISOR_TIMEOUT', 500: 'INTERNAL_ERROR' };
  return { status: mapped, body: errorBody(codes[mapped]) };
}

/** Global only because parser failures precede controller/guard dispatch.
 * All non-advisor paths delegate to the existing recommendation filter. */
@Catch()
export class AdvisorExceptionFilter extends RecommendationExceptionFilter {
  constructor(@Inject(HttpAdapterHost) private readonly advisorAdapter: HttpAdapterHost) { super(advisorAdapter); }
  override catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    if (!isAdvisorPath(http.getRequest<{ path: string }>().path)) { super.catch(exception, host); return; }
    const response = http.getResponse<ServerResponse>();
    if (response.destroyed || response.writableEnded) return;
    const status = exception instanceof HttpException ? exception.getStatus() :
      exception && typeof exception === 'object' && 'status' in exception ? exception.status : 500;
    const mapped = failure(typeof status === 'number' ? status : 500);
    response.setHeader('Cache-Control', 'no-store');
    this.advisorAdapter.httpAdapter.reply(response, mapped.body, mapped.status);
  }
}

@Controller('advisor/recommendations')
@UseGuards(DemoAuthGuard)
export class AdvisorController {
  constructor(@Inject(ADVISOR) private readonly advisor: AdvisorService | null) {}

  @Post()
  async recommendations(@AuthenticatedTenant() tenant: TenantContext, @Body() body: unknown,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: IncomingMessage, @Res() response: ServerResponse): Promise<void> {
    if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType) ||
      !body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException();
    const envelope = body as Record<string, unknown>;
    const keys = Reflect.ownKeys(envelope);
    if (keys.length !== 2 || !keys.every((key) => key === 'constraints' || key === 'confirmed') ||
      envelope.confirmed !== true) throw new BadRequestException();
    // An acknowledgement is self-declaration, not proof of human review or competence.
    const confirmed = validateRecommendationRequest(envelope.constraints);
    if (!this.advisor) throw new ServiceUnavailableException(); // B3B executor not installed.
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    const close = () => { if (!response.writableFinished) abort(); };
    request.once('aborted', abort);
    response.once('close', close);
    // A normally consumed request body may already be destroyed; that is not a disconnect.
    if (request.aborted || response.destroyed || response.socket?.destroyed) abort();
    try {
      const outcome: AdvisorOutcome = await this.advisor.advise({ tenant, confirmed, signal: cancellation.signal });
      if (cancellation.signal.aborted || response.destroyed || response.writableEnded) return;
      const status = outcome.status === 'completed' || outcome.status === 'clarification_required' ||
        outcome.status === 'refused' ? 200 : outcome.status === 'rejected' ? 502 :
        outcome.status === 'cancelled' ? 408 : outcome.code === 'TIMEOUT' ? 504 : 503;
      const result = status === 200 ? outcome : failure(status).body;
      // Serialize once, check actual UTF-8 bytes, and send exactly the checked string.
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized) > MAX_ADVISOR_RESPONSE_BYTES) throw new ServiceUnavailableException();
      response.statusCode = status;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(serialized);
    } finally {
      request.removeListener('aborted', abort);
      response.removeListener('close', close);
    }
  }
}
