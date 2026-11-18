import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Server, Socket } from 'node:net';
import { Pool } from 'pg';
import { createApplication } from '../src/app.module.js';
import { AdvisorService, type BusinessExecutor, type AdvisorRuntime } from '../src/ai/advisor.service.js';
import { MAX_ADVISOR_RESPONSE_BYTES } from '../src/ai/advisor.controller.js';
import type { ModelClient } from '../src/ai/model.client.js';
import { REASONS } from '../src/recommendations/recommendations.policy.js';

const config = { databaseUrl: 'postgresql://p3_d12:offline-placeholder@127.0.0.1:55432/p3_d12',
  tokenA: 'offline-placeholder-academy-a-0000', tokenB: 'offline-placeholder-academy-b-0000', port: 3000 };
const constraints = { budget_cents: 30000, weekly_hours: 6, known_skills: ['basic-python'] };
const envelope = { constraints, confirmed: true };
const auth = (token = config.tokenA) => ({ authorization: `Bearer ${token}` });
const error = (code: string) => ({ status: 'error', code });
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function fixture(options: { initial?: string; model?: ModelClient; business?: BusinessExecutor; clock?: AdvisorRuntime } = {}) {
  const calls: unknown[] = [], reads: string[] = [];
  const model: ModelClient = { request: async (input, signal) => {
    calls.push(input);
    if (options.model) return options.model.request(input, signal);
    return input.phase === 'initial' ? options.initial ?? JSON.stringify({ kind: 'tool_proposals',
      proposals: [{ name: 'find_suitable_courses', arguments: JSON.stringify(input.constraints) }] }) :
      JSON.stringify({ kind: 'explanation', plan: { offers: input.facts.recommendations.map((o) =>
        ({ offer_id: o.offer_id, reason_ids: ['budget', 'hours', 'skills'] })) } });
  } };
  const business: BusinessExecutor = { execute: async (tenant, args, signal) => {
    reads.push(tenant.tenantId);
    if (options.business) return options.business.execute(tenant, args, signal);
    // Test-owned facts only, never installed in ordinary application registration.
    return { recommendations: [{ offer_id: `${tenant.tenantId}-offline`, title: 'Offline fixture',
      price_cents: 100, currency: 'USD', weekly_study_hours: 2, required_skills: [], reasons: [...REASONS] }] };
  } };
  return { advisor: new AdvisorService(model, business, options.clock), calls, reads };
}
interface Reply { status: number; cache: string | undefined; body: unknown }
type App = Awaited<ReturnType<typeof createApplication>>;
function start(app: App, path = '/advisor/recommendations', raw = JSON.stringify(envelope),
  headers: Record<string, string> = auth(), method = 'POST') {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.method = method; request.url = path;
  request.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)), ...headers };
  request.complete = true;
  const response = new ServerResponse(request);
  let writes = 0;
  let resolve!: (reply: Reply) => void;
  let reject!: (reason: unknown) => void;
  const done = new Promise<Reply>((yes, no) => { resolve = yes; reject = no; });
  response.end = ((chunk?: unknown) => {
    writes++;
    try { resolve({ status: response.statusCode, cache: response.getHeader('cache-control') as string | undefined,
      body: chunk ? JSON.parse(String(chunk)) : null }); } catch (e) { reject(e); }
    return response;
  }) as typeof response.end;
  request.on('error', reject); response.on('error', reject); socket.on('error', reject);
  app.getHttpServer().emit('request', request, response);
  request.push(Buffer.from(raw)); request.push(null);
  return { request, response, done, get writes() { return writes; },
    cleanup() { request.destroy(); response.destroy(); socket.destroy(); } };
}
async function dispatch(app: App, path?: string, raw?: string, headers?: Record<string, string>, method?: string) {
  const h = start(app, path, raw, headers, method);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([h.done, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Offline dispatch timeout')), 3500);
  })]); } finally { clearTimeout(timer); h.cleanup(); }
}
async function withApp(run: (app: App, sql: string[]) => Promise<void>, advisor?: AdvisorService) {
  const sql: string[] = [];
  const fakePool = { query: async (statement: string) => { sql.push(statement); return { rows: [] }; }, end: async () => {} };
  const app = await createApplication(config, { databasePool: fakePool as unknown as Pool, advisor });
  try { await app.init(); await run(app, sql); } finally { await app.close(); }
}

