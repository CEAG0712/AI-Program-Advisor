import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, Socket } from 'node:net';
import { mock, test } from 'node:test';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { createApplication } from '../src/app.module.js';
import { loadConfig } from '../src/config.js';
import type { CourseOffer } from '../src/catalog/catalog.types.js';

async function withCleanup(body: () => Promise<void>, cleanup: readonly (() => unknown)[]) {
  const errors: unknown[] = [];
  try { await body(); } catch (error) { errors.push(error); }
  for (const close of cleanup) { try { await close(); } catch (error) { errors.push(error); } }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Body or cleanup failed.');
}

test('cleanup retains body/closure failures and attempts every owned close', async () => {
  const original = new Error('body');
  const closure = new Error('close');
  const calls: number[] = [];
  await assert.rejects(withCleanup(async () => { throw original; }, [
    () => { calls.push(1); throw closure; }, () => { calls.push(2); },
  ]), (error: unknown) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === closure);
  assert.deepEqual(calls, [1, 2]);
});

// Complete expected fixtures, independently specified; this suite never writes SQL.
const fixtures = [
  ['p3-a-101', 'academy-a', 'Synthetic Python Foundations', 12000, [], 4, true],
  ['p3-a-102', 'academy-a', 'Synthetic Backend APIs', 24000, ['basic-python'], 6, true],
  ['p3-a-103', 'academy-a', 'Synthetic Retired Workshop', 5000, [], 2, false],
  ['p3-b-101', 'academy-b', 'Synthetic SQL Foundations', 9500, [], 3, true],
  ['p3-b-102', 'academy-b', 'Synthetic Data Services', 18500, ['basic-sql'], 5, true],
  ['p3-b-103', 'academy-b', 'Synthetic Archived Seminar', 7000, [], 2, false],
].map(([offer_id, tenant_id, title, price_cents, required_skills, weekly_study_hours, active]) =>
  ({ offer_id, tenant_id, title, price_cents, currency: 'USD', required_skills, weekly_study_hours, active }));
const reasons = ['Within the declared budget.', 'Fits the weekly study-hour limit.', 'Required skills match the declared skills.'];
const maria = { budget_cents: 30000, weekly_hours: 6, known_skills: ['basic-python'] };
const badRequest = { statusCode: 400, message: 'Invalid recommendation request.', error: 'Bad Request' };

// These are real Express-accepted aliases, including absolute-form request targets.
// Do not decode escapes or resolve dot segments: the router does neither for this route.
const recommendationPaths = [
  '/recommendations', '/Recommendations', '/RECOMMENDATIONS', '/ReCoMmEnDaTiOnS',
  '/recommendations/', '/Recommendations/', '/RECOMMENDATIONS?source=test',
  '/Recommendations/?source=test', 'http://review.invalid/Recommendations?source=test',
];

interface PipelineResponse { status: number; cache: string | undefined; body: unknown }

// Exercise the initialized HTTP request listener without opening a TCP socket.
// Authentication, Express parsing/routing and the real Nest exception filter all run.
// This is not networked HTTP/PostgreSQL acceptance and does not replace the suite below.
async function dispatchInProcess(app: Awaited<ReturnType<typeof createApplication>>,
  path: string, body = '', headers: Record<string, string> = {}, method = 'POST'): Promise<PipelineResponse> {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.method = method;
  request.url = path;
  request.headers = { 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)), ...headers };
  const response = new ServerResponse(request);
  return new Promise<PipelineResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: PipelineResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Each stream/socket cleanup is attempted even if another cleanup throws.
      void withCleanup(async () => { if (error) throw error; }, [
        () => request.destroy(), () => response.destroy(), () => socket.destroy(),
      ]).then(() => result ? resolve(result) : reject(new Error('Missing pipeline response.')), reject);
    };
    const timer = setTimeout(() => finish(new Error('In-process request timed out.')), 3000);
    request.once('error', finish);
    response.once('error', finish);
    socket.once('error', finish);
    response.end = ((chunk?: unknown) => {
      try {
        finish(undefined, { status: response.statusCode,
          cache: response.getHeader('cache-control') as string | undefined,
          body: chunk ? JSON.parse(String(chunk)) : null });
      } catch (error) { finish(error); }
      return response;
    }) as typeof response.end;
    try {
      app.getHttpServer().emit('request', request, response);
      request.push(Buffer.from(body));
      request.push(null);
    } catch (error) { finish(error); }
  });
}

