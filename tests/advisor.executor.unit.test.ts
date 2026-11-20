import 'reflect-metadata';
import assert from 'node:assert/strict';
import subprocess, { type SpawnOptionsWithStdioTuple } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test, mock } from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Server, Socket } from 'node:net';
import { Pool } from 'pg';
import { AppModule, createApplication, FAKE_ADVISOR_MODEL, type ApplicationOverrides } from '../src/app.module.js';
import { ADVISOR } from '../src/ai/advisor.controller.js';
import { AdvisorService } from '../src/ai/advisor.service.js';
import { RecommendationsExecutor } from '../src/ai/advisor.executor.js';
import type { ModelClient, ModelRequest } from '../src/ai/model.client.js';
import { CatalogRepository, CATALOG_SQL } from '../src/catalog/catalog.repository.js';
import type { CourseOffer, TenantId } from '../src/catalog/catalog.types.js';
import { RecommendationsService } from '../src/recommendations/recommendations.service.js';
import { recommend, validateRecommendationRequest, REASONS } from '../src/recommendations/recommendations.policy.js';
import { OFFER_RANKER, type OfferRanker } from '../src/recommendations/ranking.js';

const config = { databaseUrl: 'postgresql://p3_d12:offline-placeholder@127.0.0.1:55432/p3_d12',
  tokenA: 'offline-placeholder-academy-a-0000', tokenB: 'offline-placeholder-academy-b-0000', port: 3000 };
const request = validateRecommendationRequest({ budget_cents: 30000, weekly_hours: 6, known_skills: ['basic-python'] });
const tenant = Object.freeze({ tenantId: 'academy-a' as const });
const signal = () => new AbortController().signal;
const failure = (code: string) => ({ status: 'error', code });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function offline(run: () => Promise<void>) {
  const blocked = [mock.method(Pool.prototype, 'connect', () => { throw new Error('Real pool connection forbidden'); }),
    mock.method(Pool.prototype, 'query', () => { throw new Error('Real pool query forbidden'); }),
    mock.method(Server.prototype, 'listen', () => { throw new Error('TCP listening forbidden'); }),
    mock.method(Socket.prototype, 'connect', () => { throw new Error('Network connection forbidden'); })];
  try { await run(); }
  finally {
    const counts = blocked.map((m) => m.mock.callCount());
    for (const m of blocked) m.mock.restore();
    assert.deepEqual(counts, [0, 0, 0, 0], 'No real SQL, listener or outbound connection attempts.');
  }
}

