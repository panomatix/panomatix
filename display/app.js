let database = [];
let imagesIndex = {};
let countries = [];

function lookupImage(code) {
  const parts = code.split(':');
  if (parts.length !== 2) return null;
  const key = (parts[0] + '-' + parts[1]).toLowerCase();
  return imagesIndex[key] || null;
}

function codesForCountry(sign, country) {
  const seen = new Map();
  const designs = (sign.officialSign && sign.officialSign.designs) || [];
  designs.forEach((design, designIndex) => {
    const jurisdiction = (design.jurisdictions || {})[country];
    if (!jurisdiction) return;
    for (const lang of Object.values(jurisdiction.languages || {})) {
      const list = lang.codes || (lang.code ? [lang.code] : []);
      for (const code of list) {
        if (!seen.has(code)) seen.set(code, { code, design, designIndex, jurisdiction });
      }
    }
  });
  return [...seen.values()];
}

function signName(sign) {
  const name = sign.name || {};
  return name.en || name.fr || sign.reference;
}

function collectCountries() {
  const set = new Set();
  for (const sign of database) {
    const designs = (sign.officialSign && sign.officialSign.designs) || [];
    for (const design of designs) {
      Object.keys(design.jurisdictions || {}).forEach(c => set.add(c));
    }
  }
  countries = [...set].sort();
}

function populateCategories() {
  const select = document.getElementById('categorySelect');
  const seen = new Map();
  for (const sign of database) {
    if (!seen.has(sign.category)) {
      seen.set(sign.category, sign.categoryName || sign.category);
    }
  }
  const categories = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [code, label] of categories) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = `${code} - ${label}`;
    select.appendChild(option);
  }
}

