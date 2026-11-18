import { createHash, randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';

const LIVE_FLAG = '--b3c2b-live-once';
const CONFIRM_LIVE = 'B3C2B_ONE_SYNTHETIC_ACADEMY_A_REQUEST';
const EXPERIMENTAL_LATENCY_FLAG = '--b3c2f-experimental-latency';
const EXPERIMENTAL_LATENCY = 'b3c2f-experimental';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const MODEL = 'gpt-4.1-mini';
const RESPONSE_BYTES = 64 * 1024;
const INPUT_ALLOWANCE = 5000; // Planning reserve per request, not provider token accounting.
const SPEND_BUDGET = 0.10;
const OUTPUT_TOKENS = { initial: 3072, final: 4096 };
const OFFER_IDS = ['p3-a-102', 'p3-a-101'];
const REASON_IDS = ['budget', 'hours', 'skills'];
const REASONS = ['Within the declared budget.', 'Fits the weekly study-hour limit.',
  'Required skills match the declared skills.'];
const CONSTRAINTS = { budget_cents: 30000, weekly_hours: 6, known_skills: ['basic-python'] };
const REQUEST = { confirmed: true, constraints: CONSTRAINTS };

const EXPECTED_DIGEST = '3b4029e931f5d93e5c74db0a11ae8640a1bab6efe4b84bd0bcd818a19432fca2';
const FIXTURE_COLUMNS = ['offer_id', 'tenant_id', 'title', 'price_cents', 'currency',
  'required_skills', 'weekly_study_hours', 'active'];
const IDENTITY = `SELECT current_database() AS db, current_user AS role, session_user AS login,
  current_setting('default_transaction_read_only') AS default_ro,
  current_setting('transaction_read_only') AS transaction_ro, current_setting('search_path') AS search_path`;
const TABLES = `SELECT c.relname, c.relkind, c.relrowsecurity FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname LIMIT 2`;
const COLUMNS = `SELECT column_name, data_type, udt_name, is_nullable, column_default
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'course_offers'
  ORDER BY ordinal_position LIMIT 9`;
const CHECKS = `SELECT conname, contype, convalidated, pg_catalog.pg_get_constraintdef(oid, true) AS definition
  FROM pg_catalog.pg_constraint WHERE conrelid = 'public.course_offers'::regclass ORDER BY conname LIMIT 9`;
const TRIGGERS = `SELECT count(*)::int AS count FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'public.course_offers'::regclass AND NOT tgisinternal`;
const SNAPSHOT = 'SELECT * FROM public.course_offers ORDER BY offer_id LIMIT 7';
const AUDIT_SQL = new Set([TABLES, COLUMNS, CHECKS, TRIGGERS, SNAPSHOT]);
const BUSINESS_SQL = `SELECT offer_id, title, price_cents, currency, required_skills, weekly_study_hours
  FROM course_offers WHERE tenant_id = $1 AND active = TRUE ORDER BY offer_id ASC LIMIT $2`;
const BUSINESS_ARGS = ['academy-a', 1001];

const COLUMN_TYPES = [
  ['text', 'text'], ['text', 'text'], ['text', 'text'], ['integer', 'int4'], ['text', 'text'],
  ['ARRAY', '_text', "'{}'::text[]"], ['integer', 'int4'], ['boolean', 'bool'],
];
const EXPECTED_COLUMNS = COLUMN_TYPES.map(([data_type, udt_name, column_default = null], i) =>
  ({ column_name: FIXTURE_COLUMNS[i], data_type, udt_name, is_nullable: 'NO', column_default }));
const EXPECTED_CHECKS = {
  course_offers_pkey: ['p', 'PRIMARY KEY (offer_id)'],
  course_offers_offer_id_check: ['c', 'CHECK (length(offer_id) >= 1 AND length(offer_id) <= 80)'],
  course_offers_tenant_id_check: ['c', "CHECK (tenant_id = ANY (ARRAY['academy-a'::text, 'academy-b'::text]))"],
  course_offers_title_check: ['c', 'CHECK (length(btrim(title)) >= 1 AND length(btrim(title)) <= 200)',
    'CHECK (length(TRIM(BOTH FROM title)) >= 1 AND length(TRIM(BOTH FROM title)) <= 200)'],
  course_offers_price_cents_check: ['c', 'CHECK (price_cents >= 0)'],
  course_offers_currency_check: ['c', "CHECK (currency ~ '^[A-Z]{3}$'::text)"],
  course_offers_required_skills_check: ['c', 'CHECK (array_position(required_skills, NULL::text) IS NULL)'],
  course_offers_weekly_study_hours_check: ['c', 'CHECK (weekly_study_hours >= 1 AND weekly_study_hours <= 168)'],
};
const EXPECTED_TABLES = [{ relname: 'course_offers', relkind: 'r', relrowsecurity: false }];
const EXPECTED_IDENTITY = { db: 'p3_d12', role: 'p3_d12', login: 'p3_d12', default_ro: 'on',
  transaction_ro: 'on', search_path: 'pg_catalog,public' };
const MOCK_ROWS = [
  ['p3-a-101', 'academy-a', 'Synthetic Python Foundations', 12000, 'USD', [], 4, true],
  ['p3-a-102', 'academy-a', 'Synthetic Backend APIs', 24000, 'USD', ['basic-python'], 6, true],
  ['p3-a-103', 'academy-a', 'Synthetic Retired Workshop', 5000, 'USD', [], 2, false],
  ['p3-b-101', 'academy-b', 'Synthetic SQL Foundations', 9500, 'USD', [], 3, true],
  ['p3-b-102', 'academy-b', 'Synthetic Data Services', 18500, 'USD', ['basic-sql'], 5, true],
  ['p3-b-103', 'academy-b', 'Synthetic Archived Seminar', 7000, 'USD', [], 2, false],
].map((values) => Object.fromEntries(FIXTURE_COLUMNS.map((key, i) => [key, values[i]])));

class RunFailure extends Error {}
function requireSafe(condition, code) {
  if (!condition) throw new RunFailure(code);
}
const same = isDeepStrictEqual;
const elapsed = (start) => Math.round((performance.now() - start) * 1000) / 1000;

export function executionMode(args, confirm) {
  if (args.length === 0) return 'offline';
  requireSafe(args[0] === LIVE_FLAG &&
    (args.length === 1 || (args.length === 2 && args[1] === EXPERIMENTAL_LATENCY_FLAG)), 'INVALID_RUN_ARGUMENTS');
  requireSafe(confirm() === CONFIRM_LIVE, 'LIVE_CONFIRMATION_REQUIRED');
  return 'live';
}

export function acceptanceConfig(env) {
  const { DATABASE_URL: databaseUrl, OPENAI_API_KEY: apiKey, P3_DEMO_TOKEN_A: tokenA,
    P3_DEMO_TOKEN_B: tokenB } = env;
  requireSafe(typeof apiKey === 'string' && apiKey.length <= 1024 && /^[!-~]+$/.test(apiKey) &&
    [tokenA, tokenB].every((token) => typeof token === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(token)) &&
    tokenA !== tokenB, 'INVALID_PRIVATE_CONFIGURATION');
  let password;
  try {
    const url = new URL(databaseUrl);
    requireSafe(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
      url.port === '55432' && url.pathname === '/p3_d12' && url.username === 'p3_d12' &&
      !url.search && !url.hash, 'INVALID_DATABASE_TARGET');
    password = decodeURIComponent(url.password);
    requireSafe(password.length > 0 && !password.includes('\0'), 'INVALID_DATABASE_TARGET');
  } catch {
    throw new RunFailure('INVALID_DATABASE_TARGET');
  }
  return { apiKey, config: { databaseUrl, tokenA, tokenB, port: 3000 },
    connection: { host: '127.0.0.1', port: 55432, database: 'p3_d12', user: 'p3_d12', password } };
}

function catalogFields(row) {
  const { tenant_id, active, ...facts } = row;
  return facts;
}

function fingerprint(rows) {
  requireSafe(rows.length === 6 && rows.every((row) =>
    same(Object.keys(row).sort(), [...FIXTURE_COLUMNS].sort())), 'FIXTURE_SHAPE_MISMATCH');
  const canonical = [...rows].sort((a, b) => a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0)
    .map((row) => Object.fromEntries(FIXTURE_COLUMNS.map((key) => [key, row[key]])));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function checkConstraints(rows) {
  // Ignore PostgreSQL deparser formatting and known equivalent casts.
  const normalize = (value) => value.replace(/::text/g, '').replace(/[\s()]/g, '');
  return same(rows.map((row) => row.conname).sort(), Object.keys(EXPECTED_CHECKS).sort()) &&
    rows.every(({ conname, contype, convalidated, definition }) => {
      const [type, ...forms] = EXPECTED_CHECKS[conname];
      return convalidated && contype === type && typeof definition === 'string' &&
        forms.some((form) => normalize(form) === normalize(definition));
    });
}

function guardedPool(pool, role, evidence) {
  // A single checked-out client for each pool removes reconnect and session drift from the run.
  let client;
  let closing;
  let ready = false;
  const failedConnection = () => {
    ready = false;
    evidence.connection_failure = true;
  };
  return {
    async open() {
      client = await pool.connect();
      client.on('error', failedConnection);
      const { rows } = await client.query(IDENTITY);
      const identity = rows[0];
      requireSafe(rows.length === 1 && typeof identity?.search_path === 'string' &&
        same({ ...identity, search_path: identity.search_path.replace(/\s/g, '') }, EXPECTED_IDENTITY) &&
        !evidence.connection_failure,
      'DATABASE_READ_ONLY_CHECK_FAILED');
      ready = true;
      evidence.read_only[role] = true;
    },
    async query(sql, params) {
      requireSafe(ready && !closing, 'DATABASE_SESSION_UNAVAILABLE');
      if (role === 'audit') {
        requireSafe(AUDIT_SQL.has(sql) && params === undefined, 'UNAPPROVED_AUDIT_SQL');
        return client.query(sql);
      }
      // Count denied attempts separately since the repository sanitizes thrown errors.
      if (sql !== BUSINESS_SQL || !same(params, BUSINESS_ARGS) || evidence.business_dispatches !== 0) {
        evidence.sql_boundary_violation = true;
        throw new RunFailure('UNAPPROVED_BUSINESS_SQL');
      }
      evidence.business_dispatches++;
      evidence.tenant = BUSINESS_ARGS[0];
      const start = performance.now();
      try {
        return await client.query(sql, params);
      } finally {
        evidence.business_ms = elapsed(start);
      }
    },
    end() {
      closing ??= (async () => {
        try {
          client?.off('error', failedConnection);
          client?.release();
        }
        finally { await pool.end(); }
        evidence.cleanup[role] = true;
      })();
      return closing;
    },
  };
}

const estimate = (input, output) => (input * 0.40 + output * 1.60) / 1_000_000;
const safeId = (value, prefix) => typeof value === 'string' &&
  new RegExp('^' + prefix + '_[a-fA-F0-9]{8,80}$').test(value) ? value : null;

function observeResponse(response, { record, mark }) {
  if (!response.ok || !response.body) return response;
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const observed = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (record.timing_ms.first_chunk === null) mark('first_chunk', 'BODY_IN_PROGRESS');
      record.response_bytes = Math.min(bytes, RESPONSE_BYTES);
      if (bytes > RESPONSE_BYTES) record.failure_category ??= 'RESPONSE_TOO_LARGE';
      requireSafe(bytes <= RESPONSE_BYTES, 'PROVIDER_RESPONSE_TOO_LARGE');
      text += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    flush() {
      record.response_bytes = bytes;
      mark('body_complete', 'BODY_COMPLETE');
      try {
        const { id, model, status, output, usage } = JSON.parse(text + decoder.decode());
        record.response_id = safeId(id, 'resp');
        if ([MODEL, 'gpt-4.1-mini-2025-04-14'].includes(model)) record.model = model;
        if (['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress'].includes(status)) {
          record.provider_status = status;
        }
        if (Array.isArray(output)) {
          record.tool_proposals = output.filter((item) => item?.type === 'function_call').length;
        }
        if (Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0 && usage.input_tokens <= 1_047_576 &&
            Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0 &&
            usage.output_tokens <= OUTPUT_TOKENS[record.phase]) {
          record.usage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
          record.estimated_usd = estimate(usage.input_tokens, usage.output_tokens);
        }
      } catch { /* The adapter owns protocol rejection. Unavailable evidence stays unknown. */ }
    },
  }));
  return new Response(observed, { status: response.status, headers: response.headers });
}

