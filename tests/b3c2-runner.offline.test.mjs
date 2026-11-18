import assert from 'node:assert/strict';
import { Server, Socket } from 'node:net';
import { after, before, mock, test } from 'node:test';
import pg from 'pg';
import {
  acceptanceConfig, boundedTransport, executionMode, loadApplication, mockIO, OFFLINE_ENV, runAcceptance,
} from '../scripts/b3c2-live-acceptance.mjs';

const DIGEST = '3b4029e931f5d93e5c74db0a11ae8640a1bab6efe4b84bd0bcd818a19432fca2';
const IDS = ['p3-a-102', 'p3-a-101'];
const SECRET = 'synthetic-test-secret-marker';
const EXPERIMENTAL_LATENCY = 'b3c2f-experimental';
const block = (label) => () => { throw new Error(label); };
let application;
let AppModule;
let ADVISOR;

const blocked = [];
before(async () => {
  blocked.push(
    mock.method(globalThis, 'fetch', block('REAL_FETCH_FORBIDDEN')),
    mock.method(Socket.prototype, 'connect', block('REAL_SOCKET_FORBIDDEN')),
    mock.method(Server.prototype, 'listen', block('REAL_LISTENER_FORBIDDEN')),
    mock.method(pg.Pool.prototype, 'connect', block('REAL_PG_CONNECTION_FORBIDDEN')),
    mock.method(pg.Pool.prototype, 'query', block('REAL_PG_QUERY_FORBIDDEN')),
  );
  const build = process.env.P3_B3C2_TEST_BUILD;
  application = await loadApplication(build);
  ({ AppModule } = await import(`../${build}/src/app.module.js`));
  ({ ADVISOR } = await import(`../${build}/src/ai/advisor.controller.js`));
});
after(() => {
  const calls = blocked.map((entry) => entry.mock.callCount());
  mock.restoreAll();
  assert.deepEqual(calls, [0, 0, 0, 0, 0]);
});

function instrument({ onQuery, onResponse, onEnd } = {}) {
  const fake = mockIO();
  const calls = { pools: [], released: [], ended: [], sql: [], http: [] };
  return {
    calls,
    io: {
      makePool(connection, role) {
        calls.pools.push(role);
        const pool = fake.makePool(connection, role);
        return {
          async connect() {
            const client = await pool.connect();
            return {
              ...client,
              async query(sql, args) {
                calls.sql.push({ role, sql, args });
                return onQuery ? onQuery({ role, sql, args }, () => client.query(sql, args)) : client.query(sql, args);
              },
              release() { calls.released.push(role); client.release(); },
            };
          },
          async end() {
            calls.ended.push(role);
            await onEnd?.(role);
            await pool.end();
          },
        };
      },
      async fetchResponse(url, options) {
        calls.http.push({ url, options });
        const next = () => fake.fetchResponse(url, options);
        return onResponse ? onResponse(calls.http.length, next) : next();
      },
    },
  };
}

function completed(result, grounding) {
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.http_status, 200);
  assert.equal(result.tenant, 'academy-a');
  assert.equal(result.tool_proposals, 1);
  assert.equal(result.business_dispatches, 1);
  assert.equal(result.grounding, grounding);
  assert.deepEqual(result.offer_ids, IDS);
}
function closed(result, calls, app = true) {
  assert.deepEqual(result.cleanup, { app, audit: true, application: true });
  assert.deepEqual(calls.ended, ['application', 'audit']);
  assert.deepEqual(calls.released, ['application', 'audit']);
}
function requestBody(attempt) {
  return JSON.parse(attempt.options.body);
}
function assertMilestoneOrder(timing, names) {
  let previous = 0;
  for (const name of names) {
    const current = timing[name];
    assert.ok(Number.isFinite(current) && current >= previous, `${name} is out of order`);
    previous = current;
  }
}

test('default mode ignores confirmation and never reads the callback', () => {
  assert.equal(executionMode([], block('confirmation read in offline mode')), 'offline');
});

