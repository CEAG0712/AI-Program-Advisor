import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApplication } from '../src/app.module.js';
import { loadConfig } from '../src/config.js';
import type { CourseOffer } from '../src/catalog/catalog.types.js';

// Keep the body failure and each cleanup failure, while attempting every owned cleanup.
async function runWithCleanup(body: () => Promise<void>, cleanup: readonly (() => unknown)[]): Promise<void> {
  const errors: unknown[] = [];
  try { await body(); } catch (error) { errors.push(error); }
  for (const operation of cleanup) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Test body or cleanup failed; retained errors follow.');
}

test('cleanup regression: restoration failure retains errors and never skips owned resource cleanup', async () => {
  for (const bodyFails of [true, false]) {
    const original = new Error('original assertion failure');
    const restore = new Error('fixture restoration failure');
    const outageClose = new Error('outage application shutdown failure');
    const appClose = new Error('application shutdown failure');
    const poolClose = new Error('pool closure failure');
    const calls: string[] = [];
    await assert.rejects(runWithCleanup(async () => {
      if (bodyFails) throw original;
    }, [
      async () => { calls.push('restore'); throw restore; },
      async () => { calls.push('outage.close'); throw outageClose; },
      async () => { calls.push('app.close'); throw appClose; },
      async () => { calls.push('db.end'); throw poolClose; },
    ]), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const expected = [...(bodyFails ? [original] : []), restore, outageClose, appClose, poolClose];
      assert.equal(error.errors.length, expected.length);
      error.errors.forEach((retained, index) => assert.equal(retained, expected[index]));
      return true;
    });
    assert.deepEqual(calls, ['restore', 'outage.close', 'app.close', 'db.end']);
  }
  const original = new Error('setup failure before application initialization');
  const resources: { app?: { close(): Promise<void> } } = {};
  let poolClosures = 0;
  await assert.rejects(runWithCleanup(async () => { throw original; }, [
    () => resources.app?.close(),
    async () => { poolClosures++; },
  ]), (error: unknown) => error === original);
  assert.equal(poolClosures, 1);
});

