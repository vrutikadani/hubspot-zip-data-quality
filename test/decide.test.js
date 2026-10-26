// node --test test/decide.test.js
const test = require('node:test');
const assert = require('node:assert');
const { decide, cleanZip, norm } = require('../src/decide');
const raw = require('../data/zip_lookup_sample.json');

const byZip = {};
const cityState = new Set();
for (const [zip, [city, state, alt]] of Object.entries(raw)) {
  byZip[zip] = { city, state, alt };
  for (const c of [city, ...alt]) cityState.add(`${norm(c)}|${state}`);
}
// a few extra real cities so "city exists in this state" checks work
['Plano|TX', 'Orlando|FL', 'Houston|TX'].forEach((cs) => { const [c, s] = cs.split('|'); cityState.add(`${norm(c)}|${s}`); });
const L = { byZip, cityState };

test('cleanZip handles ZIP+4 and lost leading zeros', () => {
  assert.deepEqual(cleanZip('78701-1234').zip, '78701');
  assert.deepEqual(cleanZip('2108'), { zip: '02108', repaired: true, clean: false });
  assert.equal(cleanZip('ABC12'), null);
  assert.equal(cleanZip('00000'), null);
});

test('norm treats Saint and St. the same', () => {
  assert.equal(norm('Saint Louis'), norm('St. Louis'));
});

test('ongoing: the ZIP wins and state follows it', () => {
  const r = decide({ zip: '33131', city: 'Austin', state: 'TX', country: 'US' }, L, 'ongoing');
  assert.deepEqual(r.changes, { state: 'FL', city: 'Miami' });
});

test('ongoing: a real city in the ZIP state is kept', () => {
  const r = decide({ zip: '78701', city: 'Rollingwood', state: 'TX', country: 'US' }, L, 'ongoing');
  assert.equal(r.status, 'ok');
});

test('backfill: ZIP + city outvote a wrong state', () => {
  const r = decide({ zip: '75201', city: 'Dallas', state: 'OK', country: 'United States' }, L, 'backfill');
  assert.equal(r.status, 'fixed_state');
  assert.equal(r.changes.state, 'TX');
});

test('backfill: city + state outvote the ZIP -> no change, flag it', () => {
  const r = decide({ zip: '10001', city: 'Houston', state: 'TX', country: 'US' }, L, 'backfill');
  assert.equal(r.status, 'check_zip');
  assert.deepEqual(r.changes, {});
});

test('backfill: ZIP + state agree, junk city gets fixed, real neighbor city is left', () => {
  assert.equal(decide({ zip: '75201', city: 'Dalas', state: 'TX', country: 'US' }, L, 'backfill').status, 'fixed_city');
  assert.equal(decide({ zip: '75201', city: 'Plano', state: 'TX', country: 'US' }, L, 'backfill').status, 'city_differs');
});

test('blank city and state are filled', () => {
  const r = decide({ zip: '60601', city: '', state: '', country: 'US' }, L, 'backfill');
  assert.deepEqual(r.changes, { city: 'Chicago', state: 'IL' });
});

test('safety: non-US records are never touched', () => {
  assert.equal(decide({ zip: '10001', city: 'Toronto', state: 'ON', country: 'Canada' }, L).status, 'non_us');
});

test('safety: no country and a messy ZIP -> skip', () => {
  assert.equal(decide({ zip: '2108', city: 'Boston', state: 'MA', country: '' }, L).status, 'no_country_unclean_zip');
});

test('junk ZIP with valid city/state is "suspect", otherwise "not found"', () => {
  assert.equal(decide({ zip: '99999', city: 'Orlando', state: 'FL', country: 'US' }, L).status, 'zip_suspect');
  assert.equal(decide({ zip: '99999', city: 'Nowhere', state: 'FL', country: 'US' }, L).status, 'zip_not_found');
});

test('leading zero is repaired and written back', () => {
  const r = decide({ zip: '2108', city: 'Boston', state: 'MA', country: 'US' }, L, 'ongoing');
  assert.equal(r.changes.zip, '02108');
});
