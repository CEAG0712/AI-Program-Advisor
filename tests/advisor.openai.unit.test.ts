import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { AppModule, createApplication } from '../src/app.module.js';
import { ADVISOR } from '../src/ai/advisor.controller.js';
import { AdvisorService, type AdvisorRuntime } from '../src/ai/advisor.service.js';
import type { ModelRequest } from '../src/ai/model.client.js';
import { OpenAIModelClient, type OpenAIModelOptions } from '../src/ai/openai.model.client.js';
import { deterministicFallback, REASON_IDS } from '../src/ai/response.policy.js';
import { TOOL_NAME } from '../src/ai/tool.contract.js';
import { REASONS } from '../src/recommendations/recommendations.policy.js';

const apiKey = 'synthetic-offline-placeholder';
const failure = { message: 'OpenAI model request failed.' };
const confirmed = { budget_cents: 30000, weekly_hours: 6, known_skills: ['basic-python'] };
const tenant = { tenantId: 'academy-a' } as const;
const facts = { recommendations: [{ offer_id: 'test-101', title: 'Synthetic Python course', price_cents: 12000,
  currency: 'USD' as const, required_skills: [], weekly_study_hours: 4, reasons: [...REASONS] }] };
const plan = { offers: [{ offer_id: 'test-101', reason_ids: [...REASON_IDS] }] };
const initial = { phase: 'initial', constraints: confirmed } as const;
const final = { phase: 'final', facts: deterministicFallback(facts) } as const;
const signal = () => new AbortController().signal;
const provider = (...output: unknown[]) =>
  ({ object: 'response', status: 'completed', error: null, incomplete_details: null, output });
const tool = (args = JSON.stringify(confirmed)) =>
  ({ type: 'function_call', name: TOOL_NAME, call_id: 'call_one', status: 'completed', arguments: args });
const message = (...content: unknown[]) => ({ type: 'message', role: 'assistant', status: 'completed', content });
const outputText = (text: string) => ({ type: 'output_text', text, annotations: [] });
const explanation = (value: unknown = plan) => Response.json(provider(message(outputText(JSON.stringify(value)))));
const refusal = message({ type: 'refusal', refusal: 'Synthetic refusal text' });

function mockHTTP(...responses: (() => Response | Promise<Response>)[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const transport: NonNullable<OpenAIModelOptions['transport']> = async (url, init) => {
    requests.push({ url, init });
    const reply = responses.shift();
    assert.ok(reply, 'Unexpected provider request');
    return reply();
  };
  return { requests, options: { apiKey, transport } };
}

function orchestration(http: ReturnType<typeof mockHTTP>, clock?: AdvisorRuntime) {
  const dispatched: unknown[] = [];
  const advisor = new AdvisorService(new OpenAIModelClient(http.options), {
    execute: async (scope, args) => { dispatched.push({ scope, args }); return facts; },
  }, clock);
  return { advisor, dispatched };
}

test('adapter: default transport sends a single strict function and returns raw arguments unchanged', async (t) => {
  const raw = ' { "weekly_hours": 6, "known_skills": ["basic-python"], "budget_cents": 30000 }\n';
  const http = mockHTTP(() => Response.json(provider(tool(raw))));
  t.mock.method(globalThis, 'fetch', http.options.transport);
  const abortSignal = signal();
  const constraints = { ...confirmed, tenantId: tenant.tenantId, token: 'synthetic-demo-token' };
  const reply = await new OpenAIModelClient({ apiKey }).request({ phase: 'initial', constraints }, abortSignal);
  assert.deepEqual(JSON.parse(reply), { kind: 'tool_proposals', proposals: [{ name: TOOL_NAME, arguments: raw }] });
  assert.equal(http.requests.length, 1);
  const [{ url, init }] = http.requests;
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.signal, abortSignal);
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-offline-placeholder');
  assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
  const body = JSON.parse(String(init.body));
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.equal(body.max_output_tokens, 3072);
  assert.equal(body.store, false);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tools.length, 1);
  const [definition] = body.tools;
  assert.deepEqual(body.tool_choice, { type: 'function', name: TOOL_NAME });
  assert.equal(definition.type, 'function');
  assert.equal(definition.name, TOOL_NAME);
  assert.equal(definition.strict, true);
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(definition.parameters.required, Object.keys(confirmed));
  assert.deepEqual(JSON.parse(body.input), confirmed);
  assert.doesNotMatch(String(init.body), /academy-a|synthetic-demo-token|synthetic-offline-placeholder/);
});

