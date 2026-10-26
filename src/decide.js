/**
 * Pure decision logic: given a record's ZIP, city, state and country, decide what to fix.
 * No network, no HubSpot - so every rule is unit-tested.
 *
 * Two modes:
 *   "ongoing"  - a person just typed the ZIP, so the ZIP wins. State follows the ZIP.
 *                City is replaced unless it is a real city in the ZIP's state.
 *   "backfill" - fixing old records where any of the three could be the wrong one.
 *                Majority vote: whichever two of (ZIP, city, state) agree win.
 *                If nothing agrees, change nothing and flag it for a human.
 *
 * Safety rules (both modes):
 *   - Non-US country: never touched.
 *   - No country: only acted on when the ZIP is already a clean 5-digit ZIP.
 *   - Junk ZIPs are skipped ("zip_not_found", or "zip_suspect" when city + state look valid).
 *   - Flagged records get no writes at all.
 */

const US = new Set(['', 'us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america']);

function norm(city) {
  return String(city || '')
    .toLowerCase()
    .replace(/[.'`’-]/g, ' ')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bfort\b/g, 'ft')
    .replace(/\bmount\b/g, 'mt')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clean a raw ZIP. Recovers ZIPs that lost a leading zero in a spreadsheet (e.g. 2108 -> 02108). */
function cleanZip(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || !/^[\d\s-]+$/.test(s)) return null;
  let d = s.replace(/\D/g, '');
  let repaired = false;
  if (d.length === 9) d = d.slice(0, 5);                         // ZIP+4
  else if (d.length === 8) { d = ('0' + d).slice(0, 5); repaired = true; }
  else if (d.length === 4) { d = '0' + d; repaired = true; }
  if (d.length !== 5 || d === '00000') return null;
  return { zip: d, repaired, clean: !repaired && /^\d{5}(-\d{4})?$/.test(s) };
}

/**
 * @param {{zip, city, state, country}} rec
 * @param {{byZip: Object<string,{city:string,state:string,alt?:string[]}>, cityState: Set<string>}} lookup
 * @param {"ongoing"|"backfill"} mode
 * @returns {{status: string, changes: Object<string,string>}}
 */
function decide(rec, lookup, mode = 'ongoing') {
  const none = (status) => ({ status, changes: {} });
  const country = norm(rec.country);
  if (!US.has(country)) return none('non_us');

  const z = cleanZip(rec.zip);
  if (!country && !(z && z.clean)) return none('no_country_unclean_zip');

  const city = String(rec.city || '').trim();
  const state = String(rec.state || '').trim().toUpperCase();
  const cityOk = city && lookup.cityState.has(`${norm(city)}|${state}`);

  if (!z) return none(cityOk ? 'zip_suspect' : 'zip_not_found');
  const info = lookup.byZip[z.zip];
  if (!info) return none(cityOk ? 'zip_suspect' : 'zip_not_found');

  const changes = {};
  if (z.zip !== String(rec.zip).trim()) changes.zip = z.zip;
  const zipCities = [info.city, ...(info.alt || [])].map(norm);
  const cityMatchesZip = city && zipCities.includes(norm(city));
  const cityRealInZipState = city && lookup.cityState.has(`${norm(city)}|${info.state}`);
  const stateMatchesZip = state === info.state;

  if (mode === 'ongoing') {
    if (!stateMatchesZip) changes.state = info.state;
    if (!city || !(cityMatchesZip || cityRealInZipState)) changes.city = info.city;
    return { status: Object.keys(changes).length ? 'fixed' : 'ok', changes };
  }

  // ---- backfill: majority vote between ZIP, city and state
  if (!city && !state) return { status: 'filled_blank', changes: { ...changes, city: info.city, state: info.state } };
  if (!state && cityMatchesZip) return { status: 'filled_blank', changes: { ...changes, state: info.state } };
  if (!city && stateMatchesZip) return { status: 'filled_blank', changes: { ...changes, city: info.city } };

  if (cityMatchesZip && stateMatchesZip) return { status: Object.keys(changes).length ? 'fixed' : 'ok', changes };
  if (cityMatchesZip && !stateMatchesZip) {                       // ZIP + city outvote state
    return { status: 'fixed_state', changes: { ...changes, state: info.state } };
  }
  if (stateMatchesZip && !cityMatchesZip) {                       // ZIP + state agree
    if (cityRealInZipState) return { status: 'city_differs', changes: {} }; // a real nearby city: leave it
    return { status: 'fixed_city', changes: { ...changes, city: info.city } };
  }
  if (cityOk) return none('check_zip');                           // city + state outvote the ZIP
  return none('state_differs');                                   // nothing agrees
}

module.exports = { decide, cleanZip, norm };