export function boundedTransport(fetchResponse, evidence, businessCompleted, attempts = new WeakMap()) {
  return async (url, init) => {
    // Count the actual forwarding attempts. Nothing after this gate retries.
    const phase = evidence.requests.length === 0 ? 'initial' : 'final';
    let body;
    try { body = JSON.parse(init.body); } catch { /* Fixed refusal below. */ }
    let input;
    try { input = JSON.parse(body?.input); } catch { /* Fixed refusal below. */ }
    if (evidence.requests.length >= 2 || url !== ENDPOINT || init.method !== 'POST' || init.redirect !== 'error' ||
        !(init.signal instanceof AbortSignal) ||
        body?.model !== MODEL || body?.store !== false || body?.parallel_tool_calls !== false ||
        body?.max_output_tokens !== OUTPUT_TOKENS[phase] ||
        !same(input, phase === 'initial' ? CONSTRAINTS : { offer_ids: OFFER_IDS })) {
      evidence.provider_boundary_violation = true;
      throw new RunFailure('UNAPPROVED_PROVIDER_REQUEST');
    }
    if (phase === 'final') {
      requireSafe(businessCompleted() && !evidence.connection_failure, 'FINAL_WITHOUT_BUSINESS_RESULT');
      const { estimated_usd } = evidence.requests[0];
      if (estimated_usd === null || estimated_usd + estimate(INPUT_ALLOWANCE, OUTPUT_TOKENS.final) > SPEND_BUDGET) {
        evidence.final_withheld = estimated_usd === null ? 'INITIAL_USAGE_UNKNOWN' : 'INTENDED_BUDGET';
        throw new RunFailure(evidence.final_withheld);
      }
    }
    init.signal.throwIfAborted();
    const diagnostic_id = randomUUID();
    const record = { phase, diagnostic_id, request_id: null, response_id: null, requested_model: MODEL, model: null,
      http_status: null, provider_status: null, tool_proposals: null, usage: null, estimated_usd: null,
      timing_ms: { forwarded: 0, headers: null, first_chunk: null, body_complete: null,
        adapter_settled: null, abort: null },
      response_bytes: null, last_stage: 'BEFORE_HEADERS', failure_category: null };
    evidence.requests.push(record);
    const headers = new Headers(init.headers);
    headers.set('X-Client-Request-Id', diagnostic_id);
    const start = performance.now();
    const mark = (milestone, stage) => {
      record.timing_ms[milestone] = elapsed(start);
      // Keep the stage at which abort was observed even if the adapter later settles.
      if (stage !== undefined && record.timing_ms.abort === null) record.last_stage = stage;
    };
    const attempt = { record, mark };
    attempts.set(init.signal, attempt);
    let response;
    try {
      response = await fetchResponse(url, { method: 'POST', body: init.body, signal: init.signal,
        headers, redirect: 'error' });
    } catch (error) {
      record.failure_category ??= 'TRANSPORT_ERROR';
      throw error;
    }
    mark('headers', 'UNKNOWN'); // Headers alone establish no body progress.
    const status = response.status;
    if (Number.isInteger(status) && status >= 100 && status <= 599) record.http_status = status;
    record.request_id = safeId(response.headers.get('x-request-id'), 'req');
    if (!response.ok) record.failure_category ??= 'HTTP_ERROR';
    return observeResponse(response, attempt);
  };
}