test('B3A offline HTTP boundary, with real parser/guard/filter and no sockets or real SQL', { timeout: 20000 }, async (t) => {
  const connect = mock.method(Pool.prototype, 'connect', () => { throw new Error('Real PostgreSQL forbidden'); });
  const query = mock.method(Pool.prototype, 'query', () => { throw new Error('Real SQL forbidden'); });
  const listen = mock.method(Server.prototype, 'listen', () => { throw new Error('TCP listener forbidden'); });
  try {
    await t.test('normal registration fails closed without an authorized advisor', async () => {
      await withApp(async (app, sql) => {
        assert.deepEqual(await dispatch(app), { status: 503, cache: 'no-store', body: error('ADVISOR_UNAVAILABLE') });
        assert.deepEqual(sql, []);
      });
    });
    await t.test('unauthorized input executes zero advisor, model and business calls', async () => {
      const f = fixture(); const advise = mock.method(f.advisor, 'advise');
      await withApp(async (app, sql) => {
        for (const headers of [{}, auth('invalid'), auth('x'.repeat(32))]) {
          assert.deepEqual(await dispatch(app, undefined, undefined, headers),
            { status: 401, cache: 'no-store', body: error('UNAUTHORIZED') });
        }
        assert.equal(advise.mock.callCount(), 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.reads, []); assert.deepEqual(sql, []);
      }, f.advisor);
    });
    await t.test('both tenants, aliases, query/header spoofing and scoped final model facts', async () => {
      const f = fixture();
      await withApp(async (app) => {
        for (const [token, tenant] of [[config.tokenA, 'academy-a'], [config.tokenB, 'academy-b']]) {
          for (const path of ['/advisor/recommendations', '/Advisor/Recommendations/',
            '/ADVISOR/RECOMMENDATIONS?tenantId=opposite', 'http://offline.invalid/Advisor/Recommendations/?x=1']) {
            const result = await dispatch(app, path, undefined, { ...auth(token), 'x-tenant-id': 'opposite' });
            assert.equal(result.status, 200); assert.equal(result.cache, 'no-store');
            assert.deepEqual(result.body, { status: 'completed', response: { source: 'accepted_plan', recommendations: [
              { offer_id: `${tenant}-offline`, title: 'Offline fixture', price_cents: 100, currency: 'USD',
                weekly_study_hours: 2, required_skills: [], reasons: [...REASONS] },
            ] } });
            assert.equal(f.reads.at(-1), tenant);
            assert.equal(JSON.stringify(f.calls.at(-2)).includes('tenantId'), false);
            assert.equal(JSON.stringify(f.calls.at(-1)).includes(`${tenant}-offline`), true);
            assert.equal(JSON.stringify(f.calls.at(-1)).includes(tenant === 'academy-a' ? 'academy-b' : 'academy-a'), false);
          }
        }
      }, f.advisor);
    });
    await t.test('exact acknowledgement/envelope and existing constraints validation precede all calls', async () => {
      const f = fixture();
      await withApp(async (app) => {
        for (const body of [null, [], {}, { constraints }, { ...envelope, confirmed: false }, { ...envelope, confirmed: 'true' },
          { ...envelope, tenantId: 'academy-b' }, { ...envelope, message: 'recommend something' },
          { ...envelope, constraints: { ...constraints, tenant_id: 'academy-b' } },
          { ...envelope, constraints: { ...constraints, known_skills: undefined } },
          { ...envelope, constraints: { ...constraints, weekly_hours: '6' } }]) {
          assert.deepEqual(await dispatch(app, undefined, JSON.stringify(body)),
            { status: 400, cache: 'no-store', body: error('INVALID_ADVISOR_REQUEST') });
        }
        assert.deepEqual(f.calls, []); assert.deepEqual(f.reads, []);
      }, f.advisor);
    });
    await t.test('parser errors before guards and wrong media types are sanitized on all aliases', async () => {
      const f = fixture();
      await withApp(async (app) => {
        for (const path of ['/advisor/recommendations', '/ADVISOR/Recommendations/', '/advisor/recommendations?q=1']) {
          for (const headers of [{}, auth()]) {
            for (const raw of ['{"private-marker": broken}', 'x'.repeat(102401)]) {
              assert.deepEqual(await dispatch(app, path, raw, headers),
                { status: 400, cache: 'no-store', body: error('INVALID_ADVISOR_REQUEST') });
            }
          }
          for (const type of ['', 'text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=bogus']) {
            assert.deepEqual(await dispatch(app, path, undefined, { ...auth(), 'content-type': type }),
              { status: 400, cache: 'no-store', body: error('INVALID_ADVISOR_REQUEST') });
          }
        }
        assert.deepEqual(f.calls, []); assert.deepEqual(f.reads, []);
      }, f.advisor);
    });
    await t.test('encoded and path lookalikes never dispatch; namespace errors carry no-store', async () => {
      const f = fixture();
      await withApp(async (app) => {
        for (const path of ['/advisor/recommendations-extra', '/advisor/private', '/advisor/recommendations//',
          '/advisor/%72ecommendations', '/%61dvisor/recommendations', '/advisor%2Frecommendations',
          '/advisor/recommendations%2F', '/advisor/../advisor/recommendations']) {
          assert.deepEqual(await dispatch(app, path), { status: 404, cache: 'no-store', body: error('NOT_FOUND') });
          assert.deepEqual(await dispatch(app, path, '{"private-marker": broken}'),
            { status: 400, cache: 'no-store', body: error('INVALID_ADVISOR_REQUEST') });
        }
        assert.deepEqual(await dispatch(app, '/advisor/recommendations', '', {}, 'GET'),
          { status: 404, cache: 'no-store', body: error('NOT_FOUND') });
        for (const path of ['/advisorXYZ', '/other?route=/advisor/recommendations']) {
          const reply = await dispatch(app, path);
          assert.equal(reply.status, 404); assert.equal(reply.cache, undefined);
        }
        assert.deepEqual(f.calls, []); assert.deepEqual(f.reads, []);
      }, f.advisor);
    });
    await t.test('model-injected tenant and confirmed-constraint mismatch never dispatch business', async () => {
      for (const args of [{ ...constraints, tenantId: 'academy-b' }, { ...constraints, budget_cents: 1 }]) {
        const f = fixture({ initial: JSON.stringify({ kind: 'tool_proposals', proposals: [
          { name: 'find_suitable_courses', arguments: JSON.stringify(args) }] }) });
        await withApp(async (app) => assert.deepEqual(await dispatch(app),
          { status: 502, cache: 'no-store', body: error('ADVISOR_PROTOCOL_ERROR') }), f.advisor);
        assert.deepEqual(f.reads, []);
      }
    });
    await t.test('safe empty, refusal, clarification and dependency errors', async () => {
      for (const [options, status, body] of [
        [{ business: { execute: async () => ({ recommendations: [] }) } }, 200,
          { status: 'completed', response: { source: 'accepted_plan', recommendations: [] } }],
        [{ initial: '{"kind":"refusal"}' }, 200, { status: 'refused', code: 'MODEL_REFUSAL' }],
        [{ initial: '{"kind":"clarification","fields":["known_skills"]}' }, 200,
          { status: 'clarification_required', code: 'MODEL_CLARIFICATION' }],
        [{ model: { request: async () => { throw new Error('PRIVATE model payload'); } } }, 503, error('ADVISOR_UNAVAILABLE')],
        [{ business: { execute: async () => { throw new Error('PRIVATE password SQL'); } } }, 503, error('ADVISOR_UNAVAILABLE')],
      ] as const) {
        const f = fixture(options);
        await withApp(async (app) => assert.deepEqual(await dispatch(app), { status, cache: 'no-store', body }), f.advisor);
      }
    });
    await t.test('initial timeout maps 504; final failure preserves successful facts', async () => {
      let time = 0; let expire: (() => void) | undefined;
      const clock: AdvisorRuntime = { now: () => time, setTimer: (fn) => { expire = fn; return 1; }, clearTimer: () => {} };
      const entered = deferred<void>(); const late = deferred<string>();
      const f = fixture({ clock, model: { request: async () => { entered.resolve(); return late.promise; } } });
      await withApp(async (app) => {
        const h = start(app);
        try { await entered.promise; time = 2000; expire!();
          assert.deepEqual(await h.done, { status: 504, cache: 'no-store', body: error('ADVISOR_TIMEOUT') });
          late.resolve('{"kind":"refusal"}'); await flush(); assert.deepEqual(f.reads, []);
        } finally { h.cleanup(); }
      }, f.advisor);
      const g = fixture({ model: { request: async (input) => {
        if (input.phase === 'final') throw new Error('PRIVATE final');
        return JSON.stringify({ kind: 'tool_proposals', proposals: [{ name: 'find_suitable_courses', arguments: JSON.stringify(input.constraints) }] });
      } } });
      await withApp(async (app) => {
        const reply = await dispatch(app); assert.equal(reply.status, 200);
        assert.equal((reply.body as { response: { source: string } }).response.source, 'deterministic_fallback');
      }, g.advisor);
    });
    await t.test('response-close and request-abort cancel initial wait; normal request close does not', async () => {
      for (const event of ['response-close', 'request-abort', 'normal-close']) {
        const entered = deferred<void>(); const late = deferred<string>(); let signal: AbortSignal | undefined;
        const f = fixture({ model: { request: async (input, received) => {
          if (input.phase === 'final') return '{"kind":"explanation","plan":{"offers":[]}}';
          signal = received; entered.resolve(); return late.promise;
        } } });
        await withApp(async (app) => {
          const h = start(app);
          try {
            await entered.promise;
            assert.equal(h.request.listenerCount('aborted'), 1); assert.equal(h.response.listenerCount('close'), 1);
            if (event === 'response-close') h.response.destroy();
            else if (event === 'request-abort') { h.request.aborted = true; h.request.emit('aborted'); }
            else h.request.emit('close');
            await flush();
            if (event === 'normal-close') assert.equal(signal!.aborted, false);
            else { assert.equal(signal!.aborted, true); assert.deepEqual(f.reads, []); assert.equal(h.writes, 0); }
            late.resolve(JSON.stringify({ kind: 'tool_proposals', proposals: [{ name: 'find_suitable_courses', arguments: JSON.stringify(constraints) }] }));
            await flush();
            if (event === 'normal-close') { assert.equal((await h.done).status, 200); assert.equal(f.reads.length, 1); }
            else { assert.deepEqual(f.reads, []); assert.equal(h.writes, 0); }
            assert.equal(h.request.listenerCount('aborted'), 0); assert.equal(h.response.listenerCount('close'), 0);
          } finally { h.cleanup(); }
        }, f.advisor);
      }
    });
    await t.test('response serialization bounds and unexpected exceptions expose no payload', async () => {
      for (const advise of [async () => { throw new Error('PRIVATE exception'); },
        async () => ({ status: 'completed', response: { text: 'é'.repeat(MAX_ADVISOR_RESPONSE_BYTES) } })]) {
        await withApp(async (app) => {
          const reply = await dispatch(app); assert.equal(reply.cache, 'no-store');
          assert.ok([500, 503].includes(reply.status)); assert.equal(JSON.stringify(reply.body).includes('PRIVATE'), false);
          assert.ok(Buffer.byteLength(JSON.stringify(reply.body)) < 200);
        }, { advise } as unknown as AdvisorService);
      }
      // Deliberately injected trusted-code stub isolates the HTTP byte boundary.
      // It is not a model result or a schema accepted by the real B2 service.
      for (const bytes of [MAX_ADVISOR_RESPONSE_BYTES, MAX_ADVISOR_RESPONSE_BYTES + 1]) {
        const result = { status: 'completed', response: { text: '' } };
        result.response.text = 'a'.repeat(bytes - Buffer.byteLength(JSON.stringify(result)));
        assert.equal(Buffer.byteLength(JSON.stringify(result)), bytes);
        await withApp(async (app) => {
          const reply = await dispatch(app);
          if (bytes === MAX_ADVISOR_RESPONSE_BYTES) {
            assert.equal(reply.status, 200); assert.equal(Buffer.byteLength(JSON.stringify(reply.body)), bytes);
          } else assert.deepEqual(reply, { status: 503, cache: 'no-store', body: error('ADVISOR_UNAVAILABLE') });
        }, { advise: async () => result } as unknown as AdvisorService);
      }
    });
    await t.test('existing health/catalog/recommendation endpoints and filter behavior preserved', async () => {
      await withApp(async (app, sql) => {
        assert.deepEqual(await dispatch(app, '/health', '', {}, 'GET'), { status: 200, cache: undefined, body: { status: 'ok' } });
        assert.equal((await dispatch(app, '/catalog/offers', '', {}, 'GET')).status, 401);
        assert.deepEqual(await dispatch(app, '/catalog/offers', '', auth(), 'GET'), { status: 200, cache: 'no-store', body: [] });
        assert.deepEqual(await dispatch(app, '/recommendations', JSON.stringify(constraints)),
          { status: 200, cache: 'no-store', body: { recommendations: [] } });
        assert.deepEqual(await dispatch(app, '/Recommendations/', '{"private": broken}'), { status: 400, cache: 'no-store', body: {
          statusCode: 400, message: 'Invalid recommendation request.', error: 'Bad Request' } });
        assert.equal(sql.length, 2); // Both were served by the injected in-memory pool.
        const unauthorized = await dispatch(app, '/recommendations', JSON.stringify(constraints), {});
        assert.equal(unauthorized.status, 401); assert.equal(unauthorized.cache, 'no-store');
        for (const path of ['/health', '/catalog/offers']) {
          const reply = await dispatch(app, path, '{"private-marker": broken}');
          let expected = '';
          try { JSON.parse('{"private-marker": broken}'); } catch (e) { expected = (e as Error).message; }
          assert.deepEqual(reply, { status: 400, cache: undefined,
            body: { message: expected, error: 'Bad Request', statusCode: 400 } });
        }
      });
    });
    assert.equal(connect.mock.callCount(), 0); assert.equal(query.mock.callCount(), 0); assert.equal(listen.mock.callCount(), 0);
  } finally { connect.mock.restore(); query.mock.restore(); listen.mock.restore(); }
});