test('one control is insufficient and only the exact dual controls select the live label', () => {
  assert.throws(() => executionMode(['--b3c2b-live-once'], () => undefined), /LIVE_CONFIRMATION_REQUIRED/);
  assert.throws(() => executionMode(['--b3c2b-live-once'], () => 'yes'), /LIVE_CONFIRMATION_REQUIRED/);
  assert.throws(() => executionMode(['--live'], block('confirmation read for unknown flag')), /INVALID_RUN_ARGUMENTS/);
  // Test selection only. The CLI and real IO branch are never invoked with these controls.
  assert.equal(executionMode(['--b3c2b-live-once'], () => 'B3C2B_ONE_SYNTHETIC_ACADEMY_A_REQUEST'), 'live');
});

test('an experimental CLI selection still requires both live controls', () => {
  const flag = '--b3c2f-experimental-latency';
  const confirm = () => 'B3C2B_ONE_SYNTHETIC_ACADEMY_A_REQUEST';
  assert.throws(() => executionMode([flag], confirm), /INVALID_RUN_ARGUMENTS/);
  assert.throws(() => executionMode(['--b3c2b-live-once', '15000'], confirm), /INVALID_RUN_ARGUMENTS/);
  assert.throws(() => executionMode(['--b3c2b-live-once', flag], () => undefined), /LIVE_CONFIRMATION_REQUIRED/);
  assert.equal(executionMode(['--b3c2b-live-once', flag], confirm), 'live');
});

test('normal registration leaves the advisor disabled and the fake-model factory retains its initial deadline', async (t) => {
  const { config } = acceptanceConfig(OFFLINE_ENV);
  const provider = (overrides) => AppModule.register(config, overrides).providers.find((p) => p.provide === ADVISOR);
  assert.equal(provider().useValue, null);
  const schedule = t.mock.method(globalThis, 'setTimeout');
  t.mock.method(performance, 'now', () => 0);
  const late = Promise.withResolvers();
  const model = { request: () => late.promise };
  const advisor = provider({ advisorMode: 'fake-model-postgres' }).useFactory(model, { execute: block('unexpected business') });
  const caller = new AbortController();
  const pending = advisor.advise({ tenant: { tenantId: 'academy-a' },
    confirmed: { budget_cents: 30000, weekly_hours: 6, known_skills: ['basic-python'] }, signal: caller.signal });
  caller.abort();
  assert.deepEqual(await pending, { status: 'cancelled', code: 'CANCELLED' });
  assert.deepEqual(schedule.mock.calls.map((call) => call.arguments[1]), [2000]);
  late.reject(new Error(SECRET));
});

test('composition and runner reject unsupported selectors before any real work', async () => {
  const { config, apiKey } = acceptanceConfig(OFFLINE_ENV);
  for (const overrides of [
    { advisorLatency: EXPERIMENTAL_LATENCY },
    { advisorMode: 'fake-model-postgres', advisorLatency: EXPERIMENTAL_LATENCY },
    { advisorMode: 'openai-model-postgres', openai: { apiKey }, advisorLatency: 'arbitrary' },
    { advisorMode: 'openai-model-postgres', openai: { apiKey }, advisorLatency: { initialMs: 15000 } },
  ]) assert.throws(() => AppModule.register(config, overrides), /Unsupported advisor latency selection/);
  const { io, calls } = instrument();
  const result = await runAcceptance(OFFLINE_ENV, application, io, { initialMs: 15000 });
  assert.deepEqual(result.problems, ['INVALID_ADVISOR_LATENCY']);
  assert.deepEqual(calls, { pools: [], released: [], ended: [], sql: [], http: [] });
});

test('missing private configuration fails before provider, database or app initialization', async () => {
  const { io, calls } = instrument();
  const result = await runAcceptance({}, { createApplication: block('app created') }, io);
  assert.deepEqual(result.problems, ['INVALID_PRIVATE_CONFIGURATION']);
  assert.deepEqual(calls, { pools: [], released: [], ended: [], sql: [], http: [] });
});