test('parser sanitizer regression through initialized Nest/Express, no TCP or SQL', { timeout: 15000 }, async (t) => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://p3_d12:parser-test-placeholder@127.0.0.1:55432/p3_d12',
    P3_DEMO_TOKEN_A: 'parser-test-placeholder-academy-a-0000',
    P3_DEMO_TOKEN_B: 'parser-test-placeholder-academy-b-0000',
  });
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  const loggedErrors: unknown[][] = [];
  // Capture errors only for this serial test and assert their expected absence/presence.
  // Restore even if setup, a test assertion, or application shutdown fails.
  const errorLog = mock.method(Logger.prototype, 'error', (...args: unknown[]) => { loggedErrors.push(args); });
  const fault = new Error('Synthetic internal parser-regression failure.');
  await withCleanup(async () => {
    app = await createApplication(config);
    app.use((request: { headers: Record<string, string | undefined> }, _response: unknown, next: () => void) => {
      if (request.headers['x-parser-regression-fault'] === '1') throw fault;
      next();
    });
    await app.init();
    assert.equal(app.getHttpAdapter().getInstance().enabled('case sensitive routing'), false);
    assert.equal(app.getHttpAdapter().getInstance().enabled('strict routing'), false);
    const dispatch = (path: string, body = '', headers: Record<string, string> = {}, method = 'POST') =>
      dispatchInProcess(app!, path, body, headers, method);
    const valid = JSON.stringify(maria);
    const authenticated = { authorization: `Bearer ${config.tokenA}` };
    const unauthorized = { message: 'Valid demo bearer credential required.', error: 'Unauthorized', statusCode: 401 };
    const malformed = '{"review-marker": broken}';
    for (const path of recommendationPaths) {
      await t.test(`accepted alias ${path}`, async () => {
        loggedErrors.length = 0;
        for (const authorization of [undefined, 'Bearer invalid']) {
          assert.deepEqual(await dispatch(path, valid, authorization ? { authorization } : {}),
            { status: 401, cache: 'no-store', body: unauthorized });
        }
        // Parser rejection precedes the guard, both with and without credentials.
        for (const headers of [{}, authenticated]) {
          for (const raw of [malformed, 'x'.repeat(110000)]) {
            assert.deepEqual(await dispatch(path, raw, headers),
              { status: 400, cache: 'no-store', body: badRequest });
          }
        }
        for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=bogus']) {
          assert.deepEqual(await dispatch(path, valid, { ...authenticated, 'content-type': contentType }),
            { status: 400, cache: 'no-store', body: badRequest });
        }
        assert.deepEqual(loggedErrors, [], 'Expected sanitized errors must not reach raw error logging.');
      });
    }
    await t.test('lookalikes and encoded/unnormalized targets remain outside endpoint sanitation', async () => {
      let parserMessage = '';
      try { JSON.parse(malformed); } catch (error) { assert.ok(error instanceof SyntaxError); parserMessage = error.message; }
      const targets = [
        ['/recommendations-extra', undefined], ['/recommendations/private', 'no-store'],
        ['/recommendationsXYZ', undefined], ['/%72ecommendations', undefined],
        ['/recommendations%2F', undefined], ['//recommendations', undefined],
        ['/recommendations//', 'no-store'], ['/recommendations/../recommendations', 'no-store'],
      ] as const;
      for (const [path, cache] of targets) {
        assert.deepEqual(await dispatch(path, valid), { status: 404, cache,
          body: { message: `Cannot POST ${path}`, error: 'Not Found', statusCode: 404 } });
        assert.deepEqual(await dispatch(path, malformed), { status: 400, cache,
          body: { message: parserMessage, error: 'Bad Request', statusCode: 400 } });
      }
    });
    await t.test('health and catalog keep their existing behavior and parser handling', async () => {
      assert.deepEqual(await dispatch('/health', '', {}, 'GET'),
        { status: 200, cache: undefined, body: { status: 'ok' } });
      assert.deepEqual(await dispatch('/catalog/offers', '', {}, 'GET'),
        { status: 401, cache: undefined, body: unauthorized });
      for (const path of ['/health', '/catalog/offers']) {
        const result = await dispatch(path, malformed);
        let message = '';
        try { JSON.parse(malformed); } catch (error) { assert.ok(error instanceof SyntaxError); message = error.message; }
        assert.deepEqual(result, { status: 400, cache: undefined,
          body: { message, error: 'Bad Request', statusCode: 400 } });
      }
    });
    await t.test('unexpected internal errors remain generic 500 and observable', async () => {
      for (const path of recommendationPaths) {
        loggedErrors.length = 0;
        assert.deepEqual(await dispatch(path, valid, { 'x-parser-regression-fault': '1' }), {
          status: 500, cache: 'no-store', body: { statusCode: 500, message: 'Internal server error' },
        });
        assert.equal(loggedErrors.length, 1);
        assert.equal(loggedErrors[0][0], fault, 'Unexpected failures must still be logged.');
      }
    });
  }, [() => app?.close(), () => errorLog.mock.restore()]);
});