async function dispatch(app, token, watchdogMs) {
  const socket = new Socket();
  const incoming = new IncomingMessage(socket);
  const response = new ServerResponse(incoming);
  const raw = JSON.stringify(REQUEST);
  incoming.method = 'POST';
  incoming.url = '/advisor/recommendations';
  incoming.complete = true;
  incoming.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)),
    authorization: `Bearer ${token}` };
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const fail = () => reject(new RunFailure('IN_PROCESS_HTTP_FAILURE'));
      timer = setTimeout(fail, watchdogMs);
      incoming.once('error', fail);
      response.once('error', fail);
      socket.once('error', fail);
      response.end = (chunk) => {
        try {
          resolve({ status: response.statusCode, cache: response.getHeader('cache-control'), body: JSON.parse(String(chunk)) });
        } catch { fail(); }
        return response;
      };
      app.getHttpServer().emit('request', incoming, response);
      incoming.push(Buffer.from(raw));
      incoming.push(null);
    });
  } finally {
    clearTimeout(timer);
    incoming.destroy();
    response.destroy();
    socket.destroy();
  }
}

export async function runAcceptance(env, application, io, advisorLatency = undefined) {
  const evidence = { requested_model: MODEL, requests: [], phase_ms: {}, business_dispatches: 0, tenant: null,
    tool_proposals: null, offer_ids: [], grounding: null, before_sha256: null, after_sha256: null,
    read_only: { audit: false, application: false }, cleanup: { app: false, application: false, audit: false },
    problems: [] };
  let audit;
  let db;
  let app;
  let baseline;
  let businessCompleted = false;
  const attempts = new WeakMap();
  const removeAbortObservers = [];
  let stage = 'CONFIGURATION';
  try {
    requireSafe(advisorLatency === undefined || advisorLatency === EXPERIMENTAL_LATENCY, 'INVALID_ADVISOR_LATENCY');
    const watchdogMs = advisorLatency === EXPERIMENTAL_LATENCY ? 35000 : 7000;
    const { apiKey, config, connection } = acceptanceConfig(env);
    stage = 'DATABASE_SETUP';
    audit = guardedPool(io.makePool(connection, 'audit'), 'audit', evidence);
    await audit.open();
    db = guardedPool(io.makePool(connection, 'application'), 'application', evidence);
    await db.open();
    stage = 'SCHEMA_AUDIT';
    requireSafe(same((await audit.query(TABLES)).rows, EXPECTED_TABLES) &&
      same((await audit.query(COLUMNS)).rows, EXPECTED_COLUMNS) &&
      checkConstraints((await audit.query(CHECKS)).rows) &&
      same((await audit.query(TRIGGERS)).rows, [{ count: 0 }]), 'FIXTURE_SCHEMA_MISMATCH');
    stage = 'FIXTURE_BEFORE';
    const before = (await audit.query(SNAPSHOT)).rows;
    evidence.before_sha256 = fingerprint(before);
    requireSafe(evidence.before_sha256 === EXPECTED_DIGEST, 'FIXTURE_DIGEST_MISMATCH');
    baseline = before;
    stage = 'APPLICATION';
    const databasePool = { end: db.end, async query(sql, args) {
      const result = await db.query(sql, args);
      businessCompleted = true;
      return result;
    } };
    app = await application.createApplication(config, { advisorMode: 'openai-model-postgres', advisorLatency, databasePool,
      openai: { apiKey, transport: boundedTransport(io.fetchResponse, evidence, () => businessCompleted, attempts) } });
    await app.init();
    const model = app.get(application.OpenAIModelClient);
    const request = model.request.bind(model);
    model.request = async (input, signal) => {
      const start = performance.now();
      const observeAbort = () => {
        const attempt = attempts.get(signal);
        if (attempt) {
          attempt.mark('abort');
          attempt.record.failure_category ??= 'ABORTED';
        }
      };
      signal.addEventListener('abort', observeAbort, { once: true });
      // The advisor can abort on its deadline recheck after this adapter promise settles.
      removeAbortObservers.push(() => signal.removeEventListener('abort', observeAbort));
      try { return await request(input, signal); }
      catch (error) {
        const attempt = attempts.get(signal);
        if (attempt) attempt.record.failure_category ??= 'ADAPTER_ERROR';
        throw error;
      } finally {
        evidence.phase_ms[input.phase] = elapsed(start);
        attempts.get(signal)?.mark('adapter_settled', 'ADAPTER_SETTLEMENT');
      }
    };
    stage = 'ADVISOR';
    const start = performance.now();
    let reply;
    try { reply = await dispatch(app, config.tokenA, watchdogMs); }
    finally { evidence.advisor_ms = elapsed(start); }
    evidence.tool_proposals = evidence.requests[0]?.tool_proposals ?? null;
    evidence.http_status = reply.status;
    requireSafe(!evidence.sql_boundary_violation && !evidence.provider_boundary_violation, 'IO_BOUNDARY_VIOLATION');
    requireSafe(reply.status === 200 && reply.cache === 'no-store' && reply.body.status === 'completed', 'ADVISOR_NOT_COMPLETED');
    requireSafe(evidence.tool_proposals === 1 && evidence.business_dispatches === 1 && businessCompleted,
      'UNEXPECTED_TOOL_OR_SQL_COUNT');
    const { source, recommendations } = reply.body.response;
    const expected = OFFER_IDS.map((id) =>
      ({ ...catalogFields(baseline.find((row) => row.offer_id === id)), reasons: REASONS }));
    requireSafe(['accepted_plan', 'deterministic_fallback'].includes(source) &&
      same(recommendations, expected), 'UNGROUNDED_ADVISOR_RESPONSE');
    evidence.grounding = source;
    evidence.offer_ids = [...OFFER_IDS];
  } catch (error) {
    evidence.problems.push(error instanceof RunFailure ? error.message : stage + '_FAILED');
  } finally {
    for (const remove of removeAbortObservers) remove();
    if (app) {
      try { await app.close(); evidence.cleanup.app = true; }
      catch { evidence.problems.push('APP_CLEANUP_FAILED'); }
    }
    if (db) {
      try { await db.end(); } catch { evidence.problems.push('APPLICATION_POOL_CLEANUP_FAILED'); }
    }
    if (baseline) {
      try {
        const after = (await audit.query(SNAPSHOT)).rows;
        evidence.after_sha256 = fingerprint(after);
        requireSafe(evidence.after_sha256 === evidence.before_sha256 && same(after, baseline), 'FIXTURE_CHANGED');
      } catch (error) {
        evidence.problems.push(error instanceof RunFailure ? error.message : 'POST_FIXTURE_AUDIT_FAILED');
      }
    }
    if (audit) {
      try { await audit.end(); } catch { evidence.problems.push('AUDIT_POOL_CLEANUP_FAILED'); }
    }
    if (evidence.connection_failure) evidence.problems.push('CHECKED_OUT_CONNECTION_FAILED');
    if (io.idleFailure?.()) evidence.problems.push('IDLE_POOL_FAILURE');
  }
  const usageKnown = evidence.requests.length > 0 && evidence.requests.every((record) => record.estimated_usd !== null);
  evidence.estimated_usd = usageKnown ? evidence.requests.reduce((sum, record) => sum + record.estimated_usd, 0) : null;
  if (evidence.estimated_usd !== null && evidence.estimated_usd > SPEND_BUDGET) {
    evidence.problems.push('INTENDED_BUDGET_EXCEEDED');
  }
  return structuredClone({ ok: evidence.problems.length === 0, ...evidence });
}

