import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Server, Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { test, mock } from 'node:test';
import { Pool, type QueryResult } from 'pg';
import { createApplication, FAKE_ADVISOR_MODEL } from '../src/app.module.js';
import { loadConfig } from '../src/config.js';
import { CATALOG_SQL } from '../src/catalog/catalog.repository.js';
import type { CourseOffer } from '../src/catalog/catalog.types.js';
import type { ModelClient, ModelRequest } from '../src/ai/model.client.js';
import type { RecommendationRequest, RecommendationResponse } from '../src/recommendations/recommendations.types.js';

// Importing this file constructs no pool and initializes no application.
// P3_B3B_DB_INTEGRATION=1 is a technical guard, not a substitute for human authorization.
class SafeFailure extends Error {}
function requireSafe(condition: unknown, label: string): asserts condition {
  if (!condition) throw new SafeFailure(label);
}
function equal(actual: unknown, expected: unknown, label: string): void {
  requireSafe(isDeepStrictEqual(actual, expected), label); // Never print unknown SQL/config payloads.
}
function approvedTarget(raw: unknown): string {
  try {
    requireSafe(typeof raw === 'string', 'Invalid approved database target.');
    const url = new URL(raw);
    requireSafe(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
      url.port === '55432' && url.pathname === '/p3_d12' && url.username === 'p3_d12' &&
      !!url.password && !url.search && !url.hash, 'Invalid approved database target.');
    return raw;
  } catch { throw new SafeFailure('Invalid approved database target.'); }
}
function safeError(stage: string, error: unknown): Error {
  const known = error instanceof SafeFailure ? error.message : 'Details redacted.';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const category = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPERM', '28P01', '57014'].includes(String(code)) ? ` (${code})` : '';
  return new Error(`${stage}${category}: ${known}`); // No raw cause, query, connection URL or credentials.
}

type Fixture = CourseOffer & { tenant_id: string; active: boolean };
// Independent expectations only. These rows are never supplied to the business executor.
const expectedFixtures: Fixture[] = [
  { offer_id: 'p3-a-101', tenant_id: 'academy-a', title: 'Synthetic Python Foundations', price_cents: 12000, currency: 'USD', required_skills: [], weekly_study_hours: 4, active: true },
  { offer_id: 'p3-a-102', tenant_id: 'academy-a', title: 'Synthetic Backend APIs', price_cents: 24000, currency: 'USD', required_skills: ['basic-python'], weekly_study_hours: 6, active: true },
  { offer_id: 'p3-a-103', tenant_id: 'academy-a', title: 'Synthetic Retired Workshop', price_cents: 5000, currency: 'USD', required_skills: [], weekly_study_hours: 2, active: false },
  { offer_id: 'p3-b-101', tenant_id: 'academy-b', title: 'Synthetic SQL Foundations', price_cents: 9500, currency: 'USD', required_skills: [], weekly_study_hours: 3, active: true },
  { offer_id: 'p3-b-102', tenant_id: 'academy-b', title: 'Synthetic Data Services', price_cents: 18500, currency: 'USD', required_skills: ['basic-sql'], weekly_study_hours: 5, active: true },
  { offer_id: 'p3-b-103', tenant_id: 'academy-b', title: 'Synthetic Archived Seminar', price_cents: 7000, currency: 'USD', required_skills: [], weekly_study_hours: 2, active: false },
];
function canonical(rows: Fixture[]): string {
  // Caller verifies complete rows/schema first. Canonicalization does not conceal extra columns.
  return JSON.stringify([...rows].sort((a, b) => a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0)
    .map((r) => ({ offer_id: r.offer_id, tenant_id: r.tenant_id, title: r.title, price_cents: r.price_cents,
      currency: r.currency, required_skills: r.required_skills, weekly_study_hours: r.weekly_study_hours, active: r.active })));
}
const digest = (rows: Fixture[]) => createHash('sha256').update(canonical(rows)).digest('hex');
const IDENTITY = `SELECT current_database() AS db, current_user AS owner,
  current_setting('default_transaction_read_only') AS default_ro,
  current_setting('transaction_read_only') AS transaction_ro,
  current_setting('search_path') AS search_path, current_setting('server_version') AS version`;
