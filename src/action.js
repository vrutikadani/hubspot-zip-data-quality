/**
 * HubSpot workflow custom code action (Node 20).
 * One file runs on Contacts, Companies and Deals - it reads the object type from the event.
 *
 * Setup in the workflow action:
 *   Secret:  HUBSPOT_TOKEN  (private app: contacts, companies, deals - read + write)
 *   Outputs: status (string), proposed (string)
 *   Paste src/decide.js above this code (custom code actions are a single file).
 *
 * Rollout: run with DRY_RUN = true first. Nothing is written; "proposed" shows the changes.
 * Review a sample of outputs, then flip DRY_RUN off.
 */
const MODE = process.env.ZIP_MODE || 'ongoing';   // "ongoing" for "ZIP changed" triggers, "backfill" for cleanup
const DRY_RUN = process.env.DRY_RUN !== 'false';
const LOOKUP_URL = process.env.ZIP_LOOKUP_URL;    // a JSON file hosted in your own file manager

const { decide } = require('./decide');

// Field names differ by object - companies use a dropdown state, deals use postal_code.
const FIELDS = {
  CONTACT: { path: 'contacts', zip: 'zip', city: 'city', state: 'state', country: 'country' },
  COMPANY: { path: 'companies', zip: 'zip', city: 'city', state: 'state_region_dropdown', country: 'country' },
  DEAL: { path: 'deals', zip: 'postal_code', city: 'deal_city', state: 'deal_state', country: 'deal_country' },
};

let LOOKUP = null; // cached across executions while the container is warm

async function loadLookup(axios) {
  if (LOOKUP) return LOOKUP;
  const { data } = await axios.get(LOOKUP_URL, { timeout: 8000 });
  // data: { "78701": ["Austin", "TX", ["Rollingwood"]], ... }
  const byZip = {};
  const cityState = new Set();
  const norm = require('./decide').norm;
  for (const [zip, [city, state, alt = []]] of Object.entries(data)) {
    byZip[zip] = { city, state, alt };
    for (const c of [city, ...alt]) cityState.add(`${norm(c)}|${state}`);
  }
  LOOKUP = { byZip, cityState };
  return LOOKUP;
}

exports.main = async (event, callback) => {
  const axios = require('axios');
  const type = (event.object.objectType || 'CONTACT').toUpperCase();
  const f = FIELDS[type];
  const api = axios.create({
    baseURL: 'https://api.hubapi.com/crm/v3/objects/',
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}` },
    timeout: 8000,
  });

  try {
    const props = [f.zip, f.city, f.state, f.country].join(',');
    const { data } = await api.get(`${f.path}/${event.object.objectId}`, { params: { properties: props } });
    const p = data.properties;
    const lookup = await loadLookup(axios);
    const { status, changes } = decide(
      { zip: p[f.zip], city: p[f.city], state: p[f.state], country: p[f.country] }, lookup, MODE);

    const update = {};
    for (const [k, v] of Object.entries(changes)) update[f[k]] = v;
    if (!DRY_RUN && Object.keys(update).length) {
      await api.patch(`${f.path}/${event.object.objectId}`, { properties: update });
    }
    callback({ outputFields: { status: DRY_RUN ? `dry_run:${status}` : status, proposed: JSON.stringify(update) } });
  } catch (err) {
    // 429s are retried by HubSpot when the error is thrown; anything else is reported, never half-written.
    if (err.response && err.response.status === 429) throw err;
    callback({ outputFields: { status: 'error', proposed: String(err.message).slice(0, 200) } });
  }
};
