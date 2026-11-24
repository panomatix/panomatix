// Validation of sign entries.
// 1. Structure: a small JSON Schema (2020-12 subset) interpreter driven by sign.schema.json,
//    which is the single source of truth for every field (also served at /api/v1/meta/schema).
// 2. Semantics: cross-field rules a schema cannot express.
import fs from 'node:fs';
import path from 'node:path';
import { WEBSITE_DIR } from './config.js';

export const SCHEMA = JSON.parse(fs.readFileSync(path.join(WEBSITE_DIR, 'sign.schema.json'), 'utf8'));
export const PANEL_POSITIONS = ['top', 'bottom', 'left', 'right'];
export const CATEGORY_NAMES = {
  A: 'Danger warning signs',
  B: 'Priority signs',
  C: 'Prohibitory and restrictive signs',
  D: 'Mandatory signs',
  E: 'Special regulation signs',
  F: 'Information, facilities or service signs',
  G: 'Other information signs (2006: Direction, position or indication signs)',
  H: 'Additional panels',
  S: 'Road numbers',
  SD: 'Unclassified',
};

const MAX_ERRORS = 100;
const regexCache = new Map();
const re = (p) => {
  if (!regexCache.has(p)) regexCache.set(p, new RegExp(p, 'u'));
  return regexCache.get(p);
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string, boolean, object
}
const typeMatches = (t, actual) => t === actual || (t === 'number' && actual === 'integer');

function resolve(ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node[key], SCHEMA);
}

const fmt = (p) => p.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : `${s}.${k}`), '$');

function check(schema, value, p, errors) {
  if (errors.length >= MAX_ERRORS) return;
  if (schema.$ref) {
    check(resolve(schema.$ref), value, p, errors);
    // sibling keywords next to $ref (other than annotations) are applied too
  }
  const push = (message) => errors.length < MAX_ERRORS && errors.push({ path: fmt(p), message });
  const actual = typeOf(value);

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, actual))) return push(`must be ${types.join(' or ')}`);
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    return push(`must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (actual === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) push(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) push(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !re(schema.pattern).test(value)) push(`does not match the expected format (${schema.pattern})`);
  }
  if (actual === 'integer' || actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) push(`must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) push(`must be ≤ ${schema.maximum}`);
  }
  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) push(`must contain at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) push(`must contain at most ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const seen = new Set();
      value.forEach((v, i) => {
        const k = JSON.stringify(v);
        if (seen.has(k)) push(`item ${i} is a duplicate`);
        seen.add(k);
      });
    }
    if (schema.items) value.forEach((v, i) => check(schema.items, v, [...p, i], errors));
  }
  if (actual === 'object') {
    const keys = Object.keys(value);
    for (const r of schema.required ?? []) if (!(r in value)) push(`missing required property "${r}"`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) push(`must have at least ${schema.minProperties} entr${schema.minProperties > 1 ? 'ies' : 'y'}`);
    const props = schema.properties ?? {};
    for (const k of keys) {
      if (schema.propertyNames) {
        const before = errors.length;
        check(schema.propertyNames, k, [...p, k], errors);
        if (errors.length > before) errors[errors.length - 1].message = `key "${k}" ${errors[errors.length - 1].message}`;
      }
      if (k in props) check(props[k], value[k], [...p, k], errors);
      else if (schema.additionalProperties === false) push(`unknown property "${k}"`);
      else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, value[k], [...p, k], errors);
    }
  }
}

function* additionals(entry) {
  const official = entry.officialSign ?? {};
  if (official.additional && typeof official.additional === 'object') yield ['$.officialSign.additional', official.additional];
  for (const [di, design] of (official.designs ?? []).entries()) {
    for (const [jk, jur] of Object.entries(design?.jurisdictions ?? {})) {
      if (jur?.additional && typeof jur.additional === 'object') yield [`$.officialSign.designs[${di}].jurisdictions.${jk}.additional`, jur.additional];
    }
  }
  for (const [ri, rel] of (entry.relatedSigns ?? []).entries()) {
    for (const [jk, jur] of Object.entries(rel?.jurisdictions ?? {})) {
      if (jur?.additional && typeof jur.additional === 'object') yield [`$.relatedSigns[${ri}].jurisdictions.${jk}.additional`, jur.additional];
    }
  }
}