test('database configuration requires the exact loopback address, port, database and role', () => {
  const approved = OFFLINE_ENV.DATABASE_URL;
  const invalid = [
    approved.replace('127.0.0.1', 'localhost'),
    approved.replace('127.0.0.1', '192.0.2.1'),
    approved.replace('55432', '5432'),
    approved.replace('/p3_d12', '/unexpected'),
    approved.replace('p3_d12:', 'wrong_role:'),
    approved + '?host=unexpected',
    approved + '#unexpected',
  ];
  for (const url of invalid) {
    assert.throws(() => acceptanceConfig({ ...OFFLINE_ENV, DATABASE_URL: url }), /INVALID_DATABASE_TARGET/);
  }
  const { connection } = acceptanceConfig(OFFLINE_ENV);
  assert.deepEqual(connection, { host: '127.0.0.1', port: 55432, database: 'p3_d12',
    user: 'p3_d12', password: 'synthetic-db-marker' });
});

test('mock success exercises the actual authenticated advisor, counts both phases, and verifies the fixture', async () => {
  const bodies = [];
  const { io, calls } = instrument({ async onResponse(_n, next) {
    const response = await next();
    const bytes = new Uint8Array(await response.arrayBuffer());
    const chunks = [bytes.subarray(0, 1), bytes.subarray(1)];
    const body = { bytes: bytes.byteLength, pulls: 0 };
    bodies.push(body);
    return new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(chunks[body.pulls++]);
        if (body.pulls === chunks.length) controller.close();
      },
    }, { highWaterMark: 0 }), { headers: response.headers });
  } });
  const result = await runAcceptance(OFFLINE_ENV, application, io);
  completed(result, 'accepted_plan');
  closed(result, calls);
  assert.deepEqual(result.read_only, { audit: true, application: true });
  assert.equal(result.before_sha256, DIGEST);
  assert.equal(result.after_sha256, DIGEST);
  assert.ok(result.phase_ms.initial >= 0);
  assert.ok(result.phase_ms.final >= 0);
  assert.ok(result.business_ms >= 0);
  assert.equal(calls.http.length, 2);
  assert.equal(result.estimated_usd, 0.000456);
  assert.deepEqual(result.requests.map((r) => [r.phase, r.model, r.response_id, r.usage]), [
    ['initial', 'gpt-4.1-mini', 'resp_0000aaaa', { input_tokens: 250, output_tokens: 80 }],
    ['final', 'gpt-4.1-mini', 'resp_0000bbbb', { input_tokens: 250, output_tokens: 80 }],
  ]);
  for (const [index, attempt] of result.requests.entries()) {
    assertMilestoneOrder(attempt.timing_ms, ['forwarded', 'headers', 'first_chunk', 'body_complete', 'adapter_settled']);
    assert.equal(attempt.timing_ms.abort, null);
    assert.equal(attempt.last_stage, 'ADAPTER_SETTLEMENT');
    assert.equal(attempt.failure_category, null);
    assert.equal(attempt.requested_model, 'gpt-4.1-mini');
    assert.equal(attempt.http_status, 200);
    assert.equal(attempt.request_id, index === 0 ? 'req_1111aaaa' : 'req_1111bbbb');
    assert.equal(attempt.diagnostic_id, calls.http[index].options.headers.get('x-client-request-id'));
    assert.equal(attempt.response_bytes, bodies[index].bytes);
    assert.equal(bodies[index].pulls, 2);
  }
  assert.deepEqual(calls.sql.filter(({ role }) => role === 'application').map(({ args }) => args),
    [undefined, ['academy-a', 1001]]);
  for (const { url, options } of calls.http) {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.match(options.headers.get('x-client-request-id'), /^[a-f0-9-]{36}$/);
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, false);
  }
  assert.deepEqual(calls.http.map((r) => requestBody(r).max_output_tokens), [3072, 4096]);
  assert.deepEqual(JSON.parse(requestBody(calls.http[0]).input),
    { budget_cents: 30000, weekly_hours: 6, known_skills: ['basic-python'] });
  assert.deepEqual(JSON.parse(requestBody(calls.http[1]).input), { offer_ids: IDS });
});