test('B3B adapter', async (t) => offline(async () => {
  await t.test('exact forwarding once, no mutation, and identical result object', async () => {
    const result = Object.freeze({ recommendations: [] }); let count = 0;
    const cancellation = signal();
    const fake = { recommendations: async (scope: unknown, args: unknown, forwardedSignal: unknown) => {
      count++; assert.equal(scope, tenant); assert.equal(args, request); assert.equal(forwardedSignal, cancellation); return result;
    } } as unknown as RecommendationsService;
    const before = JSON.stringify([tenant, request]);
    assert.equal(await new RecommendationsExecutor(fake).execute(tenant, request, cancellation), result);
    assert.equal(count, 1); assert.equal(JSON.stringify([tenant, request]), before);
  });
  await t.test('successful nonempty facts retain every field without rewriting', async () => {
    const result = { recommendations: [{ offer_id: 'test-owned', title: 'Test fixture', price_cents: 123,
      currency: 'USD', required_skills: [], weekly_study_hours: 1, reasons: [...REASONS] }] };
    const before = structuredClone(result);
    const fake = { recommendations: async () => result } as unknown as RecommendationsService;
    assert.equal(await new RecommendationsExecutor(fake).execute(tenant, request, signal()), result);
    assert.deepEqual(result, before);
  });
  await t.test('original rejection propagates unchanged and is never retried', async () => {
    const original = new Error('Synthetic business failure'); let count = 0;
    const fake = { recommendations: async () => { count++; throw original; } } as unknown as RecommendationsService;
    await assert.rejects(new RecommendationsExecutor(fake).execute(tenant, request, signal()), (e) => e === original);
    assert.equal(count, 1);
  });
  await t.test('already aborted signal prevents all service calls', async () => {
    const cancellation = new AbortController(); const reason = new Error('Cancelled before entry'); cancellation.abort(reason);
    let count = 0;
    const fake = { recommendations: async () => { count++; return { recommendations: [] }; } } as unknown as RecommendationsService;
    await assert.rejects(new RecommendationsExecutor(fake).execute(tenant, request, cancellation.signal), (e) => e === reason);
    assert.equal(count, 0);
  });
  await t.test('abort after asynchronous service settlement prevents returning the result', async () => {
    const cancellation = new AbortController(); const result = deferred<{ recommendations: [] }>();
    let count = 0;
    const fake = { recommendations: () => { count++; return result.promise; } } as unknown as RecommendationsService;
    const pending = new RecommendationsExecutor(fake).execute(tenant, request, cancellation.signal);
    const reason = new Error('Cancelled before adapter continuation');
    result.resolve({ recommendations: [] }); cancellation.abort(reason);
    await assert.rejects(pending, (e) => e === reason); assert.equal(count, 1);
  });
  await t.test('a cancelled pending database read cannot start ranking when it completes', async () => {
    const read = deferred<CourseOffer[]>();
    const query = mock.fn(() => read.promise);
    const rank = mock.fn(async () => ['owned']);
    const repository = { recommendationCandidates: query } as unknown as CatalogRepository;
    const cancellation = new AbortController();
    const reason = new Error('Cancelled while waiting for synthetic rows');
    const service = new RecommendationsService(repository, { rank });
    const pending = service.recommendations(tenant, request, cancellation.signal);
    assert.equal(query.mock.callCount(), 1);
    cancellation.abort(reason);
    read.resolve([{ offer_id: 'owned', title: 'Offline owned', price_cents: 100, currency: 'USD',
      required_skills: [], weekly_study_hours: 1 }]);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(rank.mock.callCount(), 0);
  });
}));

type FixtureRow = CourseOffer & { tenant_id: TenantId; active: boolean };
const row = (tenantId: TenantId, id: string, hours: number, price: number, skills: string[] = [], active = true): FixtureRow =>
  ({ tenant_id: tenantId, offer_id: id, title: `Offline ${id}`, weekly_study_hours: hours, price_cents: price,
    required_skills: skills, currency: 'USD', active });
const rows = [row('academy-a', 'a-foundations', 4, 12000), row('academy-a', 'a-backend', 6, 24000, ['basic-python']),
  row('academy-a', 'a-advanced', 6, 1000, ['advanced-python']), row('academy-a', 'a-inactive', 6, 1, [], false),
  row('academy-b', 'b-foundations', 3, 9500), row('academy-b', 'b-data', 5, 18500, ['basic-sql'])];