const TABLES = `SELECT c.relname, c.relkind, c.relrowsecurity FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`;
const COLUMNS = `SELECT column_name, data_type, udt_name, is_nullable, column_default
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'course_offers' ORDER BY ordinal_position`;
const CONSTRAINTS = `SELECT conname, contype, pg_catalog.pg_get_constraintdef(oid, true) AS definition
  FROM pg_catalog.pg_constraint WHERE conrelid = 'public.course_offers'::regclass ORDER BY conname`;
const TRIGGERS = `SELECT count(*)::int AS count FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'public.course_offers'::regclass AND NOT tgisinternal`;
const SNAPSHOT = 'SELECT * FROM public.course_offers ORDER BY offer_id';
const REVIEWED_AUDIT_SQL = new Set([IDENTITY, TABLES, COLUMNS, CONSTRAINTS, TRIGGERS, SNAPSHOT]);
const EXPECTED_COLUMNS = [
  ['offer_id', 'text', 'text', 'NO', null], ['tenant_id', 'text', 'text', 'NO', null],
  ['title', 'text', 'text', 'NO', null], ['price_cents', 'integer', 'int4', 'NO', null],
  ['currency', 'text', 'text', 'NO', null], ['required_skills', 'ARRAY', '_text', 'NO', "'{}'::text[]"],
  ['weekly_study_hours', 'integer', 'int4', 'NO', null], ['active', 'boolean', 'bool', 'NO', null],
].map(([column_name, data_type, udt_name, is_nullable, column_default]) =>
  ({ column_name, data_type, udt_name, is_nullable, column_default }));
// PostgreSQL deparses IN as ANY(ARRAY[]) and may render TRIM as btrim.
// Ignore formatting and text casts, but preserve operators, bounds and regex case.
const normalizeConstraint = (s: string) => s.replace(/::text/g, '').replace(/[\s()]/g, '');
const EXPECTED_CONSTRAINTS: Record<string, { type: string; definitions: string[] }> = {
  course_offers_pkey: { type: 'p', definitions: ['PRIMARY KEY (offer_id)'] },
  course_offers_offer_id_check: { type: 'c', definitions: ['CHECK (length(offer_id) >= 1 AND length(offer_id) <= 80)'] },
  course_offers_tenant_id_check: { type: 'c', definitions: ["CHECK (tenant_id = ANY (ARRAY['academy-a'::text, 'academy-b'::text]))"] },
  course_offers_title_check: { type: 'c', definitions: ['CHECK (length(TRIM(BOTH FROM title)) >= 1 AND length(TRIM(BOTH FROM title)) <= 200)',
    'CHECK (length(btrim(title)) >= 1 AND length(btrim(title)) <= 200)'] },
  course_offers_price_cents_check: { type: 'c', definitions: ['CHECK (price_cents >= 0)'] },
  course_offers_currency_check: { type: 'c', definitions: ["CHECK (currency ~ '^[A-Z]{3}$'::text)"] },
  course_offers_required_skills_check: { type: 'c', definitions: ['CHECK (array_position(required_skills, NULL::text) IS NULL)'] },
  course_offers_weekly_study_hours_check: { type: 'c', definitions: ['CHECK (weekly_study_hours >= 1 AND weekly_study_hours <= 168)'] },
};
function verifyConstraints(rows: { conname: string; contype: string; definition: string }[]): void {
  equal(rows.map((r) => r.conname).sort(), Object.keys(EXPECTED_CONSTRAINTS).sort(), 'Unexpected constraint inventory.');
  for (const r of rows) {
    const wanted = EXPECTED_CONSTRAINTS[r.conname];
    requireSafe(r.contype === wanted.type && wanted.definitions.some((s) => normalizeConstraint(s) === normalizeConstraint(r.definition)),
      'Unexpected constraint definition; stop without schema repair.');
  }
}

