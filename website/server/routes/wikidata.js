// /api/v1/wikidata/{Q…} — label and description of a Wikidata item, so an editor can check an ID before
// saving it. The server asks Wikidata itself: visitors' browsers never contact a third party.
import { send } from '../http.js';
import { ApiError, rateLimit, requireUser } from '../security.js';

const ID_RE = /^Q[1-9][0-9]{0,11}$/;
const LANGS = ['fr', 'en', 'de', 'es'];
const cache = new Map(); // id -> {at, item}
const TTL = 86400_000;

/** Default fetcher: Wikidata's public API (overridable in tests through ctx.config.wikidataFetch). */
async function fetchFromWikidata(id, config) {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels%7Cdescriptions&languages=${LANGS.join('%7C')}&ids=${id}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': `Panomatix/1.0 (${config.publicUrl})`, Accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
  return res.json();
}

const pick = (map, lang) => map?.[lang]?.value ?? LANGS.map((l) => map?.[l]?.value).find(Boolean) ?? null;

export function registerWikidataRoutes(router) {
  router.add('GET', '/api/v1/wikidata/:id', async (ctx) => {
    const user = requireUser(ctx); // a tool for editors, not a public proxy
    const id = String(ctx.params.id).toUpperCase();
    if (!ID_RE.test(id)) throw new ApiError(400, 'invalid_wikidata', 'A Wikidata ID looks like Q12345.');
    const lang = LANGS.includes(ctx.query.get('lang')) ? ctx.query.get('lang') : 'en';
    let hit = cache.get(id);
    if (!hit || Date.now() - hit.at > TTL) {
      rateLimit(ctx.db, `wikidata:${user.id}`, 120, 3600);
      let body;
      try {
        body = await (ctx.config.wikidataFetch ?? fetchFromWikidata)(id, ctx.config);
      } catch {
        throw new ApiError(502, 'wikidata_unreachable', 'Wikidata cannot be reached right now. You can still save the ID.');
      }
      const entity = body?.entities?.[id];
      hit = { at: Date.now(), entity: entity && !('missing' in entity) ? entity : null };
      cache.set(id, hit);
    }
    if (!hit.entity) throw new ApiError(404, 'wikidata_not_found', 'This item does not exist on Wikidata.');
    send(ctx, 200, {
      id,
      label: pick(hit.entity.labels, lang),
      description: pick(hit.entity.descriptions, lang),
      url: `https://www.wikidata.org/wiki/${id}`,
    });
  });
}