test('adapter: final phase sends IDs only and requests a strict explanation with no tools or history', async () => {
  const http = mockHTTP(() => explanation());
  const reply = await new OpenAIModelClient(http.options).request(final, signal());
  assert.deepEqual(JSON.parse(reply), { kind: 'explanation', plan });
  assert.equal(http.requests.length, 1);
  const body = JSON.parse(String(http.requests[0].init.body));
  assert.deepEqual(JSON.parse(body.input), { offer_ids: ['test-101'] });
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 4096);
  for (const key of ['tools', 'tool_choice', 'previous_response_id', 'conversation']) assert.ok(!(key in body));
  const format = body.text.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.strict, true);
  assert.equal(format.schema.additionalProperties, false);
  const offerSchema = format.schema.properties.offers.items;
  assert.equal(offerSchema.additionalProperties, false);
  assert.deepEqual(offerSchema.required, ['offer_id', 'reason_ids']);
  assert.deepEqual(offerSchema.properties.reason_ids.items.enum, REASON_IDS);
});

for (const [name, response] of [
  ['incomplete envelope', () => Response.json({ ...provider(tool()), status: 'incomplete' })],
  ['incomplete details on completed envelope', () => Response.json({ ...provider(tool()), incomplete_details: {} })],
  ['incomplete function item', () => Response.json(provider({ ...tool(), status: 'incomplete' }))],
  ['truncated JSON', () => new Response('{"object":"response","output":[')],
  ['invalid UTF-8', () => new Response(Uint8Array.of(0xff))],
  ['truncated body stream', () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error('synthetic truncation')); },
  }))],
  ['missing call ID', () => Response.json(provider({ ...tool(), call_id: undefined }))],
  ['non-string arguments', () => Response.json(provider({ ...tool(), arguments: confirmed }))],
  ['unsupported output type', () => Response.json(provider({ type: 'web_search_call' }))],
  ['ordinary text in initial phase', () => Response.json(provider(message(outputText('unrequested prose'))))],
  ['ambiguous mixed content', () => Response.json(provider(message(
    { type: 'refusal', refusal: 'synthetic' }, outputText('unrequested prose'))))],
  ['missing body', () => new Response(null, { status: 204 })],
  ['HTTP 302', () => new Response('PRIVATE response', { status: 302, headers: { Location: 'https://offline.invalid/' } })],
  ['HTTP 429', () => new Response('PRIVATE response', { status: 429 })],
  ['HTTP 503', () => new Response('PRIVATE response', { status: 503 })],
  ['network failure', () => { throw new Error('PRIVATE transport error'); }],
] as const) {
  test('adapter: ' + name + ' rejects with a fixed error after one request', async () => {
    const http = mockHTTP(response);
    await assert.rejects(new OpenAIModelClient(http.options).request(initial, signal()), failure);
    assert.equal(http.requests.length, 1);
  });
}

test('adapter: HTTP errors cancel without consuming the provider error body', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { pulls++; },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const http = mockHTTP(() => new Response(body, { status: 400 }));
  await assert.rejects(new OpenAIModelClient(http.options).request(initial, signal()), failure);
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
  assert.equal(http.requests.length, 1);
});