function* jurisdictions(entry) {
  for (const [di, design] of (entry.officialSign?.designs ?? []).entries()) {
    for (const [jk, jur] of Object.entries(design?.jurisdictions ?? {})) yield [`$.officialSign.designs[${di}].jurisdictions.${jk}`, jur];
  }
  for (const [ri, rel] of (entry.relatedSigns ?? []).entries()) {
    for (const [jk, jur] of Object.entries(rel?.jurisdictions ?? {})) yield [`$.relatedSigns[${ri}].jurisdictions.${jk}`, jur];
  }
}

export function semanticErrors(entry) {
  const errors = [];
  const [prefix, number = ''] = entry.reference.split(/:(.*)/s);
  const cat = entry.category;
  if (prefix === 'VIENNA' && !(/^[A-H]$/.test(cat) && number.startsWith(cat))) {
    errors.push({ path: '$.category', message: `a VIENNA entry needs the category A–H matching its number (got "${cat}" for "${entry.reference}")` });
  } else if (prefix === 'OTHER' && !cat.startsWith('OTHER-')) {
    errors.push({ path: '$.category', message: 'an OTHER entry needs an OTHER-* category' });
  } else if (prefix === 'VIENNA2006' && !(/^[A-H]$/.test(cat) && number.startsWith(cat))) {
    errors.push({ path: '$.category', message: `a VIENNA2006 entry needs the category A–H matching its number (got "${cat}" for "${entry.reference}")` });
  }
  for (const [p, add] of additionals(entry)) {
    for (const pos of PANEL_POSITIONS) {
      const idx = (add[pos] ?? []).map((s) => s.index);
      if (new Set(idx).size !== idx.length) errors.push({ path: `${p}.${pos}`, message: 'two panel slots share the same index' });
    }
  }
  for (const [p, jur] of jurisdictions(entry)) {
    for (const [lk, lang] of Object.entries(jur.languages ?? {})) {
      if (!(lang.codes ?? []).includes(lang.code)) errors.push({ path: `${p}.languages.${lk}.code`, message: '`code` must also appear in `codes`' });
    }
    for (const [pk, param] of Object.entries(jur.parameters ?? {})) {
      const want = param.type === 'number' ? 'number' : 'string';
      (param.values ?? []).forEach((v, i) => {
        if (typeof v !== want) errors.push({ path: `${p}.parameters.${pk}.values[${i}]`, message: `must be a ${want}` });
      });
    }
  }
  return errors;
}

/** Returns a list of {path, message}; an empty list means the entry is valid. */
export function validateEntry(entry) {
  if (typeOf(entry) !== 'object') return [{ path: '$', message: 'an entry must be a JSON object' }];
  const errors = [];
  check(SCHEMA, entry, [], errors);
  return errors.length ? errors : semanticErrors(entry).slice(0, MAX_ERRORS);
}

/** Every panel container exposes `top` and `bottom` (empty slots can then be filled);
 *  `left` / `right` are kept only when used. Key order: top, bottom, left, right. */
export function normalizeEntry(entry) {
  if (typeOf(entry) !== 'object') return entry;
  for (const [, add] of [...additionals(entry)]) {
    const ordered = { top: add.top ?? [], bottom: add.bottom ?? [] };
    for (const pos of ['left', 'right']) if (add[pos]?.length) ordered[pos] = add[pos];
    for (const k of Object.keys(add)) delete add[k];
    Object.assign(add, ordered);
  }
  return entry;
}

export function vocabularies() {
  const d = SCHEMA.$defs;
  const design = d.design.properties;
  return {
    shape: d.shape.enum,
    color: d.color.enum,
    band: design.band.enum,
    prohibition_bar: design.prohibition_bar.enum,
    bar_continuity: design.bar_continuity.enum,
    model: design.model.enum,
    legacyModel: design.legacyModel.enum,
    versions: design.versions.items.enum,
    parameterType: d.parameter.properties.type.enum,
    panelPositions: PANEL_POSITIONS,
    categoryNames: CATEGORY_NAMES,
  };
}
