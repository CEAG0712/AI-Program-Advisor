import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { Config } from './config.js';
import { HealthController } from './health.controller.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogRepository, DATABASE_POOL } from './catalog/catalog.repository.js';
import { CatalogService } from './catalog/catalog.service.js';
import { APP_CONFIG, DemoAuthGuard } from './catalog/demo-auth.guard.js';

import { RecommendationsController } from './recommendations/recommendations.controller.js';
import { RecommendationsService } from './recommendations/recommendations.service.js';
import { ADVISOR, AdvisorController, AdvisorExceptionFilter, isAdvisorPath } from './ai/advisor.controller.js';
import { AdvisorService } from './ai/advisor.service.js';
import { RecommendationsExecutor } from './ai/advisor.executor.js';
import type { ModelClient, InitialModelReply, FinalModelReply } from './ai/model.client.js';
import { TOOL_NAME } from './ai/tool.contract.js';
import { REASON_IDS } from './ai/response.policy.js';

// Server-side DI token only; never selected by a request or model output.
export const FAKE_ADVISOR_MODEL = Symbol('fake-advisor-model');
function fakeModelClient(): ModelClient {
  return { request: async (input, signal) => {
    signal.throwIfAborted();
    const reply: InitialModelReply | FinalModelReply = input.phase === 'initial' ? {
      kind: 'tool_proposals', proposals: [{ name: TOOL_NAME, arguments: JSON.stringify(input.constraints) }],
    } : { kind: 'explanation', plan: { offers: input.facts.recommendations.map(({ offer_id }) =>
      ({ offer_id, reason_ids: [...REASON_IDS] })) } };
    return JSON.stringify(reply);
  } };
}

/** Server-owned injection seam for offline tests; never populated from HTTP input.
 * An explicit advisor override is supported only with advisorMode omitted.
 * The unchanged main entrypoint omits the mode and keeps the advisor disabled. */
export interface ApplicationOverrides {
  readonly advisor?: AdvisorService;
  readonly databasePool?: Pool;
  readonly advisorMode?: 'fake-model-postgres';
}

@Module({})
export class AppModule {
  static register(config: Config, overrides: ApplicationOverrides = {}): DynamicModule {
    if (overrides.advisorMode !== undefined && overrides.advisorMode !== 'fake-model-postgres') {
      throw new Error('Unsupported advisor composition mode.');
    }
    if (overrides.advisorMode !== undefined && overrides.advisor !== undefined) {
      throw new Error('Advisor mode and explicit advisor override cannot be combined.');
    }
    const enabled = overrides.advisorMode === 'fake-model-postgres';
    return {
      module: AppModule,
      controllers: [HealthController, CatalogController, RecommendationsController, AdvisorController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        ...(enabled ? [
          RecommendationsExecutor,
          { provide: FAKE_ADVISOR_MODEL, useFactory: fakeModelClient },
          { provide: ADVISOR, inject: [FAKE_ADVISOR_MODEL, RecommendationsExecutor],
            useFactory: (model: ModelClient, executor: RecommendationsExecutor) => new AdvisorService(model, executor) },
        ] : [{ provide: ADVISOR, useValue: overrides.advisor ?? null }]),
        { provide: DATABASE_POOL, useFactory: () => {
          if (overrides.databasePool) return overrides.databasePool;
          const pool = new Pool({ connectionString: config.databaseUrl, max: 4,
            connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 1500,
            idleTimeoutMillis: 1000, ssl: false });
          pool.on('error', () => { console.warn('Idle database connection failed; details redacted.'); });
          return pool;
        } },
        CatalogRepository, CatalogService, DemoAuthGuard, RecommendationsService,
        { provide: APP_FILTER, useClass: AdvisorExceptionFilter },
      ],
    };
  }
}

export async function createApplication(config: Config, overrides: ApplicationOverrides = {}) {
  const app = await NestFactory.create(AppModule.register(config, overrides), { logger: ['warn', 'error'] });
  // Header-only namespace policy, registered before the unchanged global parser.
  // Encoded lookalikes get sanitized errors, but are never routed as advisor aliases.
  app.use((request: { path: string }, response: { setHeader(name: string, value: string): void }, next: () => void) => {
    if (isAdvisorPath(request.path)) response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/recommendations', (_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableShutdownHooks();
  return app;
}
