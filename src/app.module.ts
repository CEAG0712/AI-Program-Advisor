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
import { OFFER_RANKER } from './recommendations/ranking.js';
import { RustRanker } from './recommendations/rust-ranker.js';
import { ADVISOR, AdvisorController, AdvisorExceptionFilter, isAdvisorPath } from './ai/advisor.controller.js';
import { AdvisorService } from './ai/advisor.service.js';
import { RecommendationsExecutor } from './ai/advisor.executor.js';
import type { ModelClient, InitialModelReply, FinalModelReply } from './ai/model.client.js';
import { OpenAIModelClient, type OpenAIModelOptions } from './ai/openai.model.client.js';
import { TOOL_NAME } from './ai/tool.contract.js';
import { REASON_IDS } from './ai/response.policy.js';

// Server-side DI token only; never selected by a request or model output.
export const FAKE_ADVISOR_MODEL = Symbol('fake-advisor-model');
const EXPERIMENTAL_ADVISOR_DEADLINES = Object.freeze({ initialMs: 15000, businessMs: 2500, finalMs: 8000, overallMs: 30000 });

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
  /** Opt in using the absolute path of an operator-trusted D3-R1 executable. */
  readonly rustRankerPath?: string;
  readonly advisorMode?: 'fake-model-postgres' | 'openai-model-postgres';
  readonly advisorLatency?: 'b3c2f-experimental';
  readonly openai?: OpenAIModelOptions;
}

@Module({})
export class AppModule {
  static register(config: Config, overrides: ApplicationOverrides = {}): DynamicModule {
    const { advisorMode, advisorLatency, openai } = overrides;
    if (advisorMode !== undefined && advisorMode !== 'fake-model-postgres' && advisorMode !== 'openai-model-postgres') {
      throw new Error('Unsupported advisor composition mode.');
    }
    if (advisorMode !== undefined && overrides.advisor !== undefined) {
      throw new Error('Advisor mode and explicit advisor override cannot be combined.');
    }
    if ((advisorMode === 'openai-model-postgres') !== (openai !== undefined)) {
      throw new Error('OpenAI configuration requires explicit OpenAI advisor mode, and vice versa.');
    }
    if (advisorLatency !== undefined &&
        (advisorLatency !== 'b3c2f-experimental' || advisorMode !== 'openai-model-postgres')) {
      throw new Error('Unsupported advisor latency selection for this composition mode.');
    }
    const deadlines = advisorLatency === 'b3c2f-experimental' ? EXPERIMENTAL_ADVISOR_DEADLINES : undefined;
    const modelProvider = openai !== undefined
      ? { provide: OpenAIModelClient, useValue: new OpenAIModelClient(openai) }
      : advisorMode === 'fake-model-postgres' ? { provide: FAKE_ADVISOR_MODEL, useFactory: fakeModelClient } : undefined;
    return {
      module: AppModule,
      controllers: [HealthController, CatalogController, RecommendationsController, AdvisorController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        ...(overrides.rustRankerPath === undefined ? [] :
          [{ provide: OFFER_RANKER, useValue: new RustRanker(overrides.rustRankerPath) }]),
        ...(modelProvider ? [
          RecommendationsExecutor,
          modelProvider,
          { provide: ADVISOR, inject: [modelProvider.provide, RecommendationsExecutor],
            useFactory: (model: ModelClient, executor: RecommendationsExecutor) => new AdvisorService(model, executor, undefined, deadlines) },
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