test('real NestJS HTTP and isolated PostgreSQL acceptance', { timeout: 45000 }, async (t) => {
  assert.equal(process.env.D1_2_INTEGRATION, '1', 'Explicit D1_2_INTEGRATION=1 is required; no mock fallback.');
  const config = loadConfig();
  const databaseUrl = new URL(config.databaseUrl);
  assert.equal(databaseUrl.hostname, '127.0.0.1');
  assert.equal(databaseUrl.port, '55432', 'Only the approved isolated test instance may be initialized.');
  const db = new Pool({ connectionString: config.databaseUrl, max: 1,
    connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 1500 });
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let outageApp: Awaited<ReturnType<typeof createApplication>> | undefined;
  const fixtureIds = ['p3-a-101', 'p3-a-102', 'p3-a-103', 'p3-b-101', 'p3-b-102', 'p3-b-103'];
  let emptyTestChangedRows = false;
  const restoreFixtures = async () => {
    if (!emptyTestChangedRows) return;
    await db.query('UPDATE course_offers SET active = TRUE WHERE offer_id = ANY($1::text[]) AND tenant_id = $2', [['p3-b-101', 'p3-b-102'], 'academy-b']);
    emptyTestChangedRows = false;
  };
  await runWithCleanup(async () => {
    app = await createApplication(config);
    const identity = await db.query('SELECT current_database() AS db, current_user AS owner, version() AS version');
    assert.equal(identity.rows[0].db, 'p3_d12');
    assert.equal(identity.rows[0].owner, 'p3_d12');
    console.log('Actual SQL connection:', identity.rows[0].db, identity.rows[0].version.split(' on ')[0]);
    const existing = await db.query("SELECT to_regclass('public.course_offers') AS relation");
    if (existing.rows[0].relation) {
      const foreign = await db.query('SELECT count(*)::int AS count FROM course_offers WHERE NOT (offer_id = ANY($1::text[]))', [fixtureIds]);
      assert.equal(foreign.rows[0].count, 0, 'Unexpected data: refuse fixture mutations.');
    }
    await db.query(await readFile('db/schema.sql', 'utf8'));
    const seed = await readFile('db/seed.sql', 'utf8');
    await db.query(seed);
    await db.query(seed);
    const all = await db.query('SELECT * FROM course_offers ORDER BY offer_id');
    assert.deepEqual(all.rows.map((row) => row.offer_id), fixtureIds);
    assert.deepEqual(all.rows.map((row) => row.price_cents), [12000, 24000, 5000, 9500, 18500, 7000]);
    assert.deepEqual(all.rows.map((row) => row.tenant_id), ['academy-a', 'academy-a', 'academy-a', 'academy-b', 'academy-b', 'academy-b']);
    assert.deepEqual(all.rows.map((row) => row.active), [true, true, false, true, true, false]);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const request = async (path: string, token?: string, extraHeaders: Record<string, string> = {}) => {
      const response = await fetch(base + path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders }, signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      if (path.startsWith('/catalog/offers') && response.status === 200) assert.equal(response.headers.get('cache-control'), 'no-store');
      const text = JSON.stringify(body);
      for (const secret of [config.tokenA, config.tokenB, databaseUrl.password]) assert.ok(!text.includes(secret));
      return { status: response.status, body };
    };
    const expected = (tenant: string): CourseOffer[] => all.rows.filter((row) => row.tenant_id === tenant && row.active)
      .map(({ offer_id, title, price_cents, currency, required_skills, weekly_study_hours }) =>
        ({ offer_id, title, price_cents, currency, required_skills, weekly_study_hours }));

    await t.test('AC1 health: process responds 200', async () => {
      assert.deepEqual(await request('/health'), { status: 200, body: { status: 'ok' } });
    });
    await t.test('AC2/3/4/7 real stored rows, tenant isolation, prices, inactive exclusion and deterministic order', async () => {
      for (const [tenant, token] of [['academy-a', config.tokenA], ['academy-b', config.tokenB]]) {
        const response = await request('/catalog/offers', token);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, expected(tenant));
        assert.equal(response.body.length, 2);
      }
    });
    await t.test('AC6 query/header spoofing cannot change credential scope', async () => {
      const spoof = [
        await request('/catalog/offers?tenant_id=academy-b&tenant=academy-b', config.tokenA),
        await request('/catalog/offers', config.tokenA, { 'x-tenant-id': 'academy-b', 'tenant-id': 'academy-b', tenant_id: 'academy-b' }),
        await request('/catalog/offers?tenant_id=academy-a', config.tokenB, { 'x-tenant-id': 'academy-a' }),
      ];
      for (let index = 0; index < spoof.length; index++) {
        assert.equal(spoof[index].status, 200);
        assert.deepEqual(spoof[index].body, expected(index === 2 ? 'academy-b' : 'academy-a'));
      }
    });
    await t.test('AC5 missing, invalid and malformed auth denied with sanitized 401', async () => {
      for (const header of ['', `Bearer ${'x'.repeat(32)}`, 'Basic invalid', `Bearer ${config.tokenA}, Bearer ${config.tokenB}`, 'Bearer']) {
        const result = await request('/catalog/offers', undefined, header ? { Authorization: header } : {});
        assert.equal(result.status, 401);
        assert.deepEqual(result.body, { message: 'Valid demo bearer credential required.', error: 'Unauthorized', statusCode: 401 });
      }
    });
    await t.test('authorized empty catalog is an actual database-backed 200 collection', async () => {
      emptyTestChangedRows = true;
      await db.query('UPDATE course_offers SET active = FALSE WHERE tenant_id = $1 AND active = TRUE', ['academy-b']);
      await runWithCleanup(async () => {
        assert.deepEqual(await request('/catalog/offers', config.tokenB), { status: 200, body: [] });
        assert.deepEqual((await request('/catalog/offers', config.tokenA)).body, expected('academy-a'));
      }, [restoreFixtures]);
    });
    await t.test('AC8 actual unreachable PostgreSQL dependency returns safe 503 while process health remains 200', async () => {
      const probe = createServer();
      await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
      const address = probe.address();
      assert.ok(address && typeof address !== 'string');
      const closedPort = address.port;
      await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      const unavailableUrl = new URL(config.databaseUrl);
      unavailableUrl.port = String(closedPort);
      outageApp = await createApplication({ ...config, databaseUrl: unavailableUrl.toString() });
      await outageApp.listen(0, '127.0.0.1');
      const outageBase = await outageApp.getUrl();
      const response = await fetch(outageBase + '/catalog/offers', {
        headers: { Authorization: `Bearer ${config.tokenA}` }, signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { message: 'Catalog temporarily unavailable.', error: 'Service Unavailable', statusCode: 503 });
      assert.equal((await fetch(outageBase + '/health')).status, 200);
      assert.equal((await request('/catalog/offers', config.tokenB)).status, 200);
    });
    assert.deepEqual((await db.query('SELECT * FROM course_offers ORDER BY offer_id')).rows, all.rows, 'Fixture state restored after empty test.');
  }, [restoreFixtures, () => outageApp?.close(), () => app?.close(), () => db.end()]);
});
