import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { Config } from './config.js';
import { HealthController } from './health.controller.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogRepository, DATABASE_POOL } from './catalog/catalog.repository.js';
import { CatalogService } from './catalog/catalog.service.js';
import { APP_CONFIG, DemoAuthGuard } from './catalog/demo-auth.guard.js';

@Module({})
export class AppModule {
  static register(config: Config): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, CatalogController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DATABASE_POOL, useFactory: () => {
          const pool = new Pool({ connectionString: config.databaseUrl, max: 4,
            connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 1500,
            idleTimeoutMillis: 1000, ssl: false });
          pool.on('error', () => { console.warn('Idle database connection failed; details redacted.'); });
          return pool;
        } },
        CatalogRepository, CatalogService, DemoAuthGuard,
      ],
    };
  }
}

export async function createApplication(config: Config) {
  const app = await NestFactory.create(AppModule.register(config), { logger: ['warn', 'error'] });
  app.enableShutdownHooks();
  return app;
}
