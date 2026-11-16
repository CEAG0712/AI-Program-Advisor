import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { resolveCredential } from '../src/catalog/demo-auth.guard.js';
import { CatalogRepository, CATALOG_SQL } from '../src/catalog/catalog.repository.js';
import { CatalogService } from '../src/catalog/catalog.service.js';

// Deliberately fictional unit-test values, never used by a running database.
const env = { DATABASE_URL: 'postgresql://p3_d12:unit-placeholder@127.0.0.1:55432/p3_d12',
  P3_DEMO_TOKEN_A: 'unit-placeholder-academy-a-00000000', P3_DEMO_TOKEN_B: 'unit-placeholder-academy-b-00000000' };
const config = loadConfig(env);

test('configuration fails closed for absent, duplicate or malformed secrets and nonlocal databases', () => {
  for (const override of [{ P3_DEMO_TOKEN_A: '' }, { P3_DEMO_TOKEN_B: env.P3_DEMO_TOKEN_A },
    { P3_DEMO_TOKEN_A: 'short' }, { DATABASE_URL: 'postgresql://p3_d12:secret@remote.invalid/p3_d12' },
    { DATABASE_URL: env.DATABASE_URL + '?sslmode=disable' }, { PORT: '0' }]) {
    assert.throws(() => loadConfig({ ...env, ...override }));
  }
  assert.throws(() => loadConfig({}));
});

test('two credentials map only to their trusted server-side tenants', () => {
  assert.deepEqual(resolveCredential(`Bearer ${config.tokenA}`, config), { tenantId: 'academy-a' });
  assert.deepEqual(resolveCredential(`bearer ${config.tokenB}`, config), { tenantId: 'academy-b' });
  assert.ok(Object.isFrozen(resolveCredential(`Bearer ${config.tokenA}`, config)));
});

test('missing, invalid, malformed and oversized credentials are denied consistently', () => {
  for (const header of [undefined, '', 'Basic abc', 'Bearer', `Bearer ${'x'.repeat(32)}`,
    `Bearer  ${config.tokenA}`, `Bearer ${config.tokenA}, Bearer ${config.tokenB}`,
    `Bearer ${'x'.repeat(257)}`, ['Bearer abc']]) {
    assert.throws(() => resolveCredential(header, config), (error: unknown) =>
      error instanceof UnauthorizedException && error.getStatus() === 401);
  }
});

test('service and repository propagate authenticated scope as a SQL parameter, including empty result', async () => {
  let calls = 0;
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls++;
    assert.equal(sql, CATALOG_SQL);
    assert.match(sql, /WHERE tenant_id = \$1 AND active = TRUE ORDER BY offer_id ASC/);
    assert.deepEqual(values, ['academy-b']);
    return { rows: [] };
  } } as unknown as Pool;
  const service = new CatalogService(new CatalogRepository(pool));
  assert.deepEqual(await service.offers(resolveCredential(`Bearer ${config.tokenB}`, config)), []);
  assert.equal(calls, 1);
});

test('database errors produce a fixed sanitized 503 response, never an empty success', async () => {
  const pool = { query: async () => { throw new Error('password=private SQL SELECT /private/internal/path'); } } as unknown as Pool;
  await assert.rejects(() => new CatalogRepository(pool).activeOffers({ tenantId: 'academy-a' }), (error: unknown) => {
    assert.ok(error instanceof ServiceUnavailableException);
    assert.equal(error.getStatus(), 503);
    assert.deepEqual(error.getResponse(), { message: 'Catalog temporarily unavailable.', error: 'Service Unavailable', statusCode: 503 });
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /password|SELECT|private|stack/);
    return true;
  });
});