type App = Awaited<ReturnType<typeof createApplication>>;
interface Reply { status: number; cache: string | undefined; body: unknown }
async function dispatch(app: App, token: string | undefined, body: unknown, path = '/advisor/recommendations',
  method = 'POST', headers: Record<string, string> = {}): Promise<Reply> {
  const socket = new Socket(); const incoming = new IncomingMessage(socket);
  const raw = method === 'GET' ? '' : JSON.stringify(body);
  incoming.method = method; incoming.url = path; incoming.complete = true;
  incoming.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)),
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  const response = new ServerResponse(incoming); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Reply>((resolve, reject) => {
      timer = setTimeout(() => reject(new SafeFailure('In-process HTTP dispatch timed out.')), 7000);
      incoming.once('error', reject); response.once('error', reject); socket.once('error', reject);
      response.end = ((chunk?: unknown) => {
        try { resolve({ status: response.statusCode, cache: response.getHeader('cache-control') as string | undefined,
          body: chunk ? JSON.parse(String(chunk)) : null }); } catch { reject(new SafeFailure('Invalid HTTP JSON response.')); }
        return response;
      }) as typeof response.end;
      app.getHttpServer().emit('request', incoming, response);
      incoming.push(Buffer.from(raw)); incoming.push(null);
    });
  } finally { clearTimeout(timer); incoming.destroy(); response.destroy(); socket.destroy(); }
}

// Pure checks deliberately use placeholder credentials, never loadConfig/process credentials.
test('B3B2 offline safety: target validation and canonical fixture comparison', () => {
  const blocked = [mock.method(Pool.prototype, 'connect', () => { throw new Error('SQL forbidden offline'); }),
    mock.method(Pool.prototype, 'query', () => { throw new Error('SQL forbidden offline'); }),
    mock.method(Server.prototype, 'listen', () => { throw new Error('Listening forbidden'); }),
    mock.method(Socket.prototype, 'connect', () => { throw new Error('Network forbidden offline'); })];
  try {
    const valid = 'postgresql://p3_d12:offline-placeholder@127.0.0.1:55432/p3_d12';
    assert.equal(approvedTarget(valid), valid);
    for (const invalid of [undefined, '', 'invalid', valid.replace('127.0.0.1', 'localhost'), valid.replace('127.0.0.1', 'remote.invalid'),
      valid.replace('55432', '5432'), valid.replace(/\/p3_d12$/, '/other'), valid.replace('p3_d12:', 'other:'),
      valid.replace(':offline-placeholder', ''), valid + '?sslmode=disable', valid + '#fragment']) {
      assert.throws(() => approvedTarget(invalid), { message: 'Invalid approved database target.' });
    }
    assert.equal(digest([...expectedFixtures].reverse()), digest(expectedFixtures));
    const changed = structuredClone(expectedFixtures); changed[0].price_cents++;
    assert.notEqual(digest(changed), digest(expectedFixtures));
    assert.equal(safeError('setup', new Error('PRIVATE password URL')).message, 'setup: Details redacted.');
  } finally {
    const counts = blocked.map((m) => m.mock.callCount()); for (const m of blocked) m.mock.restore();
    assert.deepEqual(counts, [0, 0, 0, 0]);
  }
});