export const OFFLINE_ENV = Object.freeze({
  DATABASE_URL: 'postgresql://p3_d12:synthetic-db-marker@127.0.0.1:55432/p3_d12',
  OPENAI_API_KEY: 'synthetic-provider-marker',
  P3_DEMO_TOKEN_A: 'synthetic-demo-academy-a-marker-0000',
  P3_DEMO_TOKEN_B: 'synthetic-demo-academy-b-marker-0000',
});

export function mockIO() {
  return {
    makePool(_connection, role) {
      return {
        async connect() {
          return {
            async query(sql) {
              if (sql === IDENTITY) return { rows: structuredClone([EXPECTED_IDENTITY]) };
              if (role === 'application' && sql === BUSINESS_SQL) return { rows: structuredClone(MOCK_ROWS
                .filter((row) => row.tenant_id === BUSINESS_ARGS[0] && row.active).map(catalogFields)) };
              const fixtures = new Map([[TABLES, EXPECTED_TABLES], [COLUMNS, EXPECTED_COLUMNS],
                [CHECKS, Object.entries(EXPECTED_CHECKS).map(([conname, [contype, definition]]) =>
                  ({ conname, contype, convalidated: true, definition }))],
                [TRIGGERS, [{ count: 0 }]], [SNAPSHOT, MOCK_ROWS]]);
              requireSafe(role === 'audit' && fixtures.has(sql), 'UNEXPECTED_MOCK_SQL');
              return { rows: structuredClone(fixtures.get(sql)) };
            },
            release() {},
            on() {},
            off() {},
          };
        },
        async end() {},
      };
    },
    async fetchResponse(_url, init) {
      const initial = JSON.parse(init.body).max_output_tokens === OUTPUT_TOKENS.initial;
      const plan = { offers: OFFER_IDS.map((offer_id) => ({ offer_id, reason_ids: REASON_IDS })) };
      const item = initial ? { type: 'function_call', name: 'find_suitable_courses', call_id: 'call_offline',
        status: 'completed', arguments: JSON.stringify(CONSTRAINTS) } :
        { type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(plan) }] };
      return Response.json({ id: initial ? 'resp_0000aaaa' : 'resp_0000bbbb', object: 'response',
        model: MODEL, status: 'completed', error: null, incomplete_details: null, output: [item],
        usage: { input_tokens: 250, output_tokens: 80 } },
      { headers: { 'x-request-id': initial ? 'req_1111aaaa' : 'req_1111bbbb' } });
    },
  };
}