function render() {
  const category = document.getElementById('categorySelect').value;
  const onePerCell = document.getElementById('onePerCell').checked;
  const signs = database.filter(sign => sign.category === category);
  document.getElementById('count').textContent = `${signs.length} signs`;

  const table = document.getElementById('table');
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const firstTh = document.createElement('th');
  firstTh.textContent = 'Vienna code';
  headRow.appendChild(firstTh);
  for (const country of countries) {
    const th = document.createElement('th');
    th.textContent = country;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const sign of signs) {
    const row = document.createElement('tr');

    const refCell = document.createElement('th');
    refCell.innerHTML = `<div class="ref">${sign.reference}</div><div class="name">${signName(sign)}</div>`;
    row.appendChild(refCell);

    for (const country of countries) {
      const cell = document.createElement('td');
      let entries = codesForCountry(sign, country);
      if (onePerCell && entries.length > 0) {
        const withImage = entries.find(e => lookupImage(e.code));
        entries = [withImage || entries[0]];
      }
      for (const e of entries) {
        const item = document.createElement('div');
        item.className = 'sign';
        const path = lookupImage(e.code);
        if (path) {
          const img = document.createElement('img');
          img.src = path;
          img.alt = e.code;
          item.appendChild(img);
        }
        const label = document.createElement('div');
        label.className = 'code';
        label.textContent = e.code;
        item.appendChild(label);
        item.addEventListener('click', () => showDetails(sign, country, e));
        cell.appendChild(item);
      }
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function kv(container, label, value) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return;
  const row = el('div', null, 'kv');
  row.appendChild(el('span', label, 'k'));
  row.appendChild(el('span', Array.isArray(value) ? value.join(', ') : String(value), 'v'));
  container.appendChild(row);
}

function showDetails(sign, country, entry) {
  const body = document.getElementById('modalBody');
  body.innerHTML = '';
  const { code, design, designIndex, jurisdiction } = entry;

  const head = el('div', null, 'detail-head');
  const path = lookupImage(code);
  if (path) {
    const img = document.createElement('img');
    img.src = path;
    img.alt = code;
    head.appendChild(img);
  }
  const titles = el('div');
  titles.appendChild(el('h2', code));
  titles.appendChild(el('div', `${country} - ${sign.reference}`, 'subtitle'));
  head.appendChild(titles);
  body.appendChild(head);

  body.appendChild(el('h3', 'National sign'));
  const nat = el('div');
  kv(nat, 'Country', `${country} (${jurisdiction.countryCode})`);
  for (const [lang, l] of Object.entries(jurisdiction.languages || {})) {
    kv(nat, `Code (${lang})`, l.code);
    kv(nat, `Codes (${lang})`, l.codes);
    kv(nat, `Text (${lang})`, l.text);
    kv(nat, `Description (${lang})`, l.description);
  }
  kv(nat, 'OSM traffic_sign', jurisdiction.osm && jurisdiction.osm.traffic_sign);
  const bottom = jurisdiction.additional && jurisdiction.additional.bottom;
  if (bottom && bottom.length) {
    kv(nat, 'Additional panels (bottom)', bottom.map(b => `${b.index}: ${(b.reference || []).join('/')}`));
  }
  if (jurisdiction.parameters) {
    for (const [name, p] of Object.entries(jurisdiction.parameters)) {
      kv(nat, `Parameter "${name}"`, `${p.type}${p.unit ? ' (' + p.unit + ')' : ''} - ${p.description || ''} ${p.values ? '[' + p.values.join(', ') + ']' : ''}`);
    }
  }
  body.appendChild(nat);

  body.appendChild(el('h3', `Design #${designIndex}`));
  const des = el('div');
  kv(des, 'Shape', design.shape);
  kv(des, 'Background', design.background_color);
  kv(des, 'Border', design.border_color);
  kv(des, 'Symbol', design.symbol_color);
  kv(des, 'Band', design.band !== 'none' ? `${design.band}${design.band_color ? ' (' + design.band_color + ')' : ''}` : null);
  kv(des, 'Prohibition bar', design.prohibition_bar);
  kv(des, 'Bar continuity', design.bar_continuity);
  kv(des, 'Model', design.model);
  kv(des, 'Legacy model', design.legacyModel);
  kv(des, 'Versions', design.versions);
  kv(des, 'Legacy references', design.legacyReferences);
  kv(des, 'Mirrored', design.mirrored ? 'yes' : null);
  kv(des, 'Wikidata', design.wikidata);
  body.appendChild(des);

  body.appendChild(el('h3', 'Vienna sign'));
  const vie = el('div');
  kv(vie, 'Reference', sign.reference);
  kv(vie, 'Category', `${sign.category} - ${sign.categoryName || ''}`);
  kv(vie, 'Legacy references', sign.legacyReferences);
  for (const [lang, n] of Object.entries(sign.name || {})) kv(vie, `Name (${lang})`, n);
  for (const [lang, d] of Object.entries(sign.description || {})) kv(vie, `Description (${lang})`, d);
  kv(vie, 'Symbol may be reversed', sign.symbolMayBeReversed ? 'yes' : null);
  kv(vie, 'Wikidata', sign.wikidata);
  if (sign.osm) {
    kv(vie, 'OSM generic', sign.osm.traffic_sign_generic);
    if (sign.osm.implied_tags) {
      kv(vie, 'OSM implied tags', Object.entries(sign.osm.implied_tags).map(([k, v]) => `${k}=${v}`));
    }
  }
  if (sign.relatedSigns && sign.relatedSigns.length) {
    kv(vie, 'Related signs', sign.relatedSigns.map(r => r.reference));
  }
  body.appendChild(vie);

  const details = el('details');
  details.appendChild(el('summary', 'Raw JSON'));
  details.appendChild(el('pre', JSON.stringify({ sign: { ...sign, officialSign: undefined }, design, jurisdiction }, null, 2)));
  body.appendChild(details);

  document.getElementById('modal').hidden = false;
}

function closeModal() {
  document.getElementById('modal').hidden = true;
}

async function init() {
  const [dbRes, idxRes] = await Promise.all([
    fetch('../full_database.json'),
    fetch('images_index.json'),
  ]);
  database = await dbRes.json();
  imagesIndex = await idxRes.json();

  collectCountries();
  populateCategories();
  render();

  document.getElementById('categorySelect').addEventListener('change', render);
  document.getElementById('onePerCell').addEventListener('change', render);
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

init();
