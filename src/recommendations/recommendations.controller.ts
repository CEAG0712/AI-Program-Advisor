import { BadRequestException, Body, Catch, Controller, Headers, HttpCode, HttpException,
  Inject, Post, UseGuards, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { DemoAuthGuard } from '../catalog/demo-auth.guard.js';
import { AuthenticatedTenant, type TenantContext } from '../catalog/tenant-context.js';
import { validateRecommendationRequest } from './recommendations.policy.js';
import { RecommendationsService } from './recommendations.service.js';

// Installed application-wide to catch JSON parser failures before controller dispatch.
// Only recommendation errors are sanitized here; catalog/health keep their existing behavior.
@Catch()
export class RecommendationExceptionFilter extends BaseExceptionFilter {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) { super(); }
  override catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ path: string }>();
    // Express supplies the parsed, undecoded pathname; mirror its case-insensitive route.
    if (/^\/recommendations\/?$/i.test(request.path)) {
      const status = exception instanceof HttpException ? exception.getStatus() :
        (exception && typeof exception === 'object' && 'status' in exception ? exception.status : undefined);
      if (status === 400 || status === 413 || status === 415) {
        this.adapterHost.httpAdapter.reply(http.getResponse(), {
          statusCode: 400, message: 'Invalid recommendation request.', error: 'Bad Request',
        }, 400);
        return;
      }
    }
    super.catch(exception, host);
  }
}

@Controller('recommendations')
@UseGuards(DemoAuthGuard)
export class RecommendationsController {
  constructor(@Inject(RecommendationsService) private readonly service: RecommendationsService) {}
  @Post()
  @HttpCode(200)
  recommendations(@AuthenticatedTenant() tenant: TenantContext, @Body() body: unknown,
    @Headers('content-type') contentType: string | undefined) {
    if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType)) {
      throw new BadRequestException('Invalid recommendation request.');
    }
    return this.service.recommendations(tenant, validateRecommendationRequest(body));
  }
}