export async function loadApplication(buildDir) {
  requireSafe(/^dist\/b3c2-[a-zA-Z0-9_-]+$/.test(buildDir), 'EXPLICIT_BUILD_DIRECTORY_REQUIRED');
  const [app, model] = await Promise.all([
    import(new URL('../' + buildDir + '/src/app.module.js', import.meta.url)),
    import(new URL('../' + buildDir + '/src/ai/openai.model.client.js', import.meta.url)),
  ]);
  return { createApplication: app.createApplication, OpenAIModelClient: model.OpenAIModelClient };
}

async function liveIO() {
  const { default: { Pool } } = await import('pg');
  let idleFailure = false;
  return {
    makePool(connection) {
      const pool = new Pool({ ...connection, max: 1, ssl: false, connectionTimeoutMillis: 2000,
        query_timeout: 2000, statement_timeout: 1500, idleTimeoutMillis: 1000,
        options: '-c default_transaction_read_only=on -c search_path=pg_catalog,public' });
      pool.on('error', () => { idleFailure = true; });
      return pool;
    },
    idleFailure: () => idleFailure,
    fetchResponse: (url, options) => fetch(url, options),
  };
}

if (import.meta.main) {
  try {
    const [buildDir, ...modeArgs] = process.argv.slice(2);
    const mode = executionMode(modeArgs, () => process.env.P3_B3C2_CONFIRM_LIVE);
    const advisorLatency = modeArgs[1] === EXPERIMENTAL_LATENCY_FLAG ? EXPERIMENTAL_LATENCY : undefined;
    const application = await loadApplication(buildDir);
    const io = mode === 'offline' ? mockIO() : await liveIO();
    const result = await runAcceptance(mode === 'offline' ? OFFLINE_ENV : process.env, application, io, advisorLatency);
    console.log(JSON.stringify({ mode, ...result }));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, problem: error instanceof RunFailure ? error.message : 'RUNNER_START_FAILED' }));
    process.exitCode = 1;
  }
}
