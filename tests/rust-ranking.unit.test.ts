import 'reflect-metadata';
import assert from 'node:assert/strict';
import subprocess from 'node:child_process';
import { once, getEventListeners } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { RustRanker } from '../src/recommendations/rust-ranker.js';
import { compareRankingCandidates } from '../src/recommendations/recommendations.policy.js';
import type { RankingCandidate } from '../src/recommendations/ranking.js';

const binary = process.env.P3_D3_R2_RANKER;
const offer = (offer_id: string, weekly_study_hours = 6, price_cents = 100): RankingCandidate =>
  ({ offer_id, weekly_study_hours, price_cents });
const input = [offer('b'), offer('a')];
const response = JSON.stringify({ protocol_version: 1, ordered_offer_ids: ['a', 'b'] });
const nearMaxRequest = Array.from({ length: 1000 }, (_, i) => offer(String(i).padStart(4, '0') + '\x01'.repeat(76), 168, 2_147_483_647));

async function fixtures(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'p3-d3-r2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return async (name: string, source?: string) => {
    const path = join(directory, name);
    if (source !== undefined) await writeFile(path, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
    return path;
  };
}

function spyOnSpawn(t: TestContext) {
  const spy = t.mock.method(subprocess, 'spawn');
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  return spy;
}

const afterInput = (source: string) => "process.stdin.resume(); process.stdin.on('end', () => {" + source + '});';
const output = (value: string) => 'process.stdout.write(' + JSON.stringify(value) + ');';
const unavailable = { name: ServiceUnavailableException.name, message: 'Recommendation ranking temporarily unavailable.' };

test('Rust process protocol rejects malformed and incompatible executables', async (t) => {
  const fixture = await fixtures(t);
  const cases: [string, string?][] = [
    ['missing executable'],
    ['nonzero exit with valid stdout', afterInput(output(response) + 'process.exitCode = 9;')],
    ['crash via signal', afterInput("process.kill(process.pid, 'SIGKILL');")],
    ['premature exit with pending input', 'process.exit(0);'],
    ['partial stdout', afterInput(output('{"protocol_version":1'))],
    ['oversized stdout', afterInput(output(response) + "process.stdout.write(' '.repeat(10241));")],
    ['malformed stdout', afterInput(output('invalid'))],
    ['invalid utf8', afterInput("process.stdout.write(Buffer.from([0xff]));")],
    ['multiple JSON responses', afterInput(output(response + '\n' + response))],
    ['excessive stderr', afterInput("process.stderr.write('x'.repeat(4097));" + output(response))],
    ['unknown ID', afterInput(output('{"protocol_version":1,"ordered_offer_ids":["a","foreign"]}'))],
    ['duplicate IDs', afterInput(output('{"protocol_version":1,"ordered_offer_ids":["a","a"]}'))],
    ['missing ID', afterInput(output('{"protocol_version":1,"ordered_offer_ids":["a"]}'))],
    ['misordered IDs', afterInput(output('{"protocol_version":1,"ordered_offer_ids":["b","a"]}'))],
    ['non-string ID', afterInput(output('{"protocol_version":1,"ordered_offer_ids":["a",0]}'))],
    ['extra field', afterInput(output('{"protocol_version":1,"ordered_offer_ids":["a","b"],"title":"forged"}'))],
    ['duplicate field with hidden version', afterInput(output('{"protocol_version":2,"protocol_version":1,"ordered_offer_ids":["a","b"]}'))],
    ['unsupported version', afterInput(output('{"protocol_version":2,"ordered_offer_ids":["a","b"]}'))],
  ];
  for (const [name, source] of cases) {
    await t.test(name, async () => {
      const ranker = new RustRanker(await fixture(name, source));
      await assert.rejects(ranker.rank(name === 'premature exit with pending input' ? nearMaxRequest : input), unavailable);
    });
  }
  await t.test('reject invalid executable configuration, permissions and format', async () => {
    assert.throws(() => new RustRanker('./relative'));
    assert.throws(() => new RustRanker('/bad\0path'));
    const path = await fixture('not executable');
    await writeFile(path, 'plain text', { mode: 0o600 });
    await assert.rejects(new RustRanker(path).rank(input), unavailable);
    const malformed = await fixture('malformed executable');
    await writeFile(malformed, 'plain text', { mode: 0o700 });
    await assert.rejects(new RustRanker(malformed).rank(input), unavailable);
  });
});

test('Rust process receives only the protocol projection and accepts exact pipe limits', async (t) => {
  const fixture = await fixtures(t);
  const spy = spyOnSpawn(t);
  const tricky = 'a":\\\n:b';
  const rows = [{ ...offer(tricky), tenantId: 'hidden', title: 'hidden' }, offer('b')];
  const expected = { protocol_version: 1, offers: [offer(tricky), offer('b')] };
  const result = JSON.stringify({ ordered_offer_ids: [tricky, 'b'], protocol_version: 1 });
  const path = await fixture('literal path (with spaces);', "let input = ''; process.stdin.setEncoding('utf8');" +
    "process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {" +
    "require('node:assert/strict').deepEqual(JSON.parse(input), " + JSON.stringify(expected) + ');' +
    "process.stderr.write('x'.repeat(4096));" + output(result.padEnd(10240)) + '});');
  assert.deepEqual(await new RustRanker(path).rank(rows), [tricky, 'b']);
  assert.deepEqual(spy.mock.calls[0].arguments, [path, [], { shell: false, env: {}, stdio: ['pipe', 'pipe', 'pipe'] }]);
});