for (const [selection, timers] of [[undefined, [7000, 2000, 2500, 1000]],
  [EXPERIMENTAL_LATENCY, [35000, 15000, 2500, 8000]]]) {
  test(`runner schedules the ${selection ?? 'default'} watchdog and advisor phases`, async (t) => {
    t.mock.method(performance, 'now', () => 0);
    const schedule = t.mock.method(globalThis, 'setTimeout');
    const { io, calls } = instrument();
    const observed = { ...application, async createApplication(config, overrides) {
      const app = await application.createApplication(config, overrides);
      app.getHttpServer().prependListener('request', (request) => {
        request.headers['x-advisor-latency'] = EXPERIMENTAL_LATENCY;
        request.url += '?advisorLatency=' + EXPERIMENTAL_LATENCY;
      });
      return app;
    } };
    const result = await runAcceptance(OFFLINE_ENV, observed, io, selection);
    completed(result, 'accepted_plan');
    assert.deepEqual(schedule.mock.calls.map((call) => call.arguments[1]), timers);
    assert.equal(calls.http.length, 2);
    assert.deepEqual(calls.sql.filter(({ args }) => args).map(({ args }) => args), [['academy-a', 1001]]);
    assert.equal(result.before_sha256, DIGEST);
    assert.equal(result.after_sha256, DIGEST);
    closed(result, calls);
  });
}

test('invalid effective read-only state blocks database work and closes both acquired pools', async () => {
  const { io, calls } = instrument({ async onQuery({ role }, next) {
    const result = await next();
    if (role === 'application') result.rows[0].transaction_ro = 'off';
    return result;
  } });
  const result = await runAcceptance(OFFLINE_ENV, application, io);
  assert.deepEqual(result.problems, ['DATABASE_READ_ONLY_CHECK_FAILED']);
  assert.equal(calls.sql.length, 2);
  assert.equal(calls.http.length, 0);
  assert.equal(result.business_dispatches, 0);
  closed(result, calls, false);
});

test('fixture schema drift stops before the model and both pools close', async () => {
  const { io, calls } = instrument({ onQuery({ sql }, next) {
    if (sql.includes('information_schema.columns')) return { rows: [] };
    return next();
  } });
  const result = await runAcceptance(OFFLINE_ENV, application, io);
  assert.deepEqual(result.problems, ['FIXTURE_SCHEMA_MISMATCH']);
  assert.equal(calls.http.length, 0);
  closed(result, calls, false);
});

test('wrong fixture digest stops before model spending', async () => {
  const { io, calls } = instrument({ async onQuery({ sql }, next) {
    const result = await next();
    if (sql.startsWith('SELECT *')) result.rows[0].price_cents++;
    return result;
  } });
  const result = await runAcceptance(OFFLINE_ENV, application, io);
  assert.deepEqual(result.problems, ['FIXTURE_DIGEST_MISMATCH']);
  assert.notEqual(result.before_sha256, DIGEST);
  assert.equal(calls.http.length, 0);
  assert.equal(result.business_dispatches, 0);
  closed(result, calls, false);
});

for (const [name, replace] of [
  ['write SQL', () => ['DELETE FROM course_offers', undefined]],
  ['opposite tenant', (sql) => [sql, ['academy-b', 1001]]],
  ['different candidate limit', (sql) => [sql, ['academy-a', 1002]]],
]) {
  test('application SQL gate blocks ' + name + ' before querying its pool client', async () => {
    const { io, calls } = instrument();
    const hooked = { ...application, createApplication(config, overrides) {
      const pool = overrides.databasePool;
      const query = pool.query;
      pool.query = (sql) => query(...replace(sql));
      return application.createApplication(config, overrides);
    } };
    const result = await runAcceptance(OFFLINE_ENV, hooked, io);
    assert.deepEqual(result.problems, ['IO_BOUNDARY_VIOLATION']);
    assert.equal(result.business_dispatches, 0);
    assert.equal(calls.http.length, 1);
    assert.equal(calls.sql.filter(({ role }) => role === 'application').length, 1);
    assert.equal(result.after_sha256, DIGEST);
    closed(result, calls);
  });
}

test('transport allows at most two attempts and rejects unapproved destinations', async () => {
  const { io, calls } = instrument();
  const approved = await runAcceptance(OFFLINE_ENV, application, io);
  assert.equal(approved.ok, true);
  const evidence = { requests: [] };
  const transport = boundedTransport(mockIO().fetchResponse, evidence, () => true);
  const first = calls.http[0], second = calls.http[1];
  await assert.rejects(transport('https://unexpected.invalid/', first.options), /UNAPPROVED_PROVIDER_REQUEST/);
  assert.equal(evidence.requests.length, 0);
  await (await transport(first.url, first.options)).text();
  await (await transport(second.url, second.options)).text();
  await assert.rejects(transport(second.url, second.options), /UNAPPROVED_PROVIDER_REQUEST/);
  assert.equal(evidence.requests.length, 2);
});

