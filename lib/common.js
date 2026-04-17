/**
 * lib/common.js – shared helpers for the Agro World Order Intake workflow.
 *
 * DROP-IN n8n CODE NODE BODY.
 *
 * Paste the whole file into a Code node with:
 *   - Mode: "Run Once for All Items"
 *   - Language: JavaScript
 *
 * It exposes everything on a single `$common` object at the end and returns
 * it. Downstream Code nodes can access helpers via `$('Common Helpers').first().json.lib`
 * or by re-pasting the file at the top of any Code node (helpers are pure).
 *
 * No external modules are required – n8n Code nodes sandbox these away.
 */

/* ------------------------------------------------------------------ */
/*  String + field normalization                                       */
/* ------------------------------------------------------------------ */

function safeString(v, fallback = '') {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return String(v).trim(); } catch { return fallback; }
}

function squish(s) {
  return safeString(s).replace(/[\u00A0\s]+/g, ' ').trim();
}

function upper(s) { return squish(s).toUpperCase(); }
function lower(s) { return squish(s).toLowerCase(); }

function stripDiacritics(s) {
  return safeString(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/* ------------------------------------------------------------------ */
/*  Email parsing – original sender on forwarded mails                 */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

function extractEmail(str) {
  const m = safeString(str).match(EMAIL_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * On Outlook forwards the useful sender is in the body, not in `from`.
 * Look for "From: <email>" / "Van: <email>" / "Von: <email>" and use that
 * when the outer sender is one of our own domains.
 */
function originalSender(mail) {
  const OWN = /@(agroworld\.|agro-world\.|agro\.world)/i;
  const outer = extractEmail(mail.from?.emailAddress?.address || mail.from || '');
  const body = safeString(mail.body?.content || mail.bodyPreview || '');
  const forwardMatch =
    body.match(/^\s*(?:From|Van|Von|De)\s*:\s*[^<\n]*<?\s*([^\s<>]+@[^\s<>]+)/im) ||
    body.match(/-{2,}\s*Original Message\s*-{2,}[\s\S]*?(?:From|Van|Von)\s*:\s*[^<\n]*<?\s*([^\s<>]+@[^\s<>]+)/im) ||
    body.match(/-{2,}\s*Oorspronkelijk bericht\s*-{2,}[\s\S]*?Van\s*:\s*[^<\n]*<?\s*([^\s<>]+@[^\s<>]+)/im);
  const forwarded = forwardMatch ? forwardMatch[1].toLowerCase().replace(/[>]+$/, '') : null;
  if (forwarded && outer && OWN.test(outer)) return forwarded;
  return outer || forwarded || null;
}

function domainOf(addr) {
  const a = extractEmail(addr);
  return a ? a.split('@')[1] : null;
}

/* ------------------------------------------------------------------ */
/*  Customer detection                                                 */
/* ------------------------------------------------------------------ */

/**
 * Canonical customer key by sender domain / subject keywords.
 * Order matters: first hit wins.
 */
const CUSTOMER_RULES = [
  { key: 'HPT',           match: /(^|@)(hpt\.dk|therkelsen\.dk|therkelsen\.com)$/i },
  { key: 'TONNIES',       match: /(tonnies|weidemark|tevex)\./i },
  { key: 'EKRO',          match: /@ekro\./i },
  { key: 'COOMANS',       match: /(@coomans\.|@ctimport\.)/i },
  { key: 'TULLING',       match: /@tulling\./i },
  { key: 'FN_GLOBAL',     match: /fn[-_ ]?global|@fnglobalmeat\./i },
  { key: 'CARNIMEX',      match: /@carnimex\./i },
  { key: 'AMECO',         match: /@ameco\./i },
  { key: 'GOEDEGEBUUR',   match: /@goedegebuur\./i },
  { key: 'THERMOTRAFFIC', match: /@thermotraffic\./i },
  { key: 'WETRALOG',      match: /@wetralog\./i },
];

function detectCustomer(mail) {
  const sender = originalSender(mail) || '';
  const subject = safeString(mail.subject);
  for (const r of CUSTOMER_RULES) {
    if (r.match.test(sender) || r.match.test(subject)) return r.key;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Numeric parsing                                                    */
/* ------------------------------------------------------------------ */

/**
 * parseQty('24 PAL') → { quantity: 24, packaging: 'PAL' }
 * parseQty('24x')   → { quantity: 24, packaging: null }
 * parseQty(24)      → { quantity: 24, packaging: null }
 */
function parseQty(raw) {
  if (raw === null || raw === undefined || raw === '') return { quantity: null, packaging: null };
  if (typeof raw === 'number') return { quantity: Math.trunc(raw), packaging: null };
  const s = squish(raw).replace(',', '.');
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[xX×]?\s*([A-Za-z]{2,})?/);
  if (!m) return { quantity: null, packaging: null };
  return {
    quantity: Math.round(parseFloat(m[1])),
    packaging: m[2] ? m[2].toUpperCase() : null,
  };
}

/**
 * parseWeight('1.234,56 kg') → 1234.56
 * parseWeight('500g')        → 0.5
 * parseWeight('1 t')         → 1000
 * parseWeight(1234)          → 1234
 */
function parseWeight(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw;
  const s = squish(raw).toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^([\d.,]+)(kg|g|t|ton|kgs|kilo|kilogram|gram)?$/);
  if (!m) return null;
  const rawNum = m[1].includes(',') && !m[1].includes('.')
    ? m[1].replace(',', '.')
    : m[1].replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const n = parseFloat(rawNum);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'g': case 'gram':                return Math.round(n) / 1000;
    case 't': case 'ton':                 return n * 1000;
    default:                              return n; // kg / null → kg
  }
}

function parseTemperature(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw;
  const s = squish(raw).toLowerCase().replace('°c', '').replace(',', '.');
  const m = s.match(/(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/* ------------------------------------------------------------------ */
/*  Date parsing – tolerant of EU / US / ISO / mixed formats           */
/* ------------------------------------------------------------------ */

function parseDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString();
  const s = squish(raw);
  // ISO first
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const [_, Y, M, D, h = '00', m = '00', sec = '00'] = iso;
    return new Date(Date.UTC(+Y, +M - 1, +D, +h, +m, +sec)).toISOString();
  }
  // EU: dd-mm-yyyy / dd/mm/yyyy / dd.mm.yyyy
  const eu = s.match(/^(\d{1,2})[-./ ](\d{1,2})[-./ ](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (eu) {
    let [_, D, M, Y, h = '00', m = '00'] = eu;
    if (Y.length === 2) Y = (+Y > 50 ? '19' : '20') + Y;
    return new Date(Date.UTC(+Y, +M - 1, +D, +h, +m)).toISOString();
  }
  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

/* ------------------------------------------------------------------ */
/*  Address normalization                                              */
/* ------------------------------------------------------------------ */

function buildAddress(parts) {
  const p = (s) => squish(s);
  const line1 = [p(parts.name), p(parts.street)].filter(Boolean).join(', ');
  const line2 = [p(parts.postalCode), p(parts.city)].filter(Boolean).join(' ');
  const line3 = p(parts.country);
  return [line1, line2, line3].filter(Boolean).join(', ');
}

function addressToStop(addr, extras = {}) {
  if (!addr) return null;
  if (typeof addr === 'string') {
    return {
      location: { raw_address: squish(addr) },
      note: extras.note || null,
      instructions: extras.instructions || null,
    };
  }
  return {
    location: {
      name: squish(addr.name) || null,
      street: squish(addr.street) || null,
      postal_code: squish(addr.postalCode || addr.postal_code) || null,
      city: squish(addr.city) || null,
      country: squish(addr.country) || null,
      raw_address: addr.raw_address || buildAddress(addr),
    },
    note: extras.note || null,
    instructions: extras.instructions || null,
  };
}

const AGROWORLD_EMSTEK = {
  name: 'Agro World Emstek',
  street: 'Industriestrasse 21',
  postalCode: '49685',
  city: 'Emstek',
  country: 'DE',
};

/* ------------------------------------------------------------------ */
/*  Qargo payload envelope + schema validation                         */
/* ------------------------------------------------------------------ */

const QARGO_PAYLOAD_VERSION = 'v1';

function buildQargoPayload({ customer, order_identifier, customer_reference_number,
                             pickup_stop, delivery_stop, goods, metadata }) {
  return {
    version: QARGO_PAYLOAD_VERSION,
    customer: customer || null,
    order_identifier: safeString(order_identifier) || null,
    customer_reference_number: safeString(customer_reference_number) || null,
    pickup_stop:   pickup_stop   || null,
    delivery_stop: delivery_stop || null,
    goods:         goods         || [],
    metadata:      metadata      || {},
  };
}

/** Lightweight schema validation. Returns { ok, errors: string[] }. */
function validatePayload(p) {
  const e = [];
  if (!p || typeof p !== 'object')                  e.push('payload not an object');
  if (!p?.order_identifier)                         e.push('order_identifier missing');
  if (!p?.customer)                                 e.push('customer missing');
  if (!p?.pickup_stop?.location)                    e.push('pickup_stop.location missing');
  if (!p?.delivery_stop?.location)                  e.push('delivery_stop.location missing');
  if (!Array.isArray(p?.goods) || p.goods.length===0) e.push('goods array empty');
  (p?.goods || []).forEach((g, i) => {
    if (!g || typeof g !== 'object')                e.push(`goods[${i}] not object`);
    if (g && g.total_weight_kg != null && !(g.total_weight_kg > 0))
                                                    e.push(`goods[${i}].total_weight_kg invalid`);
  });
  return { ok: e.length === 0, errors: e };
}

/* ------------------------------------------------------------------ */
/*  Retry wrapper (use from IF/Wait combos – included for parity)      */
/* ------------------------------------------------------------------ */

/**
 * Tiny helper that the calling Code node can use to annotate an item with
 * an attempt counter. The actual HTTP retry is done by an n8n "Wait" +
 * conditional loop (see PATCHES.md).
 */
function bumpAttempt(item, max = 3) {
  const attempt = (item.attempt || 0) + 1;
  return { attempt, give_up: attempt >= max };
}

/* ------------------------------------------------------------------ */
/*  Export                                                              */
/* ------------------------------------------------------------------ */

const $common = {
  safeString, squish, upper, lower, stripDiacritics,
  extractEmail, originalSender, domainOf,
  detectCustomer, CUSTOMER_RULES,
  parseQty, parseWeight, parseTemperature, parseDate,
  buildAddress, addressToStop, AGROWORLD_EMSTEK,
  buildQargoPayload, validatePayload, QARGO_PAYLOAD_VERSION,
  bumpAttempt,
};

// When used as a standalone "helpers" Code node:
return [{ json: { lib: $common } }];