test('B3B2 real PostgreSQL acceptance: separately authorized SELECT-only fixture verification', {
  skip: process.env.P3_B3B_DB_INTEGRATION === '1' ? false : 'SKIPPED: P3_B3B_DB_INTEGRATION=1 and separate human authorization required.',
  timeout: 60000,
}, async (t) => {
  // All private configuration, pools and application initialization are behind the opt-in guard.
  const url = approvedTarget(process.env.DATABASE_URL);
  const config = loadConfig({ ...process.env, DATABASE_URL: url });
  const failures: Error[] = []; let stage = 'setup'; let before: Fixture[] | undefined;
  let audit: Pool | undefined, application: Pool | undefined, app: App | undefined;
  let applicationClosed = false, auditClosed = false, appPoolClosed = false;
  let restoreModel: (() => void) | undefined, restoreQuery: (() => void) | undefined;
  const idleFailures: string[] = [];
  const listen = mock.method(Server.prototype, 'listen', () => { throw new SafeFailure('TCP listening is forbidden.'); });
  function makePool(name: string): Pool {
    // pg/lib/client.js forwards startup options; pg-pool/index.js awaits onConnect
    // before checkout, including every replacement connection. No async event-listener race.
    // Session defaults are precautions, not reduced owner privileges or production RLS.
    const pool = new Pool({ connectionString: url, max: name === 'audit' ? 1 : 4, ssl: false,
      connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 1500, idleTimeoutMillis: 1000,
      options: '-c default_transaction_read_only=on -c search_path=pg_catalog,public',
      onConnect: async (client) => {
        const identity = (await client.query(IDENTITY)).rows[0];
        requireSafe(identity?.db === 'p3_d12' && identity.owner === 'p3_d12' && identity.default_ro === 'on' &&
          identity.transaction_ro === 'on' && identity.search_path.replace(/\s/g, '') === 'pg_catalog,public',
        'Unexpected connection identity or read-only settings.');
      } });
    pool.on('error', () => { idleFailures.push(name); }); // Never log a raw driver error.
    return pool;
  }
  async function auditRead(sql: string) {
    requireSafe(REVIEWED_AUDIT_SQL.has(sql) && !!audit, 'Unreviewed audit SQL.');
    return audit.query(sql);
  }
  async function closeApplicationPool() {
    if (application && !appPoolClosed) { await application.end(); appPoolClosed = true; }
  }
  try {
    audit = makePool('audit'); application = makePool('application');
    const identity = (await auditRead(IDENTITY)).rows[0];
    // Ensure the application pool has also passed its connection hook before any HTTP request.
    await application.query(IDENTITY);
    t.diagnostic(`Approved client endpoint 127.0.0.1:55432; database/user p3_d12; PostgreSQL ${String(identity.version).replace(/[^0-9.]/g, '')}; read-only verified.`);
    equal((await auditRead(TABLES)).rows, [{ relname: 'course_offers', relkind: 'r', relrowsecurity: false }], 'Unexpected public relation inventory.');
    equal((await auditRead(COLUMNS)).rows, EXPECTED_COLUMNS, 'Unexpected catalog columns or defaults.');
    verifyConstraints((await auditRead(CONSTRAINTS)).rows);
    equal((await auditRead(TRIGGERS)).rows, [{ count: 0 }], 'Unexpected user triggers.');
    before = (await auditRead(SNAPSHOT)).rows as Fixture[];
    equal(before, expectedFixtures, 'Unexpected complete fixture state; stop without repair.');
    const initialHash = digest(before);
    t.diagnostic(`Six-row pre-test fixture SHA-256: ${initialHash}`);
    stage = 'acceptance';
    app = await createApplication(config, { advisorMode: 'fake-model-postgres', databasePool: application });
    // Observe pool shutdown ownership; preserve the driver's real end implementation.
    const endApplication = application.end.bind(application);
    application.end = async () => { await endApplication(); appPoolClosed = true; };
    await app.init();
    const queries: { sql: string; values: unknown[] }[] = [];
    // Forward every observed application query to the real pool. No fabricated rows.
    const observed = application as unknown as { query(sql: string, values?: unknown[]): Promise<QueryResult> };
    const originalQuery = observed.query.bind(application);
    observed.query = (sql, values = []) => {
      requireSafe(sql === CATALOG_SQL || sql === `${CATALOG_SQL} LIMIT $2`, 'Unreviewed application SQL.');
      queries.push({ sql, values: [...values] }); return originalQuery(sql, values);
    };
    restoreQuery = () => { observed.query = originalQuery; };
    const model = app.get<ModelClient>(FAKE_ADVISOR_MODEL), originalModel = model.request.bind(model);
    const inputs: ModelRequest[] = []; let invalidProposal: string | undefined;
    model.request = async (input, signal) => { inputs.push(input); return invalidProposal ?? originalModel(input, signal); };
    restoreModel = () => { model.request = originalModel; };
    const maria: RecommendationRequest = { budget_cents: 30000, weekly_hours: 6, known_skills: ['basic-python'] };
    const reasons = ['Within the declared budget.', 'Fits the weekly study-hour limit.', 'Required skills match the declared skills.'];
    const expected = (ids: string[]): RecommendationResponse => ({ recommendations: ids.map((id) => {
      const row = before!.find((r) => r.offer_id === id);
      requireSafe(row, 'Expected stored offer missing.');
      const { tenant_id: _tenant, active: _active, ...facts } = row;
      return { ...facts, reasons: [...reasons] };
    }) });
    const envelope = (constraints: RecommendationRequest) => ({ constraints, confirmed: true });
    async function successful(token: string, tenant: string, constraints: RecommendationRequest, ids: string[], path?: string, headers?: Record<string, string>) {
      const count = queries.length, modelCount = inputs.length;
      const reply = await dispatch(app!, token, envelope(constraints), path, 'POST', headers);
      equal(reply, { status: 200, cache: 'no-store', body: { status: 'completed', response: { source: 'accepted_plan', ...expected(ids) } } }, 'Unexpected persisted advisor response.');
      equal(queries.slice(count), [{ sql: `${CATALOG_SQL} LIMIT $2`, values: [tenant, 1001] }], 'Incorrect request SQL parameters or count.');
      requireSafe(inputs.length === modelCount + 2, 'Unexpected model invocation count.');
      const final = inputs.at(-1)!;
      requireSafe(final.phase === 'final', 'Missing final model phase.');
      equal(final.facts.recommendations, expected(ids).recommendations, 'Unexpected final model facts.');
      requireSafe(final.facts.recommendations.length <= 10 && final.facts.recommendations.every((offer) =>
        before!.some((r) => r.offer_id === offer.offer_id && r.tenant_id === tenant && r.active)), 'Foreign or inactive model facts.');
    }
    for (let repeat = 0; repeat < 3; repeat++) await successful(config.tokenA, 'academy-a', maria, ['p3-a-102', 'p3-a-101']);
    await successful(config.tokenB, 'academy-b', { ...maria, known_skills: ['basic-sql'] }, ['p3-b-102', 'p3-b-101']);
    await successful(config.tokenB, 'academy-b', { ...maria, known_skills: [] }, ['p3-b-101']);
    for (const [constraints, ids] of [
      [{ ...maria, budget_cents: 24000 }, ['p3-a-102', 'p3-a-101']], [{ ...maria, budget_cents: 23999 }, ['p3-a-101']],
      [{ ...maria, weekly_hours: 5 }, ['p3-a-101']], [{ ...maria, known_skills: ['python'] }, ['p3-a-101']],
      [{ ...maria, known_skills: [] }, ['p3-a-101']], [{ ...maria, budget_cents: 0 }, []],
    ] as [RecommendationRequest, string[]][]) await successful(config.tokenA, 'academy-a', constraints, ids);
    for (const [token, tenant, other, ids] of [
      [config.tokenA, 'academy-a', 'academy-b', ['p3-a-102', 'p3-a-101']],
      [config.tokenB, 'academy-b', 'academy-a', ['p3-b-101']],
    ] as [string, string, string, string[]][]) await successful(token, tenant, maria, ids,
      `/advisor/recommendations?tenant_id=${other}&tenantId=${other}`, { 'x-tenant-id': other, tenant_id: other });
    for (const token of [undefined, 'invalid', 'x'.repeat(32)]) {
      const q = queries.length, m = inputs.length;
      equal(await dispatch(app, token, envelope(maria)), { status: 401, cache: 'no-store', body: { status: 'error', code: 'UNAUTHORIZED' } }, 'Authentication rejection changed.');
      requireSafe(queries.length === q && inputs.length === m, 'Unauthorized request executed business/model work.');
    }
    for (const body of [{ ...envelope(maria), tenantId: 'academy-b' }, { constraints: { ...maria, tenant_id: 'academy-b' }, confirmed: true }]) {
      const q = queries.length, m = inputs.length;
      equal(await dispatch(app, config.tokenA, body), { status: 400, cache: 'no-store', body: { status: 'error', code: 'INVALID_ADVISOR_REQUEST' } }, 'Body authority rejection changed.');
      requireSafe(queries.length === q && inputs.length === m, 'Invalid body executed business/model work.');
    }
    try {
      invalidProposal = JSON.stringify({ kind: 'tool_proposals', proposals: [{ name: 'find_suitable_courses', arguments: JSON.stringify({ ...maria, tenantId: 'academy-b' }) }] });
      const q = queries.length;
      equal(await dispatch(app, config.tokenA, envelope(maria)), { status: 502, cache: 'no-store', body: { status: 'error', code: 'ADVISOR_PROTOCOL_ERROR' } }, 'Invalid model proposal accepted.');
      requireSafe(queries.length === q, 'Invalid model proposal executed SQL.');
    } finally { invalidProposal = undefined; }
    equal(await dispatch(app, undefined, undefined, '/health', 'GET'), { status: 200, cache: undefined, body: { status: 'ok' } }, 'Health regression.');
    for (const [token, tenant] of [[config.tokenA, 'academy-a'], [config.tokenB, 'academy-b']]) {
      const stored = before.filter((r) => r.tenant_id === tenant && r.active).map(({ tenant_id: _t, active: _a, ...facts }) => facts);
      equal(await dispatch(app, token, undefined, '/catalog/offers', 'GET'), { status: 200, cache: 'no-store', body: stored }, 'Catalog regression.');
    }
    equal(await dispatch(app, config.tokenA, maria, '/recommendations'), { status: 200, cache: 'no-store', body: expected(['p3-a-102', 'p3-a-101']) }, 'Recommendations regression.');
    t.diagnostic('Persisted facts, both tenant scopes, negative authority paths, no-match and existing routes verified. Ten/sentinel boundary evidence remains offline.');
  } catch (error) { failures.push(safeError(stage, error)); }
  finally {
    // Every cleanup is attempted. A failed/missing preservation audit remains a failure.
    try { if (app) { await app.close(); applicationClosed = true; } } catch (error) { failures.push(safeError('application cleanup', error)); }
    try { await closeApplicationPool(); } catch (error) { failures.push(safeError('application pool cleanup', error)); }
    try {
      if (before) {
        const after = (await auditRead(SNAPSHOT)).rows as Fixture[];
        equal(after, before, 'Complete fixture preservation failed.');
        equal(digest(after), digest(before), 'Canonical fixture hash changed.');
        t.diagnostic(`Complete post-test fixture equality verified; SHA-256: ${digest(after)}`);
      } else failures.push(new Error('preservation: No verified pre-test snapshot; acceptance not established.'));
    } catch (error) { failures.push(safeError('preservation', error)); }
    try { restoreModel?.(); restoreQuery?.(); } catch (error) { failures.push(safeError('observer cleanup', error)); }
    try { if (audit) { await audit.end(); auditClosed = true; } } catch (error) { failures.push(safeError('audit pool cleanup', error)); }
    if (idleFailures.length) failures.push(new Error('dependency: Idle pool errors observed; details redacted.'));
    if (listen.mock.callCount()) failures.push(new Error('cleanup: Unexpected TCP listening attempt.'));
    listen.mock.restore();
    if (!app || !applicationClosed || !appPoolClosed || !auditClosed) failures.push(new Error('cleanup: Acceptance lifecycle incomplete.'));
  }
  if (failures.length) throw new AggregateError(failures, 'B3B2 acceptance failed; sanitized stage failures follow.');
  t.diagnostic('Application and both pools closed; no listening server. No fixture writes or live-model calls.');
});