for (const [name, providerFailure, category = null] of [
  ['network failure', () => { throw new Error(SECRET); }, 'TRANSPORT_ERROR'],
  ['HTTP failure', () => new Response(SECRET, { status: 503 }), 'HTTP_ERROR'],
  ['malformed JSON', () => new Response(SECRET), 'ADAPTER_ERROR'],
  ['invalid tool proposal', async (next) => {
    const body = await (await next()).json();
    body.output[0].arguments = '{"tenantId":"academy-b"}';
    return Response.json(body);
  }],
  ['model refusal', async (next) => {
    const body = await (await next()).json();
    body.output = [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'refusal', refusal: SECRET }] }];
    return Response.json(body);
  }],
]) {
  test('initial ' + name + ' stops before SQL dispatch without retry', async () => {
    const { io, calls } = instrument({ onResponse: (_n, next) => providerFailure(next) });
    const result = await runAcceptance(OFFLINE_ENV, application, io);
    assert.deepEqual(result.problems, ['ADVISOR_NOT_COMPLETED']);
    assert.equal(result.business_dispatches, 0);
    assert.equal(calls.http.length, 1);
    assert.equal(result.requests[0].failure_category, category);
    assertMilestoneOrder(result.requests[0].timing_ms, ['forwarded', 'adapter_settled']);
    assert.equal(result.after_sha256, DIGEST);
    closed(result, calls);
  });
}

test('initial timeout before headers records the abort separately from late adapter settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const forwarded = Promise.withResolvers();
  const transport = Promise.withResolvers();
  const { io, calls } = instrument({ onResponse() {
    forwarded.resolve();
    return transport.promise;
  } });
  const run = runAcceptance(OFFLINE_ENV, application, io);
  await forwarded.promise;
  t.mock.timers.tick(2000);
  const result = await run;
  const [attempt] = result.requests;
  assert.equal(result.http_status, 504);
  assert.equal(result.business_dispatches, 0);
  assert.equal(calls.http.length, 1);
  assert.equal(calls.http[0].options.signal.aborted, true);
  assert.equal(attempt.last_stage, 'BEFORE_HEADERS');
  assert.equal(attempt.failure_category, 'ABORTED');
  assert.equal(attempt.http_status, null);
  assert.equal(attempt.request_id, null);
  assert.equal(attempt.response_bytes, null);
  for (const name of ['headers', 'first_chunk', 'body_complete', 'adapter_settled']) {
    assert.equal(attempt.timing_ms[name], null);
  }
  assertMilestoneOrder(attempt.timing_ms, ['forwarded', 'abort']);
  assert.equal(result.after_sha256, DIGEST);
  closed(result, calls);
  transport.reject(new Error(SECRET));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempt.timing_ms.adapter_settled, null);
  assert.equal(calls.http.length, 1);
});

test('experimental initial deadline outlasts the default watchdog and returns 504 without dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const forwarded = Promise.withResolvers();
  const late = Promise.withResolvers();
  const { io, calls } = instrument({ onResponse() { forwarded.resolve(); return late.promise; } });
  const pending = runAcceptance(OFFLINE_ENV, application, io, EXPERIMENTAL_LATENCY);
  await forwarded.promise;
  const { signal } = calls.http[0].options;
  t.mock.timers.tick(7000);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(8000);
  const result = await pending;
  assert.equal(result.http_status, 504);
  assert.equal(result.business_dispatches, 0);
  assert.equal(calls.http.length, 1);
  assert.equal(signal.aborted, true);
  assert.equal(result.requests[0].last_stage, 'BEFORE_HEADERS');
  assert.equal(result.requests[0].failure_category, 'ABORTED');
  assertMilestoneOrder(result.requests[0].timing_ms, ['forwarded', 'abort']);
  assert.equal(result.after_sha256, DIGEST);
  closed(result, calls);
  late.reject(new Error(SECRET));
});