test('D1.3 real HTTP/PostgreSQL acceptance, read-only fixtures', { timeout: 45000 }, async (t) => {
  assert.equal(process.env.D1_3_INTEGRATION, '1', 'Explicit opt-in required; no mock fallback.');
  const config = loadConfig();
  const url = new URL(config.databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55432');
  const db = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 2000,
    query_timeout: 2000, statement_timeout: 1500 });
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let outage: Awaited<ReturnType<typeof createApplication>> | undefined;
  let probe: ReturnType<typeof createServer> | undefined;
  let before: (CourseOffer & { tenant_id: string; active: boolean })[] | undefined;
  const snapshot = async () => (await db.query('SELECT * FROM course_offers ORDER BY offer_id')).rows;
  await withCleanup(async () => {
    const identity = (await db.query('SELECT current_database() AS db, current_user AS owner, version() AS version')).rows[0];
    assert.equal(identity.db, 'p3_d12'); assert.equal(identity.owner, 'p3_d12');
    console.log('D1.3 SQL identity:', identity.db, identity.owner, identity.version.split(' on ')[0]);
    assert.deepEqual((await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows,
      [{ tablename: 'course_offers' }], 'Unexpected public tables: stop.');
    before = await snapshot();
    assert.deepEqual(before, fixtures, 'Unexpected fixture state: refuse tests.');
    app = await createApplication(config);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const request = async (body: unknown = maria, token: string | undefined = config.tokenA,
      path = '/recommendations', headers: Record<string, string> = {}, raw = false, origin = base) => {
      const response = await fetch(origin + path, { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
      }, body: raw ? String(body) : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, body: await response.json() };
    };
    const expected = (ids: string[]) => ({ recommendations: ids.map((id) => {
      const { tenant_id: _tenant, active: _active, ...row } = before!.find((row) => row.offer_id === id)!;
      return { ...row, reasons };
    }) });
    await t.test('A/C/K/L/M Maria order, persisted facts, inactive exclusion and repeatability', async () => {
      for (let i = 0; i < 3; i++) assert.deepEqual(await request(), { status: 200, body: expected(['p3-a-102', 'p3-a-101']) });
    });
    await t.test('accepted aliases preserve SQL-backed success and no-store', async () => {
      for (const path of recommendationPaths) {
        // fetch takes an origin-form path; absolute-form targets are covered in-process.
        if (!path.startsWith('/')) continue;
        assert.deepEqual(await request(maria, config.tokenA, path),
          { status: 200, body: expected(['p3-a-102', 'p3-a-101']) });
      }
    });
    await t.test('B/C/E/J Academy B exact prerequisite and tenant isolation', async () => {
      assert.deepEqual(await request({ ...maria, known_skills: [] }, config.tokenB), { status: 200, body: expected(['p3-b-101']) });
      assert.deepEqual(await request({ ...maria, known_skills: ['basic-sql'] }, config.tokenB),
        { status: 200, body: expected(['p3-b-102', 'p3-b-101']) });
    });
    await t.test('D/E bidirectional query/header spoofing and body authority rejection', async () => {
      assert.deepEqual(await request(maria, config.tokenA, '/recommendations?tenant_id=academy-b',
        { 'x-tenant-id': 'academy-b', tenant_id: 'academy-b', 'academy-id': 'academy-b' }),
      { status: 200, body: expected(['p3-a-102', 'p3-a-101']) });
      assert.deepEqual(await request(maria, config.tokenB, '/recommendations?tenant_id=academy-a', { 'x-tenant-id': 'academy-a' }),
        { status: 200, body: expected(['p3-b-101']) });
      for (const key of ['tenant_id', 'academy_id', 'eligibility_override', 'checkout_authorized', 'model']) {
        assert.deepEqual(await request({ ...maria, [key]: 'override' }), { status: 400, body: badRequest });
      }
    });
    await t.test('F missing/invalid credential sanitized 401', async () => {
      for (const token of ['', 'invalid', 'x'.repeat(32)]) {
        assert.deepEqual(await request(maria, token), { status: 401, body: {
          message: 'Valid demo bearer credential required.', error: 'Unauthorized', statusCode: 401,
        } });
      }
    });
    await t.test('G invalid, malformed, oversized and incorrect-content-type JSON sanitized 400', async () => {
      for (const body of [null, [], {}, { ...maria, budget_cents: '30000' }, { ...maria, budget_cents: 1.2 },
        { ...maria, known_skills: ['basic-python\n'] }, { ...maria, weekly_hours: 0 }, { ...maria, weekly_hours: '6' }, { ...maria, known_skills: ['Basic-python'] },
        { ...maria, known_skills: ['basic-python', 'basic-python'] }, { budget_cents: 30000, weekly_hours: 6 }]) {
        assert.deepEqual(await request(body), { status: 400, body: badRequest });
      }
      for (const raw of ['{"private-marker":', '1', 'null', '', '{"budget_cents":1e999}', 'x'.repeat(110000)]) {
        const response = await request(raw, config.tokenA, '/recommendations', {}, true);
        assert.deepEqual(response, { status: 400, body: badRequest });
        assert.doesNotMatch(JSON.stringify(response.body), /private-marker|SyntaxError|stack|Unexpected/);
      }
      for (const type of ['', 'text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=bogus']) {
        assert.deepEqual(await request(maria, config.tokenA, '/recommendations', { 'Content-Type': type }),
          { status: 400, body: badRequest });
      }
    });
    await t.test('H/I/J valid no-match and exact budget/time/prerequisite boundaries', async () => {
      for (const body of [{ ...maria, budget_cents: 0 }, { ...maria, weekly_hours: 1 }]) {
        assert.deepEqual(await request(body), { status: 200, body: { recommendations: [] } });
      }
      for (const body of [{ ...maria, weekly_hours: 5 }, { ...maria, budget_cents: 23999 }, { ...maria, known_skills: [] }]) {
        assert.deepEqual(await request(body), { status: 200, body: expected(['p3-a-101']) });
      }
      assert.deepEqual(await request({ ...maria, budget_cents: 24000 }), { status: 200, body: expected(['p3-a-102', 'p3-a-101']) });
    });
    await t.test('O health and catalog regression', async () => {
      const health = await fetch(base + '/health'); assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok' });
      for (const [tenant, token] of [['academy-a', config.tokenA], ['academy-b', config.tokenB]]) {
        const response = await fetch(base + '/catalog/offers', { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        const rows = (before as (CourseOffer & { tenant_id: string; active: boolean })[])
          .filter((r) => r.tenant_id === tenant && r.active).map(({ tenant_id: _tenant, active: _active, ...row }) => row);
        assert.deepEqual(await response.json(), rows);
      }
    });
    await t.test('N real unreachable PostgreSQL is sanitized 503, never empty 200', async () => {
      probe = createServer();
      await new Promise<void>((resolve, reject) => { probe!.once('error', reject); probe!.listen(0, '127.0.0.1', resolve); });
      const address = probe.address(); assert.ok(address && typeof address !== 'string');
      const closedPort = address.port;
      await new Promise<void>((resolve, reject) => probe!.close((error) => error ? reject(error) : resolve()));
      url.port = String(closedPort);
      outage = await createApplication({ ...config, databaseUrl: url.toString() });
      await outage.listen(0, '127.0.0.1');
      const outageBase = await outage.getUrl();
      assert.deepEqual(await request(maria, config.tokenA, '/recommendations', {}, false, outageBase), {
        status: 503, body: { message: 'Catalog temporarily unavailable.', error: 'Service Unavailable', statusCode: 503 },
      });
      assert.equal((await fetch(outageBase + '/health')).status, 200);
    });
  }, [
    async () => {
      if (before) {
        const after = await snapshot(); assert.deepEqual(after, before, 'Complete fixture state changed.');
        console.log('Six complete fixture rows unchanged; SHA-256:', createHash('sha256').update(JSON.stringify(after)).digest('hex'));
      }
    },
    () => probe?.listening ? new Promise<void>((resolve, reject) => probe!.close((e) => e ? reject(e) : resolve())) : undefined,
    () => outage?.close(), () => app?.close(), () => db.end(),
  ]);
});