test('candidate contract rejects invalid inputs before calling spawn', async (t) => {
  const spy = spyOnSpawn(t);
  const ranker = new RustRanker('/unused');
  for (const invalid of [
    null, {}, [undefined], new Array(1), [offer('')], [offer('\0')], [offer('\ud800')], [offer('🦀'.repeat(81))],
    [offer('a', 0)], [offer('a', 169)], [offer('a', 1.5)], [offer('a', 1, -1)], [offer('a', 1, 2_147_483_648)],
    [offer('a', 1, Number.NaN)], [{ ...offer('a'), price_cents: '100' }], [offer('a'), offer('a')],
    [...nearMaxRequest, offer('overflow')],
  ]) {
    await assert.rejects(ranker.rank(invalid as RankingCandidate[]), unavailable);
  }
  assert.equal(spy.mock.callCount(), 0);
});

test('timeouts, cancellation, saturation and shutdown terminate and reap local children', { timeout: 5000 }, async (t) => {
  const fixture = await fixtures(t);
  const spy = spyOnSpawn(t);
  const path = await fixture('stall', afterInput(output(response) + 'setInterval(() => {}, 1000);'));
  const ranker = new RustRanker(path);
  const child = () => {
    const process = spy.mock.calls.at(-1)?.result;
    assert.ok(process?.pid);
    return process;
  };
  const start = performance.now();
  const stalled = assert.rejects(ranker.rank(input), unavailable);
  const stalledClosed = once(child(), 'close');
  await stalled;
  assert.deepEqual(await stalledClosed, [null, 'SIGKILL']);
  assert.ok(performance.now() - start >= 475, 'Partial success must wait for process exit or deadline');

  const aborter = new AbortController();
  const reason = new Error('cancelled offline request');
  const first = assert.rejects(ranker.rank(input, aborter.signal), (error) => error === reason);
  const firstClosed = once(child(), 'close');
  const second = assert.rejects(ranker.rank(input), unavailable);
  const secondClosed = once(child(), 'close');
  assert.equal(spy.mock.callCount(), 3);
  await assert.rejects(ranker.rank(input), unavailable);
  aborter.abort(reason);
  await assert.rejects(ranker.rank(input), unavailable, 'Cancelling retains the slot until close.');
  await first;
  assert.deepEqual(await firstClosed, [null, 'SIGKILL']);
  assert.deepEqual(getEventListeners(aborter.signal, 'abort'), []);
  await assert.rejects(ranker.rank(input, aborter.signal), (error) => error === reason);
  assert.equal(spy.mock.callCount(), 3);

  const replacement = assert.rejects(ranker.rank(input), unavailable);
  const replacementClosed = once(child(), 'close');
  await ranker.onModuleDestroy();
  await Promise.all([second, replacement]);
  assert.deepEqual(await secondClosed, [null, 'SIGKILL']);
  assert.deepEqual(await replacementClosed, [null, 'SIGKILL']);
  await assert.rejects(ranker.rank(input), unavailable);
  assert.equal(spy.mock.callCount(), 4);
});

test('release Rust parity, boundary values and measured local overhead', { skip: !binary, timeout: 10000 }, async (t) => {
  const ranker = new RustRanker(binary!);
  assert.deepEqual(await ranker.rank([]), []);
  const unicode = [offer('\ue000'), offer('𐀀'), offer('a'.repeat(80)), offer('🦀'.repeat(80)), offer('lower', 5),
    offer('lowest-price', 6, 0), offer('max-price', 168, 2_147_483_647)];
  assert.deepEqual(await ranker.rank(unicode), ['max-price', 'lowest-price', 'a'.repeat(80), '𐀀', '🦀'.repeat(80), '\ue000', 'lower']);
  for (const offers of [unicode, nearMaxRequest]) {
    const typescript = () => offers.toSorted(compareRankingCandidates).slice(0, 10).map(({ offer_id }) => offer_id);
    const expected = typescript();
    assert.deepEqual(await ranker.rank(offers), expected);
    const ts: number[] = [];
    const rust: number[] = [];
    for (let i = 0; i < 25; i++) {
      let started = performance.now();
      const ids = typescript();
      ts.push(performance.now() - started);
      started = performance.now();
      const ranked = await ranker.rank(offers);
      rust.push(performance.now() - started);
      assert.deepEqual(ranked, ids);
    }
    const median = (samples: number[]) => samples.sort((a, b) => a - b)[12].toFixed(3);
    t.diagnostic(offers.length + ' candidates, 25 serial samples, median milliseconds: TypeScript ' +
      median(ts) + ', Rust adapter ' + median(rust));
  }
});