test('adapter: receive cap accepts exactly 64 KiB and cancels at the first overflowing chunk', async () => {
  const json = JSON.stringify(provider(tool()));
  const limit = 64 * 1024;
  const padded = json.padEnd(limit);
  const http = mockHTTP(() => new Response(padded));
  await new OpenAIModelClient(http.options).request(initial, signal());
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      assert.ok(pulls <= 2, 'Overflow should stop the reader before it requests more data');
      controller.enqueue(new TextEncoder().encode(pulls === 1 ? padded : ' '));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const over = mockHTTP(() => new Response(body));
  await assert.rejects(new OpenAIModelClient(over.options).request(initial, signal()), failure);
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(over.requests.length, 1);
});

test('adapter: pre-abort sends nothing, and abort during body read cancels the reader', async () => {
  const caller = new AbortController();
  caller.abort(new Error('PRIVATE abort reason'));
  const unused = mockHTTP();
  await assert.rejects(new OpenAIModelClient(unused.options).request(initial, caller.signal), failure);
  assert.equal(unused.requests.length, 0);
  const during = new AbortController();
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  const http = mockHTTP(() => new Response(new ReadableStream({
    pull() { reading.resolve(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })));
  const pending = new OpenAIModelClient(http.options).request(initial, during.signal);
  await reading.promise;
  during.abort();
  await assert.rejects(pending, failure);
  assert.equal(http.requests[0].init.signal, during.signal);
  assert.equal(http.requests.length, 1);
  assert.equal(cancelled, true);
});

for (const [name, output, expected] of [
  ['parallel calls', [tool(), tool()], { status: 'unavailable', code: 'MODEL_ERROR' }],
  ['mixed message and call', [refusal, tool()], { status: 'unavailable', code: 'MODEL_ERROR' }],
  ['wrong function', [{ ...tool(), name: 'wrong_tool' }], { status: 'unavailable', code: 'MODEL_ERROR' }],
  ['malformed argument JSON', [tool('{')], { status: 'rejected', code: 'INVALID_TOOL_ARGUMENTS' }],
  ['arguments beyond backend byte limit', [tool(JSON.stringify(confirmed).padEnd(4097))],
    { status: 'rejected', code: 'INVALID_TOOL_ARGUMENTS' }],
  ['tenant argument injection', [tool(JSON.stringify({ ...confirmed, tenantId: 'academy-b' }))],
    { status: 'rejected', code: 'INVALID_TOOL_ARGUMENTS' }],
  ['altered constraints', [tool(JSON.stringify({ ...confirmed, budget_cents: 30001 }))],
    { status: 'rejected', code: 'CONSTRAINT_MISMATCH' }],
  ['provider refusal', [refusal], { status: 'refused', code: 'MODEL_REFUSAL' }],
] as const) {
  test('orchestration: ' + name + ' stops before business dispatch and final request', async () => {
    const http = mockHTTP(() => Response.json(provider(...output)));
    const { advisor, dispatched } = orchestration(http);
    assert.deepEqual(await advisor.advise({ tenant, confirmed }), expected);
    assert.equal(dispatched.length, 0);
    assert.equal(http.requests.length, 1);
  });
}

for (const [name, finalResponse, source] of [
  ['valid plan', () => explanation(), 'accepted_plan'],
  ['invented offer', () => explanation({ offers: [{ ...plan.offers[0], offer_id: 'invented' }] }), 'deterministic_fallback'],
  ['invented reason', () => explanation({ offers: [{ ...plan.offers[0], reason_ids: ['checkout'] }] }), 'deterministic_fallback'],
  ['invented facts and authority', () => explanation({ offers: [{ ...plan.offers[0], price_cents: 0,
    title: 'Invented', tenantId: 'academy-b', checkout: true, prose: 'Synthetic prose' }] }), 'deterministic_fallback'],
  ['final refusal', () => Response.json(provider(refusal)), 'deterministic_fallback'],
  ['arbitrary text', () => Response.json(provider(message(outputText('unrequested prose')))), 'deterministic_fallback'],
  ['final tool call', () => Response.json(provider(tool())), 'deterministic_fallback'],
] as const) {
  test('orchestration: ' + name + ' keeps server facts and exactly one authorized dispatch', async () => {
    const http = mockHTTP(() => Response.json({ ...provider({ ...tool(), tenantId: 'academy-b' }),
      tenantId: 'academy-b' }), finalResponse);
    const { advisor, dispatched } = orchestration(http);
    assert.deepEqual(await advisor.advise({ tenant, confirmed }),
      { status: 'completed', response: { source, recommendations: facts.recommendations } });
    assert.deepEqual(dispatched, [{ scope: tenant, args: confirmed }]);
    assert.equal(http.requests.length, 2);
  });
}

for (const phase of ['initial', 'final'] satisfies ModelRequest['phase'][]) {
  test('orchestration: ' + phase + ' deadline aborts the pending transport without retry', async () => {
    let now = 0;
    let scheduled: (() => void) | undefined;
    const delays: number[] = [];
    const clock: AdvisorRuntime = {
      now: () => now,
      setTimer(callback, ms) { scheduled = callback; delays.push(ms); return callback; },
      clearTimer() { scheduled = undefined; },
    };
    const entered = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<Response>();
    const waitForDeadline = () => { entered.resolve(); return stalled.promise; };
    const http = phase === 'initial' ? mockHTTP(waitForDeadline) :
      mockHTTP(() => Response.json(provider(tool())), waitForDeadline);
    const { advisor, dispatched } = orchestration(http, clock);
    const pending = advisor.advise({ tenant, confirmed });
    await entered.promise;
    const matches = phase === 'initial' ? [2000] : [2000, 2500, 1000];
    assert.deepEqual(delays, matches);
    assert.ok(scheduled);
    now += matches.at(-1)!;
    scheduled();
    const result = await pending;
    assert.equal(http.requests.at(-1)?.init.signal?.aborted, true);
    stalled.reject(new Error('Synthetic late transport failure'));
    assert.deepEqual(result, phase === 'initial' ? { status: 'unavailable', code: 'TIMEOUT' } :
      { status: 'completed', response: deterministicFallback(facts) });
    assert.equal(dispatched.length, phase === 'initial' ? 0 : 1);
    assert.equal(http.requests.length, phase === 'initial' ? 1 : 2);
  });
}

test('composition: only the explicit server mode and supplied options install the OpenAI advisor', async () => {
  const config = { databaseUrl: 'postgresql://p3_d12:offline-placeholder@127.0.0.1:55432/p3_d12',
    tokenA: 'offline-placeholder-academy-a-0000', tokenB: 'offline-placeholder-academy-b-0000', port: 3000 };
  const http = mockHTTP(() => Response.json(provider(refusal)));
  const databasePool = { end: async () => {} } as Pool;
  assert.throws(() => AppModule.register(config, { openai: http.options }), /requires explicit OpenAI advisor mode/);
  assert.throws(() => AppModule.register(config, { advisorMode: 'openai-model-postgres' }), /requires explicit OpenAI advisor mode/);
  assert.throws(() => AppModule.register(config, { advisorMode: 'openai-model-postgres',
    openai: { apiKey: '' } }), { message: 'Invalid OpenAI adapter configuration.' });
  const disabled = await createApplication(config, { databasePool });
  try {
    await disabled.init();
    assert.equal(disabled.get(ADVISOR), null);
    assert.equal(http.requests.length, 0);
  } finally { await disabled.close(); }
  const enabled = await createApplication(config, { databasePool, advisorMode: 'openai-model-postgres', openai: http.options });
  try {
    await enabled.init();
    assert.ok(enabled.get(OpenAIModelClient) instanceof OpenAIModelClient);
    assert.deepEqual(await enabled.get<AdvisorService>(ADVISOR).advise({ tenant, confirmed }),
      { status: 'refused', code: 'MODEL_REFUSAL' });
    assert.equal(http.requests.length, 1);
  } finally { await enabled.close(); }
});