function poolFixture(input: FixtureRow[] = rows, reject = false) {
  const calls: { sql: string; values: unknown[] }[] = []; let ends = 0;
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    if (reject) throw new Error('PRIVATE database payload');
    assert.ok(sql === CATALOG_SQL || sql === `${CATALOG_SQL} LIMIT $2`);
    const selected = input.filter((r) => r.tenant_id === values[0] && r.active)
      .map(({ tenant_id: _tenant, active: _active, ...offer }) => structuredClone(offer))
      .sort((a, b) => a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0);
    return { rows: values.length === 2 ? selected.slice(0, values[1] as number) : selected };
  }, end: async () => { ends++; } };
  return { pool: pool as unknown as Pool, calls, get ends() { return ends; } };
}
type App = Awaited<ReturnType<typeof createApplication>>;
interface Reply { status: number; cache: string | undefined; body: any }
async function dispatch(app: App, options: { token?: string | null; path?: string; body?: unknown; method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const socket = new Socket(); const incoming = new IncomingMessage(socket);
  const raw = JSON.stringify(options.body ?? { constraints: request, confirmed: true });
  incoming.method = options.method ?? 'POST'; incoming.url = options.path ?? '/advisor/recommendations'; incoming.complete = true;
  incoming.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)),
    ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? config.tokenA}` }), ...options.headers };
  const response = new ServerResponse(incoming); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Reply>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Offline HTTP dispatch timed out')), 3000);
      incoming.once('error', reject); response.once('error', reject); socket.once('error', reject);
      response.end = ((chunk?: unknown) => {
        try { resolve({ status: response.statusCode, cache: response.getHeader('cache-control') as string | undefined,
          body: chunk ? JSON.parse(String(chunk)) : null }); } catch (e) { reject(e); }
        return response;
      }) as typeof response.end;
      app.getHttpServer().emit('request', incoming, response);
      incoming.push(Buffer.from(raw)); incoming.push(null);
    });
  } finally { clearTimeout(timer); incoming.destroy(); response.destroy(); socket.destroy(); }
}
async function withApp(run: (app: App, db: ReturnType<typeof poolFixture>) => Promise<void>,
  input = rows, overrides: ApplicationOverrides = { advisorMode: 'fake-model-postgres' }, reject = false) {
  const db = poolFixture(input, reject);
  const app = await createApplication(config, { ...overrides, databasePool: db.pool });
  try { await app.init(); await run(app, db); }
  finally { await app.close(); assert.equal(db.ends, 1, 'Repository lifecycle closes injected pool exactly once.'); }
}
const ids = (reply: Reply): string[] => reply.body.response.recommendations.map((r: CourseOffer) => r.offer_id);

test('B3B HTTP fake-pool', { timeout: 15000 }, async (t) => offline(async () => {
  await t.test('omitted mode remains closed; explicit override remains available; conflicts reject', async () => {
    await withApp(async (app, db) => {
      assert.deepEqual(await dispatch(app, { path: '/advisor/recommendations?advisorMode=fake-model-postgres',
        headers: { 'x-advisor-mode': 'fake-model-postgres' } }),
      { status: 503, cache: 'no-store', body: failure('ADVISOR_UNAVAILABLE') });
      assert.equal(db.calls.length, 0);
    }, rows, {});
    const explicit = new AdvisorService({ request: async () => '{"kind":"refusal"}' },
      { execute: async () => { throw new Error('Must not execute'); } });
    await withApp(async (app) => {
      assert.equal(app.get(ADVISOR), explicit);
      assert.deepEqual((await dispatch(app)).body, { status: 'refused', code: 'MODEL_REFUSAL' });
    }, rows, { advisor: explicit });
    assert.throws(() => AppModule.register(config, { advisorMode: 'unknown' } as unknown as ApplicationOverrides), /Unsupported advisor composition mode/);
    assert.throws(() => AppModule.register(config, { advisorMode: 'fake-model-postgres', advisor: explicit }), /cannot be combined/);
  });
  await t.test('real DI chain, authenticated SQL parameters, authorized final model facts and both tenants', async () => {
    await withApp(async (app, db) => {
      assert.ok(app.get(ADVISOR) instanceof AdvisorService);
      assert.ok(app.get(RecommendationsExecutor) instanceof RecommendationsExecutor);
      assert.ok(app.get(RecommendationsService) instanceof RecommendationsService);
      assert.ok(app.get(CatalogRepository) instanceof CatalogRepository);
      const model = app.get<ModelClient>(FAKE_ADVISOR_MODEL); const capture = mock.method(model, 'request');
      try {
        for (const [token, scope, skills, expected] of [
          [config.tokenA, 'academy-a', ['basic-python'], ['a-backend', 'a-foundations']],
          [config.tokenB, 'academy-b', ['basic-sql'], ['b-data', 'b-foundations']],
        ] as const) {
          const reply = await dispatch(app, { token, body: { constraints: { ...request, known_skills: skills }, confirmed: true } });
          assert.equal(reply.status, 200); assert.equal(reply.cache, 'no-store'); assert.deepEqual(ids(reply), expected);
          assert.deepEqual(db.calls.at(-1), { sql: `${CATALOG_SQL} LIMIT $2`, values: [scope, 1001] });
          assert.match(db.calls.at(-1)!.sql, /WHERE tenant_id = \$1 AND active = TRUE/);
          const initial = capture.mock.calls.at(-2)!.arguments[0];
          const final = capture.mock.calls.at(-1)!.arguments[0];
          assert.deepEqual(Object.keys(initial), ['phase', 'constraints']);
          assert.equal(final.phase, 'final');
          if (final.phase !== 'final') assert.fail();
          assert.deepEqual(final.facts.recommendations.map((r) => r.offer_id), expected);
          assert.equal(JSON.stringify([initial, final]).includes('tenantId'), false);
          assert.equal(JSON.stringify([initial, final]).includes(token), false);
          const expectedIds = new Set<string>(expected);
          const source = rows.filter((r) => expectedIds.has(r.offer_id))
            .map(({ tenant_id: _tenant, active: _active, ...offer }) => offer);
          for (const offer of reply.body.response.recommendations) {
            assert.deepEqual(offer, { ...source.find((r) => r.offer_id === offer.offer_id), reasons: [...REASONS] });
          }
        }
        assert.equal(capture.mock.callCount(), 4); assert.equal(db.calls.length, 2);
      } finally { capture.mock.restore(); }
    });
  });
  await t.test('missing/invalid credentials and body authority cause no model or SQL execution', async () => {
    await withApp(async (app, db) => {
      const capture = mock.method(app.get<ModelClient>(FAKE_ADVISOR_MODEL), 'request');
      try {
        for (const token of [null, 'invalid', 'x'.repeat(32)]) assert.equal((await dispatch(app, { token })).status, 401);
        for (const body of [{ constraints: request, confirmed: true, tenantId: 'academy-b' },
          { constraints: { ...request, tenant_id: 'academy-b' }, confirmed: true },
          { constraints: request, confirmed: true, advisorMode: 'fake-model-postgres' }]) assert.equal((await dispatch(app, { body })).status, 400);
        assert.equal(capture.mock.callCount(), 0); assert.equal(db.calls.length, 0);
      } finally { capture.mock.restore(); }
    });
  });
  await t.test('opposite-tenant query/header claims cannot override either authenticated tenant', async () => {
    await withApp(async (app, db) => {
      for (const [token, scope, other, expected] of [
        [config.tokenA, 'academy-a', 'academy-b', ['a-backend', 'a-foundations']],
        [config.tokenB, 'academy-b', 'academy-a', ['b-foundations']],
      ] as const) {
        const reply = await dispatch(app, { token, path: `/advisor/recommendations?tenantId=${other}&tenant_id=${other}`,
          headers: { 'x-tenant-id': other, tenant_id: other } });
        assert.equal(reply.status, 200); assert.deepEqual(ids(reply), expected);
        assert.deepEqual(db.calls.at(-1)!.values, [scope, 1001]);
      }
    });
  });
  await t.test('model tenant arguments are rejected before repository access', async () => {
    await withApp(async (app, db) => {
      const capture = mock.method(app.get<ModelClient>(FAKE_ADVISOR_MODEL), 'request', async () => JSON.stringify({
        kind: 'tool_proposals', proposals: [{ name: 'find_suitable_courses', arguments: JSON.stringify({ ...request, tenantId: 'academy-b' }) }] }));
      try { assert.deepEqual(await dispatch(app), { status: 502, cache: 'no-store', body: failure('ADVISOR_PROTOCOL_ERROR') });
        assert.equal(db.calls.length, 0); assert.equal(capture.mock.callCount(), 1);
      } finally { capture.mock.restore(); }
    });
  });
  await t.test('existing exact prerequisites, USD, budgets and ranking tie-breaks are authoritative', async () => {
    const candidates = [row('academy-a', 'z', 4, 1), row('academy-a', 'c', 6, 200), row('academy-a', 'b', 6, 100),
      row('academy-a', 'a', 6, 100), row('academy-a', 'blocked', 6, 0, ['python']),
      { ...row('academy-a', 'eur', 6, 0), currency: 'EUR' }, row('academy-a', 'expensive', 6, 30001)];
    await withApp(async (app) => {
      assert.deepEqual(ids(await dispatch(app)), ['a', 'b', 'c', 'z']);
      assert.deepEqual(ids(await dispatch(app, { body: { constraints: { ...request, weekly_hours: 4 }, confirmed: true } })), ['z']);
    }, candidates);
    await withApp(async (app) => {
      assert.deepEqual(ids(await dispatch(app, { body: { constraints: { ...request, known_skills: [] }, confirmed: true } })), ['a-foundations']);
    });
  });
  await t.test('1000 candidates accepted with deterministic ten-result cap; 1001 refuses without final phase', async () => {
    for (const size of [1000, 1001]) {
      const candidates = Array.from({ length: size }, (_, i) => row('academy-a', `id-${String(i).padStart(4, '0')}`, 2, 1));
      await withApp(async (app, db) => {
        const capture = mock.method(app.get<ModelClient>(FAKE_ADVISOR_MODEL), 'request');
        try {
          const reply = await dispatch(app);
          if (size === 1000) {
            assert.equal(reply.status, 200); assert.deepEqual(ids(reply), candidates.slice(0, 10).map((r) => r.offer_id));
            assert.equal(capture.mock.callCount(), 2);
          } else {
            assert.deepEqual(reply, { status: 503, cache: 'no-store', body: failure('ADVISOR_UNAVAILABLE') });
            assert.equal(capture.mock.callCount(), 1);
          }
          assert.equal(db.calls.length, 1); assert.deepEqual(db.calls[0].values, ['academy-a', 1001]);
        } finally { capture.mock.restore(); }
      }, candidates);
    }
  });
  await t.test('successful empty query and no-match remain 200; dependency rejection remains sanitized 503', async () => {
    await withApp(async (app) => assert.deepEqual((await dispatch(app)).body,
      { status: 'completed', response: { source: 'accepted_plan', recommendations: [] } }), []);
    await withApp(async (app) => {
      const reply = await dispatch(app, { body: { constraints: { ...request, budget_cents: 0 }, confirmed: true } });
      assert.equal(reply.status, 200); assert.deepEqual(ids(reply), []);
    });
    await withApp(async (app, db) => {
      const capture = mock.method(app.get<ModelClient>(FAKE_ADVISOR_MODEL), 'request');
      try { assert.deepEqual(await dispatch(app), { status: 503, cache: 'no-store', body: failure('ADVISOR_UNAVAILABLE') });
        assert.equal(db.calls.length, 1); assert.equal(capture.mock.callCount(), 1);
      } finally { capture.mock.restore(); }
    }, rows, { advisorMode: 'fake-model-postgres' }, true);
  });
  await t.test('existing health, catalog and recommendation routes retain behavior in enabled mode', async () => {
    await withApp(async (app, db) => {
      assert.deepEqual(await dispatch(app, { path: '/health', method: 'GET' }), { status: 200, cache: undefined, body: { status: 'ok' } });
      assert.equal((await dispatch(app, { path: '/catalog/offers', method: 'GET', token: null })).status, 401);
      const catalog = await dispatch(app, { path: '/catalog/offers', method: 'GET', token: config.tokenB });
      assert.equal(catalog.status, 200); assert.equal(catalog.cache, 'no-store');
      assert.deepEqual(catalog.body.map((r: CourseOffer) => r.offer_id), ['b-data', 'b-foundations']);
      const recommendations = await dispatch(app, { path: '/recommendations', body: request });
      assert.equal(recommendations.status, 200); assert.equal(recommendations.cache, 'no-store');
      assert.deepEqual(recommendations.body.recommendations.map((r: CourseOffer) => r.offer_id), ['a-backend', 'a-foundations']);
      assert.equal(db.calls.length, 2);
    });
  });
}));

test('default application keeps TypeScript ranking and ignores external mode selection', async () => offline(async () => {
  const spawn = mock.method(subprocess, 'spawn');
  syncBuiltinESMExports();
  try {
    await withApp(async (app) => {
      const path = '/recommendations?rustRankerPath=/unused';
      const result = await dispatch(app, { path, body: request, headers: { 'x-ranking-mode': 'rust' } });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, recommend(rows.filter((r) => r.tenant_id === 'academy-a' && r.active), request));
      assert.equal((await dispatch(app, { path, body: { ...request, rustRankerPath: '/unused' } })).status, 400);
    }, rows, {});
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
}));

const rankerBinary = process.env.P3_D3_R2_RANKER;
test('D3-R2 composed HTTP and advisor with release Rust and a fake pool', { skip: !rankerBinary }, async (t) => offline(async () => {
  const overrides = { advisorMode: 'fake-model-postgres', rustRankerPath: rankerBinary } as const;
  const candidates = [...rows, row('academy-a', '𐀀', 6, 100, ['basic-python']), row('academy-a', '\ue000', 6, 100),
    row('academy-a', 'too-long', 7, 0), row('academy-a', 'too-costly', 6, 30001),
    { ...row('academy-a', 'foreign-currency', 6, 0), currency: 'EUR' }];
  await t.test('both tenants, exact fields and advisor grounding', async () => {
    let ranker: OfferRanker | undefined;
    await withApp(async (app, db) => {
      ranker = app.get<OfferRanker>(OFFER_RANKER);
      const spy = mock.method(ranker, 'rank');
      const model = mock.method(app.get<ModelClient>(FAKE_ADVISOR_MODEL), 'request');
      try {
        for (const [token, scope, other, skills, ordered] of [
          [config.tokenA, 'academy-a', 'academy-b', ['basic-python'], ['𐀀', '\ue000', 'a-backend', 'a-foundations']],
          [config.tokenB, 'academy-b', 'academy-a', ['basic-sql'], ['b-data', 'b-foundations']],
        ] as const) {
          const constraints = { ...request, known_skills: skills };
          const expected = recommend(candidates.filter((r) => r.tenant_id === scope && r.active), constraints);
          assert.deepEqual(expected.recommendations.map((offer) => offer.offer_id), ordered);
          const reply = await dispatch(app, { token, path: '/recommendations?tenantId=' + other,
            headers: { 'x-tenant-id': other }, body: constraints });
          assert.deepEqual(reply, { status: 200, cache: 'no-store', body: expected });
          const advice = await dispatch(app, { token, body: { confirmed: true, constraints } });
          assert.equal(advice.status, 200);
          assert.deepEqual(advice.body, { status: 'completed', response: { source: 'accepted_plan', ...expected } });
          assert.deepEqual(db.calls.slice(-2), Array(2).fill({ sql: CATALOG_SQL + ' LIMIT $2', values: [scope, 1001] }));
          const sent = spy.mock.calls.at(-1)!.arguments[0];
          assert.deepEqual(sent.map((offer) => offer.offer_id).sort(), [...ordered].sort());
          for (const offer of sent) assert.deepEqual(Object.keys(offer).sort(), ['offer_id', 'price_cents', 'weekly_study_hours']);
          const final = model.mock.calls.at(-1)!.arguments[0];
          assert.equal(final.phase, 'final');
          if (final.phase === 'final') assert.deepEqual(final.facts, { source: 'deterministic_fallback', ...expected });
        }
        assert.deepEqual(await dispatch(app, { path: '/recommendations', body: { ...request, budget_cents: 0 } }),
          { status: 200, cache: 'no-store', body: { recommendations: [] } });
        assert.equal((await dispatch(app, { token: null, path: '/recommendations', body: request })).status, 401);
        assert.equal(spy.mock.callCount(), 4);
      } finally {
        spy.mock.restore();
        model.mock.restore();
      }
    }, candidates, overrides);
    assert.ok(ranker);
    await assert.rejects(ranker.rank([]), /temporarily unavailable/);
  });
  await t.test('both routes preserve an 80-supplementary-character ID through the real Rust process', async () => {
    const id = '🦀'.repeat(80);
    assert.equal([...id].length, 80);
    const { tenant_id, active, ...offer } = row('academy-a', id, 6, 18765, ['basic-python']);
    const expected = { recommendations: [{ ...offer, reasons: [...REASONS] }] };
    const payloads: unknown[] = [];
    const spawn = subprocess.spawn;
    const intercepted = mock.method(subprocess, 'spawn',
      (file: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>) => {
        const child = spawn(file, args, options);
        const end = child.stdin.end.bind(child.stdin);
        mock.method(child.stdin, 'end', (payload: Buffer) => {
          payloads.push(JSON.parse(payload.toString('utf8')));
          return end(payload);
        });
        return child;
      });
    syncBuiltinESMExports();
    try {
      await withApp(async (app, db) => {
        assert.deepEqual(await dispatch(app, { path: '/recommendations', body: request }),
          { status: 200, cache: 'no-store', body: expected });
        assert.deepEqual(await dispatch(app),
          { status: 200, cache: 'no-store', body: { status: 'completed', response: { source: 'accepted_plan', ...expected } } });
        assert.deepEqual(db.calls, Array(2).fill({ sql: CATALOG_SQL + ' LIMIT $2', values: [tenant_id, 1001] }));
      }, [{ ...offer, tenant_id, active }, row('academy-b', 'other-tenant-offer', 6, 1)], overrides);
      const rustRequest = { protocol_version: 1, offers: [
        { offer_id: id, price_cents: offer.price_cents, weekly_study_hours: offer.weekly_study_hours },
      ] };
      assert.deepEqual(payloads, [rustRequest, rustRequest]);
      assert.equal(intercepted.mock.callCount(), 2);
      for (const call of intercepted.mock.calls) assert.deepEqual(call.arguments, [
        rankerBinary, [], { shell: false, env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
      ]);
    } finally {
      intercepted.mock.restore();
      syncBuiltinESMExports();
    }
  });
  await t.test('only bounded and valid catalog rows can reach the ranker', async () => {
    const bounded = Array.from({ length: 1000 }, (_, i) => row('academy-a', 'id-' + String(i).padStart(4, '0'), 2, 1));
    await withApp(async (app) => {
      const result = await dispatch(app, { path: '/recommendations', body: request });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, recommend(bounded, request));
      assert.equal(result.body.recommendations.length, 10);
    }, bounded, overrides);
    for (const invalid of [
      [...bounded, row('academy-a', 'overflow', 2, 1)],
      [row('academy-a', 'negative-even-if-ineligible', 7, -1)],
      [{ ...rows[0], required_skills: [null] } as unknown as FixtureRow],
      [{ ...rows[0], title: '   ' }],
      [{ ...rows[0], currency: 'usd' }],
      [rows[0], rows[0]],
    ]) {
      await withApp(async (app, db) => {
        const spy = mock.method(app.get<OfferRanker>(OFFER_RANKER), 'rank');
        try {
          assert.equal((await dispatch(app, { path: '/recommendations', body: request })).status, 503);
          assert.equal(spy.mock.callCount(), 0);
          assert.deepEqual(db.calls, [{ sql: CATALOG_SQL + ' LIMIT $2', values: ['academy-a', 1001] }]);
        } finally { spy.mock.restore(); }
      }, invalid, overrides);
    }
  });
  await t.test('ranking failure becomes a sanitized 503 on both routes, with no final model phase', async () => {
    await withApp(async (app) => {
      const model = mock.method(app.get<ModelClient>(FAKE_ADVISOR_MODEL), 'request');
      try {
        assert.deepEqual(await dispatch(app, { path: '/recommendations', body: request }), {
          status: 503, cache: 'no-store', body: {
            statusCode: 503, error: 'Service Unavailable', message: 'Recommendation ranking temporarily unavailable.',
          },
        });
        assert.deepEqual(await dispatch(app), { status: 503, cache: 'no-store', body: failure('ADVISOR_UNAVAILABLE') });
        assert.equal(model.mock.callCount(), 1);
      } finally { model.mock.restore(); }
    }, rows, { ...overrides, rustRankerPath: rankerBinary + '/not-an-executable' });
  });
}));