for (const withChunk of [true, false]) {
  test('initial timeout with observed headers and ' + (withChunk ? 'a partial body' : 'no body chunk'), async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const reading = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const bytes = new TextEncoder().encode(SECRET);
    let pulls = 0;
    const { io, calls } = instrument({ onResponse() {
      const stream = new ReadableStream({
        pull(controller) {
          pulls++;
          if (withChunk && pulls === 1) controller.enqueue(bytes);
          else reading.resolve();
        },
        cancel() { cancelled.resolve(); },
      }, { highWaterMark: 0 });
      return new Response(stream, { headers: { 'x-request-id': 'req_deadbeef' } });
    } });
    const run = runAcceptance(OFFLINE_ENV, application, io);
    await reading.promise;
    t.mock.timers.tick(2000);
    const result = await run;
    await cancelled.promise;
    const [attempt] = result.requests;
    assert.equal(result.http_status, 504);
    assert.equal(result.business_dispatches, 0);
    assert.equal(calls.http.length, 1);
    assert.equal(pulls, withChunk ? 2 : 1);
    assert.equal(attempt.last_stage, withChunk ? 'BODY_IN_PROGRESS' : 'UNKNOWN');
    assert.equal(attempt.failure_category, 'ABORTED');
    assert.equal(attempt.http_status, 200);
    assert.equal(attempt.request_id, 'req_deadbeef');
    assert.equal(attempt.response_bytes, withChunk ? bytes.byteLength : null);
    assert.equal(attempt.timing_ms.body_complete, null);
    const milestones = withChunk ? ['forwarded', 'headers', 'first_chunk'] : ['forwarded', 'headers'];
    if (!withChunk) assert.equal(attempt.timing_ms.first_chunk, null);
    assertMilestoneOrder(attempt.timing_ms, [...milestones, 'abort', 'adapter_settled']);
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.equal(result.after_sha256, DIGEST);
    closed(result, calls);
  });
}

for (const selection of [undefined, EXPERIMENTAL_LATENCY]) {
  test(`${selection ?? 'default'} business SQL failure prevents the final request and still audits and closes`, async () => {
    const { io, calls } = instrument({ onQuery({ args }, next) {
      if (args) throw new Error(OFFLINE_ENV.DATABASE_URL);
      return next();
    } });
    const result = await runAcceptance(OFFLINE_ENV, application, io, selection);
    assert.deepEqual(result.problems, ['ADVISOR_NOT_COMPLETED']);
    assert.equal(result.business_dispatches, 1);
    assert.equal(calls.http.length, 1);
    assert.equal(result.after_sha256, DIGEST);
    closed(result, calls);
  });
}

test('experimental final deadline gives grounded fallback after one successful scoped lookup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const forwarded = Promise.withResolvers();
  const late = Promise.withResolvers();
  const { io, calls } = instrument({ onResponse(n, next) {
    if (n === 1) return next();
    forwarded.resolve();
    return late.promise;
  } });
  const pending = runAcceptance(OFFLINE_ENV, application, io, EXPERIMENTAL_LATENCY);
  await forwarded.promise;
  const { signal } = calls.http[1].options;
  t.mock.timers.tick(1000);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(7000);
  const result = await pending;
  completed(result, 'deterministic_fallback');
  assert.equal(signal.aborted, true);
  assert.equal(calls.http.length, 2);
  assert.equal(result.requests[1].failure_category, 'ABORTED');
  assert.equal(result.after_sha256, DIGEST);
  closed(result, calls);
  late.reject(new Error(SECRET));
});

test('final failure retains only the existing deterministic fallback and preserves unknown spend', async () => {
  const { io, calls } = instrument({ onResponse(n, next) {
    if (n === 2) throw new Error(SECRET + OFFLINE_ENV.OPENAI_API_KEY);
    return next();
  } });
  const result = await runAcceptance(OFFLINE_ENV, application, io);
  completed(result, 'deterministic_fallback');
  assert.equal(calls.http.length, 2);
  assert.equal(result.estimated_usd, null);
  closed(result, calls);
});

