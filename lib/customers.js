/**
 * lib/customers.js – deterministic customer mappers.
 *
 * DROP-IN n8n CODE NODE BODY.
 *   Place this as the body of the "Customer Router" node in the V8 workflow.
 *   Mode: "Run Once for All Items"
 *
 * Input per item (from Aggregate Attachment Context + Load Memory):
 *   item.json.mail               – normalized Outlook message
 *   item.json.context            – aggregate attachment text / structured blocks
 *   item.json.attachments        – [{ filename, mime, text, xml_json, xlsx_rows }]
 *   item.json.customer_key       – optional override from Load Memory
 *
 * Output:
 *   { customer, qargo_payload, parser, confidence }  when a deterministic mapper matched
 *   { customer: null, needs_ai: true, reason }       when no mapper matched – caller falls through to AI Agent
 *
 * Each mapper returns an array of Qargo payload objects (one per order block)
 * or `null` to signal "I cannot handle this input, pass to next mapper / AI".
 *
 * Adding a new customer:
 *   1. Append a rule to CUSTOMER_RULES in lib/common.js (domain / subject regex).
 *   2. Add a mapper function below with key === CUSTOMER_RULES key.
 *   3. Register it in MAPPERS at the bottom.
 */

/* ================== inline helpers (subset of common.js) =============== */

function safeString(v, f='') { if (v==null) return f; try { return String(v).trim(); } catch { return f; } }
function squish(s)  { return safeString(s).replace(/[\u00A0\s]+/g, ' ').trim(); }
function upper(s)   { return squish(s).toUpperCase(); }
function lower(s)   { return squish(s).toLowerCase(); }
function extractEmail(str) { const m = safeString(str).match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i); return m ? m[1].toLowerCase() : null; }
function domainOf(addr) { const a = extractEmail(addr); return a ? a.split('@')[1] : null; }

