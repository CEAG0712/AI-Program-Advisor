import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { CourseOffer } from '../src/catalog/catalog.types.js';
import { CatalogRepository, CATALOG_SQL, MAX_RECOMMENDATION_CANDIDATES } from '../src/catalog/catalog.repository.js';
import { recommend, REASONS, validateRecommendationRequest as validate } from '../src/recommendations/recommendations.policy.js';

const maria = { budget_cents: 30000, weekly_hours: 6, known_skills: ['basic-python'] };
const offer = (overrides: Partial<CourseOffer> = {}): CourseOffer => ({ offer_id: 'a', title: 'Synthetic',
  price_cents: 24000, currency: 'USD', required_skills: ['basic-python'], weekly_study_hours: 6, ...overrides });
const result = (overrides = {}, row = offer()) => recommend([row], validate({ ...maria, ...overrides })).recommendations;

test('valid Maria request copies facts and fixed reasons', () => {
  assert.deepEqual(validate(maria), maria);
  assert.deepEqual(result(), [{ ...offer(), reasons: [...REASONS] }]);
});
for (const [name, input, count] of [
  ['zero budget', { budget_cents: 0 }, 0], ['exact price', { budget_cents: 24000 }, 1],
  ['below price', { budget_cents: 23999 }, 0], ['exact hours', { weekly_hours: 6 }, 1],
  ['below hours', { weekly_hours: 5 }, 0], ['prerequisite present', { known_skills: ['basic-python'] }, 1],
  ['prerequisite absent', { known_skills: ['basic-sql'] }, 0], ['empty declared skills', { known_skills: [] }, 0],
  ['related skill is not prerequisite', { known_skills: ['python'] }, 0],
] as const) test(name, () => assert.equal(result(input).length, count));

test('no prerequisites passes; non-USD cannot be compared with USD budget', () => {
  assert.equal(result({ known_skills: [] }, offer({ required_skills: [] })).length, 1);
  assert.equal(result({}, offer({ currency: 'EUR' })).length, 0);
});

test('missing known_skills and non-object inputs fail closed', () => {
  for (const body of [undefined, null, [], '', 1, true, { budget_cents: 30000, weekly_hours: 6 }]) {
    assert.throws(() => validate(body), BadRequestException);
  }
});
for (const key of ['budget_cents', 'weekly_hours'] as const) {
  test(`invalid ${key}: type, fraction, bounds and non-finite numbers`, () => {
    const invalid = [undefined, null, '6', true, {}, [], -1, 1.1, NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER + 1, key === 'budget_cents' ? 100000001 : 169];
    if (key === 'weekly_hours') invalid.push(0);
    for (const value of invalid) assert.throws(() => validate({ ...maria, [key]: value }), BadRequestException);
  });
}
test('numeric upper bounds accepted', () => {
  assert.equal(validate({ ...maria, budget_cents: 100000000, weekly_hours: 168 }).weekly_hours, 168);
});
test('unknown keys and supplied authority rejected', () => {
  for (const key of ['tenant_id', 'academy_id', 'checkout_authorized', 'eligibility_override', 'model', '__proto__']) {
    assert.throws(() => validate({ ...maria, [key]: 'untrusted' }), BadRequestException);
  }
});
test('skill identifiers, lengths, count, types and duplicates', () => {
  for (const known_skills of [null, {}, 'basic-python', [null], [''], [{}], [[]], ['Basic-python'],
    ['basic_python'], ['-python'], ['python-'], ['basic--python'], [' basic-python'], ['basic-python\n'], ['basic-python\r'], new Array(1), ['a'.repeat(65)],
    ['basic-python', 'basic-python'], Array.from({ length: 33 }, (_, i) => `skill-${i}`)]) {
    assert.throws(() => validate({ ...maria, known_skills }), BadRequestException);
  }
  assert.equal(validate({ ...maria, known_skills: ['a'.repeat(64)] }).known_skills.length, 1);
  assert.equal(validate({ ...maria, known_skills: Array.from({ length: 32 }, (_, i) => `skill-${i}`) }).known_skills.length, 32);
});
test('ranking: hours descending, price ascending, then code-unit offer ID ascending', () => {
  const rows = [offer({ offer_id: 'z', weekly_study_hours: 4, price_cents: 1 }),
    offer({ offer_id: 'c', price_cents: 23000 }), offer({ offer_id: 'b', price_cents: 22000 }),
    offer({ offer_id: 'a', price_cents: 22000 })];
  for (const input of [rows, [...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
    assert.deepEqual(recommend(input, validate(maria)).recommendations.map((r) => r.offer_id), ['a', 'b', 'c', 'z']);
  }
});
test('empty eligible set and maximum ten after filtering/ranking', () => {
  assert.deepEqual(recommend([], validate(maria)), { recommendations: [] });
  const rows = Array.from({ length: 15 }, (_, i) => offer({ offer_id: `id-${String(i).padStart(2, '0')}` })).reverse();
  assert.deepEqual(recommend(rows, validate(maria)).recommendations.map((r) => r.offer_id),
    Array.from({ length: 10 }, (_, i) => `id-${String(i).padStart(2, '0')}`));
});
test('input arrays, rows and skill lists are not mutated or shared with response', () => {
  const rows = [offer({ offer_id: 'z' }), offer({ offer_id: 'a' })];
  const before = structuredClone(rows);
  for (const row of rows) { Object.freeze(row.required_skills); Object.freeze(row); }
  Object.freeze(rows);
  const request = validate(maria);
  const response = recommend(rows, request);
  response.recommendations[0].required_skills.push('extra');
  response.recommendations[0].reasons.push('extra');
  assert.deepEqual(rows, before);
  assert.deepEqual(maria.known_skills, ['basic-python']);
  assert.deepEqual(request.known_skills, maria.known_skills);
  assert.equal(REASONS.length, 3);
});
test('bounded candidate SQL binds trusted tenant and sentinel limit; overflow/failure gives 503', async () => {
  for (const size of [0, MAX_RECOMMENDATION_CANDIDATES, MAX_RECOMMENDATION_CANDIDATES + 1, -1]) {
    const pool = { query: async (sql: string, values: unknown[]) => {
      assert.equal(sql, `${CATALOG_SQL} LIMIT $2`);
      assert.deepEqual(values, ['academy-a', 1001]);
      if (size === -1) throw new Error('private dependency details');
      return { rows: Array.from({ length: size }, () => offer()) };
    } } as unknown as Pool;
    const call = () => new CatalogRepository(pool).recommendationCandidates({ tenantId: 'academy-a' });
    if (size === -1 || size > 1000) await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.deepEqual(error.getResponse(), { statusCode: 503, message: 'Catalog temporarily unavailable.', error: 'Service Unavailable' });
      return true;
    });
    else assert.equal((await call()).length, size);
  }
});