for (const [name, usage, gate] of [
  ['missing usage', undefined, 'INITIAL_USAGE_UNKNOWN'],
  ['insufficient remaining allowance', { input_tokens: 240000, output_tokens: 10 }, 'INTENDED_BUDGET'],
]) {
  test(name + ' withholds the final POST and lets the service use fallback', async () => {
    const { io, calls } = instrument({ async onResponse(_n, next) {
      const body = await (await next()).json();
      body.usage = usage;
      return Response.json(body);
    } });
    const result = await runAcceptance(OFFLINE_ENV, application, io);
    completed(result, 'deterministic_fallback');
    assert.equal(result.final_withheld, gate);
    assert.equal(calls.http.length, 1);
    if (!usage) assert.equal(result.estimated_usd, null);
    closed(result, calls);
  });
}

test('streaming provider limit cancels the single-pass response on overflow', async () => {
  let pulls = 0;
  const cancelled = Promise.withResolvers();
  const { io, calls } = instrument({ onResponse() {
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(pulls === 1 ? 65536 : 1).fill(32));
      },
      cancel() { cancelled.resolve(); },
    }, { highWaterMark: 0 });
    return new Response(stream);
  } });
  const result = await runAcceptance(OFFLINE_ENV, application, io);
  await cancelled.promise;
  assert.equal(pulls, 2);
  assert.equal(result.business_dispatches, 0);
  assert.equal(calls.http.length, 1);
  const [attempt] = result.requests;
  assert.equal(attempt.response_bytes, 65536);
  assert.equal(attempt.failure_category, 'RESPONSE_TOO_LARGE');
  assert.equal(attempt.timing_ms.body_complete, null);
  assertMilestoneOrder(attempt.timing_ms, ['forwarded', 'headers', 'first_chunk', 'adapter_settled']);
});

test('after-snapshot detects altered row contents even after a completed response', async () => {
  let snapshots = 0;
  const { io, calls } = instrument({ async onQuery({ sql }, next) {
    const result = await next();
    if (sql.startsWith('SELECT *') && ++snapshots === 2) result.rows[5].active = true;
    return result;
  } });
  const result = await runAcceptance(OFFLINE_ENV, application, io);
  assert.equal(result.ok, false);
  assert.equal(result.before_sha256, DIGEST);
  assert.notEqual(result.after_sha256, DIGEST);
  assert.deepEqual(result.problems, ['FIXTURE_CHANGED']);
  closed(result, calls);
});

test('app initialization failure still attempts app close, both pool closures, and the post-audit', async () => {
  const { io, calls } = instrument();
  const hooked = { ...application, async createApplication(config, overrides) {
    const app = await application.createApplication(config, overrides);
    return { init: block(SECRET), close: () => app.close() };
  } };
  const result = await runAcceptance(OFFLINE_ENV, hooked, io);
  assert.deepEqual(result.problems, ['APPLICATION_FAILED']);
  assert.equal(calls.http.length, 0);
  assert.equal(result.after_sha256, DIGEST);
  closed(result, calls);
});

test('a failed application-pool close is reported and the audit pool still closes', async () => {
  const { io, calls } = instrument({ onEnd(role) { if (role === 'application') throw new Error(SECRET); } });
  const result = await runAcceptance(OFFLINE_ENV, application, io);
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('APPLICATION_POOL_CLEANUP_FAILED'));
  assert.deepEqual(calls.ended, ['application', 'audit']);
  assert.equal(result.cleanup.audit, true);
  assert.equal(result.after_sha256, DIGEST);
});

test('published evidence excludes provider bodies, injected IDs, credentials and URLs', async () => {
  const { io } = instrument({ async onResponse(n, next) {
    if (n === 2) throw new Error(OFFLINE_ENV.DATABASE_URL);
    const body = await (await next()).json();
    body.id = 'resp_' + SECRET;
    body.model = SECRET;
    body.extra = OFFLINE_ENV.P3_DEMO_TOKEN_A;
    return Response.json(body, { headers: { 'x-request-id': 'req_' + SECRET } });
  } });
  const serialized = JSON.stringify(await runAcceptance(OFFLINE_ENV, application, io));
  for (const forbidden of [SECRET, ...Object.values(OFFLINE_ENV), 'postgresql://', 'Bearer ', 'synthetic-',
    'find_suitable_courses', 'max_output_tokens', 'budget_cents', 'Error:']) {
    assert.ok(!serialized.includes(forbidden), 'A credential marker reached the report');
  }
});