function parseQty(raw) {
  if (raw == null || raw === '') return { quantity: null, packaging: null };
  if (typeof raw === 'number') return { quantity: Math.trunc(raw), packaging: null };
  const s = squish(raw).replace(',', '.');
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[xX×]?\s*([A-Za-z]{2,})?/);
  if (!m) return { quantity: null, packaging: null };
  return { quantity: Math.round(parseFloat(m[1])), packaging: m[2] ? m[2].toUpperCase() : null };
}
function parseWeight(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw;
  const s = squish(raw).toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^([\d.,]+)(kg|g|t|ton)?$/); if (!m) return null;
  const num = m[1].includes(',') && !m[1].includes('.')
    ? parseFloat(m[1].replace(',','.'))
    : parseFloat(m[1].replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',','.'));
  if (!Number.isFinite(num)) return null;
  switch (m[2]) { case 'g': return num/1000; case 't': case 'ton': return num*1000; default: return num; }
}
function parseTemperature(raw) {
  if (raw == null || raw === '') return null;
  const m = squish(raw).toLowerCase().replace('°c','').replace(',','.').match(/(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
function parseDate(raw) {
  if (!raw) return null;
  const s = squish(raw);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) { const [_,Y,M,D,h='00',m='00',se='00']=iso; return new Date(Date.UTC(+Y,+M-1,+D,+h,+m,+se)).toISOString(); }
  const eu = s.match(/^(\d{1,2})[-./ ](\d{1,2})[-./ ](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (eu) { let [_,D,M,Y,h='00',m='00']=eu; if (Y.length===2) Y=(+Y>50?'19':'20')+Y; return new Date(Date.UTC(+Y,+M-1,+D,+h,+m)).toISOString(); }
  const f = new Date(s); return Number.isNaN(f.getTime())?null:f.toISOString();
}
function labelValue(text, label) {
  const re = new RegExp(`${label}\\s*[:#]?\\s*([^\\n]+)`, 'i');
  const m  = safeString(text).match(re); return m ? squish(m[1]) : null;
}
function between(text, startRe, endRe) {
  const s = safeString(text);
  const m = s.match(new RegExp(`${startRe.source}([\\s\\S]*?)${endRe.source}`, startRe.flags.replace('g','')));
  return m ? squish(m[1]) : null;
}

function addrFromBlock(block) {
  const lines = safeString(block).split('\n').map(squish).filter(Boolean);
  if (!lines.length) return null;
  const [name, street = '', last = ''] = lines;
  const pc = last.match(/(\d{4,6})\s+(.+)/);
  return {
    name, street,
    postalCode: pc ? pc[1] : null,
    city: pc ? squish(pc[2]) : squish(last),
    country: null,
    raw_address: lines.join(', '),
  };
}

function stopFromAddr(a, extras = {}) {
  if (!a) return null;
  return {
    location: {
      name: a.name || null, street: a.street || null,
      postal_code: a.postalCode || null, city: a.city || null, country: a.country || null,
      raw_address: a.raw_address || [a.name, a.street, a.postalCode, a.city, a.country].filter(Boolean).join(', '),
    },
    note:         extras.note || null,
    instructions: extras.instructions || null,
  };
}

/* ================== TÖNNIES / WEIDEMARK / TEVEX ======================== */
/* XML format. Root <TransportOrder> with nested <Loading>/<Unloading>.   */
function mapTonnies({ attachments }) {
  const xml = attachments.find((a) => /\.xml$/i.test(a.filename) && a.xml_json);
  if (!xml) return null;
  const root = xml.xml_json?.TransportOrder || xml.xml_json?.transportorder || xml.xml_json;
  if (!root) return null;
  const orders = Array.isArray(root.Order) ? root.Order : [root.Order || root];
  return orders.filter(Boolean).map((o) => {
    const loading   = o.Loading  || o.LoadingStop  || o.Pickup   || {};
    const unloading = o.Unloading|| o.UnloadingStop|| o.Delivery || {};
    const goods     = []
      .concat(o.Goods?.Item || o.Goods || [])
      .filter(Boolean)
      .map((g) => ({
        type: squish(g.Type || 'colli').toLowerCase(),
        quantity: parseInt(g.Quantity || g.Pallets || 0, 10) || null,
        packaging: squish(g.Packaging || 'PAL') || null,
        total_weight_kg: parseWeight(g.Weight || g.GrossWeight),
        temperature_c: parseTemperature(g.Temperature),
      }));
    return {
      customer: 'TONNIES',
      order_identifier: squish(o.OrderNumber || o.OrderNo || o.Id),
      customer_reference_number: squish(o.CustomerReference || o.Reference || o.OrderNumber),
      pickup_stop:   stopFromAddr(addrFromBlock([
        loading.Name, loading.Street, [loading.PostalCode, loading.City].filter(Boolean).join(' '), loading.Country
      ].filter(Boolean).join('\n'))),
      delivery_stop: stopFromAddr(addrFromBlock([
        unloading.Name, unloading.Street, [unloading.PostalCode, unloading.City].filter(Boolean).join(' '), unloading.Country
      ].filter(Boolean).join('\n'))),
      goods: goods.length ? goods : [{ type: 'colli', quantity: null, packaging: null, total_weight_kg: null, temperature_c: null }],
      metadata: {
        source: 'tonnies-xml-parser',
        pickup_date: parseDate(loading.Date || loading.LoadingDate),
        delivery_date: parseDate(unloading.Date || unloading.UnloadingDate),
      },
    };
  });
}

/* ================== EKRO ============================================== */
/* XLSX layout. Each row = one order. */
function mapEkro({ attachments }) {
  const xlsx = attachments.find((a) => /\.xlsx?$/i.test(a.filename) && Array.isArray(a.xlsx_rows));
  if (!xlsx) return null;
  const rows = xlsx.xlsx_rows.filter((r) => r && (r.OrderNumber || r.OrderNo || r.Order));
  if (!rows.length) return null;
  return rows.map((r) => ({
    customer: 'EKRO',
    order_identifier: squish(r.OrderNumber || r.OrderNo || r.Order),
    customer_reference_number: squish(r.CustomerRef || r.Reference || r.PO || r.OrderNumber),
    pickup_stop: stopFromAddr(addrFromBlock([r.PickupName, r.PickupStreet, [r.PickupPostal, r.PickupCity].filter(Boolean).join(' '), r.PickupCountry].filter(Boolean).join('\n'))),
    delivery_stop: stopFromAddr(addrFromBlock([r.DeliveryName, r.DeliveryStreet, [r.DeliveryPostal, r.DeliveryCity].filter(Boolean).join(' '), r.DeliveryCountry].filter(Boolean).join('\n'))),
    goods: [{
      type: squish(r.GoodsType || 'colli').toLowerCase(),
      quantity: parseInt(r.Pallets || r.Quantity || 0, 10) || null,
      packaging: squish(r.Packaging || 'PAL'),
      total_weight_kg: parseWeight(r.Weight || r.GrossWeight),
      temperature_c: parseTemperature(r.Temperature),
    }],
    metadata: {
      source: 'ekro-xlsx-parser',
      pickup_date: parseDate(r.PickupDate || r.LoadingDate),
      delivery_date: parseDate(r.DeliveryDate || r.UnloadingDate),
    },
  }));
}

/* ================== COOMANS / CTIMPORT ================================ */
/* Mail body text + occasional PDF. Look for "Order:" / "PO:". */
function mapCoomans({ context }) {
  const text = safeString(context?.text || context);
  const order = labelValue(text, 'Order(?:\\s*no)?') || labelValue(text, 'PO');
  if (!order) return null;
  const pickupBlock   = between(text, /Loading\s*(?:address)?\s*:?\s*\n/i, /(?:Delivery|Unloading|Items?|Pallet|Weight)/i);
  const deliveryBlock = between(text, /(?:Delivery|Unloading)\s*(?:address)?\s*:?\s*\n/i, /(?:Items?|Pallet|Weight|$)/i);
  return [{
    customer: 'COOMANS',
    order_identifier: order,
    customer_reference_number: labelValue(text, 'Ref') || order,
    pickup_stop:   stopFromAddr(addrFromBlock(pickupBlock)),
    delivery_stop: stopFromAddr(addrFromBlock(deliveryBlock)),
    goods: [{
      type: 'colli',
      quantity: parseInt(labelValue(text, 'Pallets?') || '0', 10) || null,
      packaging: 'PAL',
      total_weight_kg: parseWeight(labelValue(text, 'Weight') || labelValue(text, 'Gross')),
      temperature_c: parseTemperature(labelValue(text, 'Temperature')),
    }],
    metadata: {
      source: 'coomans-text-parser',
      pickup_date: parseDate(labelValue(text, 'Loading\\s*date')),
      delivery_date: parseDate(labelValue(text, 'Delivery\\s*date')),
    },
  }];
}

/* ================== TULLING =========================================== */
/* XML stream with <Shipment> roots. */
function mapTulling({ attachments }) {
  const xml = attachments.find((a) => /\.xml$/i.test(a.filename) && a.xml_json);
  if (!xml) return null;
  const root = xml.xml_json?.Shipments || xml.xml_json;
  const shipments = []
    .concat(root.Shipment || root)
    .filter(Boolean);
  if (!shipments.length) return null;
  return shipments.map((s) => ({
    customer: 'TULLING',
    order_identifier: squish(s.ShipmentNumber || s.Id),
    customer_reference_number: squish(s.CustomerReference || s.Reference || s.ShipmentNumber),
    pickup_stop: stopFromAddr(addrFromBlock([s.ShipperName, s.ShipperStreet, [s.ShipperZip, s.ShipperCity].filter(Boolean).join(' '), s.ShipperCountry].filter(Boolean).join('\n'))),
    delivery_stop: stopFromAddr(addrFromBlock([s.ConsigneeName, s.ConsigneeStreet, [s.ConsigneeZip, s.ConsigneeCity].filter(Boolean).join(' '), s.ConsigneeCountry].filter(Boolean).join('\n'))),
    goods: [{
      type: 'colli',
      quantity: parseInt(s.Pallets || 0, 10) || null,
      packaging: squish(s.Packaging || 'PAL'),
      total_weight_kg: parseWeight(s.Weight),
      temperature_c: parseTemperature(s.Temperature),
    }],
    metadata: { source: 'tulling-xml-parser', pickup_date: parseDate(s.LoadingDate), delivery_date: parseDate(s.DeliveryDate) },
  }));
}

/* ================== FN GLOBAL MEAT ==================================== */
/* PDF text with tabular "Order#  Qty  Weight  Temp  Loading  Delivery". */
function mapFnGlobal({ attachments, context }) {
  const pdf = attachments.find((a) => /\.pdf$/i.test(a.filename) && a.text);
  const text = safeString(pdf?.text || context?.text || context);
  if (!/FN\s*Global/i.test(text) && !/fnglobalmeat/i.test(text)) return null;
  const lines = text.split('\n').map(squish).filter(Boolean);
  const orderLineRe = /^(\d{5,})\s+(\d+)\s+([\d.,]+)\s+(-?\d+(?:[.,]\d+)?)?\s*C?\s+(.+?)\s{2,}(.+)$/;
  const orders = [];
  for (const line of lines) {
    const m = line.match(orderLineRe);
    if (!m) continue;
    orders.push({
      customer: 'FN_GLOBAL',
      order_identifier: m[1],
      customer_reference_number: m[1],
      pickup_stop:   stopFromAddr(addrFromBlock(m[5])),
      delivery_stop: stopFromAddr(addrFromBlock(m[6])),
      goods: [{
        type: 'colli',
        quantity: parseInt(m[2], 10),
        packaging: 'PAL',
        total_weight_kg: parseWeight(m[3]),
        temperature_c: parseTemperature(m[4]),
      }],
      metadata: { source: 'fn-global-pdf-parser' },
    });
  }
  return orders.length ? orders : null;
}

/* ================== CARNIMEX ========================================== */
function mapCarnimex({ attachments, context }) {
  const pdf = attachments.find((a) => /\.pdf$/i.test(a.filename) && a.text);
  const text = safeString(pdf?.text || context?.text || context);
  const order = labelValue(text, 'Order\\s*number') || labelValue(text, 'Auftrag');
  if (!order) return null;
  return [{
    customer: 'CARNIMEX',
    order_identifier: order,
    customer_reference_number: labelValue(text, 'Reference') || order,
    pickup_stop:   stopFromAddr(addrFromBlock(between(text, /Loading\s*:?\s*\n/i, /(?:Delivery|Unloading)/i))),
    delivery_stop: stopFromAddr(addrFromBlock(between(text, /(?:Delivery|Unloading)\s*:?\s*\n/i, /(?:Items?|Pallets|Weight|$)/i))),
    goods: [{
      type: 'colli',
      quantity: parseInt(labelValue(text, 'Pallets?') || '0', 10) || null,
      packaging: 'PAL',
      total_weight_kg: parseWeight(labelValue(text, 'Weight') || labelValue(text, 'Gewicht')),
      temperature_c: parseTemperature(labelValue(text, 'Temperature') || labelValue(text, 'Temperatur')),
    }],
    metadata: { source: 'carnimex-pdf-parser' },
  }];
}

/* ================== AMECO ============================================= */
function mapAmeco({ attachments, context }) {
  const text = safeString(attachments.find(a => a.text)?.text || context?.text || context);
  const order = labelValue(text, 'Order') || labelValue(text, 'PO');
  if (!order) return null;
  return [{
    customer: 'AMECO',
    order_identifier: order,
    customer_reference_number: labelValue(text, 'Ref') || order,
    pickup_stop:   stopFromAddr(addrFromBlock(between(text, /Pick\s*up\s*:?\s*\n/i, /(?:Drop|Delivery|Items?)/i))),
    delivery_stop: stopFromAddr(addrFromBlock(between(text, /(?:Drop|Delivery)\s*:?\s*\n/i, /(?:Items?|Pallets|$)/i))),
    goods: [{
      type: 'colli',
      quantity: parseInt(labelValue(text, 'Pallets?') || '0', 10) || null,
      packaging: 'PAL',
      total_weight_kg: parseWeight(labelValue(text, 'Weight')),
      temperature_c: parseTemperature(labelValue(text, 'Temperature')),
    }],
    metadata: { source: 'ameco-parser' },
  }];
}

/* ================== GOEDEGEBUUR ======================================= */
function mapGoedegebuur(ctx) { return mapAmeco(ctx)?.map(o => ({ ...o, customer: 'GOEDEGEBUUR', metadata: { ...o.metadata, source: 'goedegebuur-parser' } })); }

/* ================== THERMOTRAFFIC ===================================== */
function mapThermotraffic(ctx) { return mapAmeco(ctx)?.map(o => ({ ...o, customer: 'THERMOTRAFFIC', metadata: { ...o.metadata, source: 'thermotraffic-parser' } })); }

/* ================== WETRALOG ========================================== */
function mapWetralog(ctx) {
  const out = mapAmeco(ctx); if (!out) return null;
  return out.map(o => ({ ...o, customer: 'WETRALOG', metadata: { ...o.metadata, source: 'wetralog-parser' } }));
}

/* ================== Router ============================================ */

const MAPPERS = {
  TONNIES:       mapTonnies,
  EKRO:          mapEkro,
  COOMANS:       mapCoomans,
  TULLING:       mapTulling,
  FN_GLOBAL:     mapFnGlobal,
  CARNIMEX:      mapCarnimex,
  AMECO:         mapAmeco,
  GOEDEGEBUUR:   mapGoedegebuur,
  THERMOTRAFFIC: mapThermotraffic,
  WETRALOG:      mapWetralog,
  // HPT is handled by lib/hpt.js – pre-router PDF branch.
};

function detectCustomer(mail) {
  const sender = extractEmail(mail?.from?.emailAddress?.address || mail?.from || '') || '';
  const subject = safeString(mail?.subject);
  const rules = [
    ['HPT',           /(^|@)(hpt\.dk|therkelsen\.)/i],
    ['TONNIES',       /(tonnies|weidemark|tevex)\./i],
    ['EKRO',          /@ekro\./i],
    ['COOMANS',       /(@coomans\.|@ctimport\.)/i],
    ['TULLING',       /@tulling\./i],
    ['FN_GLOBAL',     /fn[-_ ]?global|@fnglobalmeat\./i],
    ['CARNIMEX',      /@carnimex\./i],
    ['AMECO',         /@ameco\./i],
    ['GOEDEGEBUUR',   /@goedegebuur\./i],
    ['THERMOTRAFFIC', /@thermotraffic\./i],
    ['WETRALOG',      /@wetralog\./i],
  ];
  for (const [key, re] of rules) if (re.test(sender) || re.test(subject)) return key;
  return null;
}

/* ================== n8n entry ========================================= */

const out = [];
for (const item of $input.all()) {
  const mail        = item.json.mail || {};
  const attachments = item.json.attachments || [];
  const context     = item.json.context      || {};
  const override    = item.json.customer_key || null;
  const customerKey = override || detectCustomer(mail);

  if (!customerKey) {
    out.push({ json: { ...item.json, needs_ai: true, reason: 'no_customer_rule_matched' } });
    continue;
  }

  const mapper = MAPPERS[customerKey];
  if (!mapper) {
    // HPT has its own node; any non-mapped key still falls to AI.
    out.push({ json: { ...item.json, customer: customerKey, needs_ai: true, reason: 'no_deterministic_mapper' } });
    continue;
  }

  let orders = null;
  try { orders = mapper({ mail, attachments, context }); }
  catch (e) {
    out.push({ json: { ...item.json, customer: customerKey, needs_ai: true, reason: `mapper_error: ${e.message}` } });
    continue;
  }

  if (!orders || !orders.length) {
    out.push({ json: { ...item.json, customer: customerKey, needs_ai: true, reason: 'mapper_no_match' } });
    continue;
  }

  for (const o of orders) {
    out.push({
      json: {
        ...item.json,
        customer: customerKey,
        qargo_payload: o,
        parser: `lib/customers.js:${customerKey}`,
        needs_ai: false,
      },
    });
  }
}
return out;
