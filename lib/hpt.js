/**
 * lib/hpt.js – H.P. Therkelsen (hpt.dk) PDF-text-to-Qargo parser.
 *
 * DROP-IN n8n CODE NODE BODY.
 *   - Place after the "Extract PDF" node in the V8 workflow
 *     (or after the corresponding PDF extraction in the Customer Router branch).
 *   - Mode: "Run Once for All Items"
 *   - The input item must carry `json.pdf_text` (the extracted text of the PDF)
 *     and `json.mail` (the normalized Outlook item).
 *
 * === BUSINESS RULE (DO NOT REMOVE) ================================
 *
 * When the PDF contains the sentence
 *   "Please deliver it to your Emstek warehouse and we will load it Friday evening"
 *   (or a close variant – matched case-insensitive and with flexible whitespace),
 *
 * the real Qargo delivery location is NOT the one in the order block.
 * The real delivery is AGRO WORLD EMSTEK. The original delivery address
 * and the Emstek instruction both go into delivery_stop.note so the
 * planner and driver see the full picture.
 *
 * If the sentence is absent, we use the block's own delivery address.
 *
 * If the PDF contains "DO NOT EXCHANGE PALLETS" (any case) we append
 * that to both delivery_stop.instructions and delivery_stop.note.
 *
 * Per order block in the PDF → exactly one Qargo order.
 *
 * ==================================================================
 */

/*  -------- inline helpers (copy of lib/common.js subset; keeps this
            node self-contained so it can run even if common.js is not
            wired through the flow) ---------------------------------- */

function safeString(v, f = '') {
  if (v === null || v === undefined) return f;
  try { return String(v).trim(); } catch { return f; }
}
function squish(s) { return safeString(s).replace(/[\u00A0\s]+/g, ' ').trim(); }

function parseWeight(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw;
  const s = squish(raw).toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^([\d.,]+)(kg|g|t|ton)?$/);
  if (!m) return null;
  const num = m[1].includes(',') && !m[1].includes('.')
    ? parseFloat(m[1].replace(',', '.'))
    : parseFloat(m[1].replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.'));
  if (!Number.isFinite(num)) return null;
  switch (m[2]) {
    case 'g':  return num / 1000;
    case 't': case 'ton': return num * 1000;
    default:   return num;
  }
}
function parseTemperature(raw) {
  if (raw == null || raw === '') return null;
  const m = squish(raw).toLowerCase().replace('°c', '').replace(',', '.').match(/(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
function parseQty(raw) {
  if (raw == null || raw === '') return { quantity: null, packaging: null };
  if (typeof raw === 'number') return { quantity: Math.trunc(raw), packaging: null };
  const s = squish(raw).replace(',', '.');
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[xX×]?\s*([A-Za-z]{2,})?/);
  if (!m) return { quantity: null, packaging: null };
  return { quantity: Math.round(parseFloat(m[1])), packaging: m[2] ? m[2].toUpperCase() : null };
}

const AGROWORLD_EMSTEK = {
  name: 'Agro World Emstek',
  street: 'Industriestrasse 21',
  postalCode: '49685',
  city: 'Emstek',
  country: 'DE',
};

/*  -------- Regexes for the HPT template ---------------------------- */

const EMSTEK_INSTRUCTION_RE =
  /please\s+deliver\s+it\s+to\s+your\s+emstek\s+warehouse[^.\n]*(?:load\s+it[^.\n]*evening)?/i;

const DONT_EXCHANGE_RE = /do\s*not\s*exchange\s*pallets?/i;

/**
 * Split the PDF into order blocks. HPT repeats a header line containing
 * "Orderno" for each order.
 */
function splitBlocks(text) {
  const lines = safeString(text).split(/\r?\n/);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*Orderno\s*[:#]/i.test(line) && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks.filter((b) => /Orderno/i.test(b));
}

function extractLabel(block, label) {
  const re = new RegExp(`${label}\\s*[:#]?\\s*(.+)`, 'i');
  const m = block.match(re);
  return m ? squish(m[1].split('\n')[0]) : null;
}

/**
 * Very tolerant address-block extractor. Looks for "Loading" / "Delivery"
 * headers and grabs the lines up to the next label or an empty line.
 */
function extractAddressBlock(block, heading) {
  const re = new RegExp(
    `${heading}\\s*(?:address)?\\s*[:\\n]([\\s\\S]*?)(?=\\n\\s*(?:Loading|Delivery|Items?|Pall|Grosswgt|Temperature|Orderno|$))`,
    'i',
  );
  const m = block.match(re);
  if (!m) return null;
  const lines = m[1].split('\n').map((l) => squish(l)).filter(Boolean);
  if (lines.length === 0) return null;
  const [name, street = '', last = ''] = lines;
  const postalCity = last.match(/(\d{4,6})\s+(.+)/);
  return {
    name,
    street,
    postalCode: postalCity ? postalCity[1] : null,
    city: postalCity ? squish(postalCity[2]) : squish(last),
    country: /denmark|dk/i.test(block) ? 'DK' : null,
    raw_address: lines.join(', '),
  };
}

/** Parse a single HPT order block into a Qargo order object. */
function parseHptBlock(block) {
  const orderNo = extractLabel(block, 'Orderno');
  const customerRef = extractLabel(block, 'Customer\\s*ref(?:erence)?') ||
                      extractLabel(block, 'Your\\s*ref(?:erence)?')   ||
                      orderNo;
  const pickupAddr   = extractAddressBlock(block, 'Loading');
  const deliveryAddr = extractAddressBlock(block, 'Delivery');
  const itemsRaw = extractLabel(block, 'Items?\\s*/?\\s*type');
  const pallRaw  = extractLabel(block, 'Pall(?:et)?s?\\s*/?\\s*type');
  const weightRaw = extractLabel(block, 'Grosswgt') ||
                    extractLabel(block, 'Gross\\s*weight');
  const tempRaw  = extractLabel(block, 'Temperature');

  const emstek   = EMSTEK_INSTRUCTION_RE.test(block);
  const noSwap   = DONT_EXCHANGE_RE.test(block);

  const qty = parseQty(pallRaw);

  const deliveryNoteParts = [];
  if (deliveryAddr) deliveryNoteParts.push(`Original delivery address: ${deliveryAddr.raw_address}`);
  const emstekSentence = block.match(EMSTEK_INSTRUCTION_RE);
  if (emstekSentence) deliveryNoteParts.push(`HPT instruction: ${squish(emstekSentence[0])}`);
  if (noSwap) deliveryNoteParts.push('DO NOT EXCHANGE PALLETS');

  const delivery_stop = emstek
    ? {
        location: {
          name:        AGROWORLD_EMSTEK.name,
          street:      AGROWORLD_EMSTEK.street,
          postal_code: AGROWORLD_EMSTEK.postalCode,
          city:        AGROWORLD_EMSTEK.city,
          country:     AGROWORLD_EMSTEK.country,
          raw_address: `${AGROWORLD_EMSTEK.name}, ${AGROWORLD_EMSTEK.street}, ${AGROWORLD_EMSTEK.postalCode} ${AGROWORLD_EMSTEK.city}, ${AGROWORLD_EMSTEK.country}`,
        },
        note:         deliveryNoteParts.filter(Boolean).join(' | ') || null,
        instructions: noSwap ? 'DO NOT EXCHANGE PALLETS' : null,
      }
    : {
        location: deliveryAddr ? {
          name:        deliveryAddr.name || null,
          street:      deliveryAddr.street || null,
          postal_code: deliveryAddr.postalCode || null,
          city:        deliveryAddr.city || null,
          country:     deliveryAddr.country || null,
          raw_address: deliveryAddr.raw_address,
        } : null,
        note:         noSwap ? 'DO NOT EXCHANGE PALLETS' : null,
        instructions: noSwap ? 'DO NOT EXCHANGE PALLETS' : null,
      };

  return {
    customer: 'HPT',
    order_identifier: orderNo,
    customer_reference_number: customerRef,
    pickup_stop: pickupAddr ? {
      location: {
        name:        pickupAddr.name || null,
        street:      pickupAddr.street || null,
        postal_code: pickupAddr.postalCode || null,
        city:        pickupAddr.city || null,
        country:     pickupAddr.country || null,
        raw_address: pickupAddr.raw_address,
      },
      note: null,
      instructions: null,
    } : null,
    delivery_stop,
    goods: [{
      type: /colli/i.test(itemsRaw || '') ? 'colli' : (itemsRaw ? squish(itemsRaw).toLowerCase() : 'colli'),
      quantity: qty.quantity,
      packaging: qty.packaging,
      total_weight_kg: parseWeight(weightRaw),
      temperature_c: parseTemperature(tempRaw),
    }],
    metadata: {
      source: 'hpt-pdf-parser',
      emstek_rerouted: emstek,
      no_exchange_pallets: noSwap,
      raw_block: block,
    },
  };
}

/** Top-level parser: PDF text → array of Qargo orders. */
function parseHpt(pdfText) {
  const blocks = splitBlocks(pdfText);
  return blocks.map(parseHptBlock).filter((o) => o.order_identifier);
}

/* ------------------------------------------------------------------ */
/*  n8n Code node entry                                                */
/* ------------------------------------------------------------------ */

const out = [];
for (const item of $input.all()) {
  const pdfText = item.json.pdf_text || item.json.text || item.json.extracted_text || '';
  if (!pdfText) {
    out.push({ json: { ...item.json, hpt_error: 'pdf_text missing on input item' } });
    continue;
  }
  const orders = parseHpt(pdfText);
  if (orders.length === 0) {
    out.push({ json: { ...item.json, hpt_error: 'no order blocks detected' } });
    continue;
  }
  for (const order of orders) {
    out.push({
      json: {
        ...item.json,
        qargo_payload: order,
        customer: 'HPT',
        parser: 'lib/hpt.js',
      },
    });
  }
}

return out;

/* ------------------------------------------------------------------ */
/*  Self-test assertions – kept at the bottom so a developer running   */
/*  `node lib/hpt.js` against a sample PDF text can sanity-check.      */
/*  The return above means n8n never reaches these lines.              */
/* ------------------------------------------------------------------ */

/* istanbul ignore next */
if (typeof require !== 'undefined' && require.main === module) {
  const sample = `
  Orderno: 54321
  Customer ref: PO-9988
  Loading address:
  SlagterA/S
  Hovedvej 12
  8000 Aarhus
  Delivery address:
  Fleischhandel GmbH
  Musterstr 1
  20095 Hamburg
  Please deliver it to your Emstek warehouse and we will load it Friday evening.
  DO NOT EXCHANGE PALLETS
  Items/type: colli
  Pall/Type: 33 PAL
  Grosswgt: 24.500 kg
  Temperature: -2 C
  `;
  const orders = parseHpt(sample);
  console.assert(orders.length === 1, 'expected one order');
  const o = orders[0];
  console.assert(o.order_identifier === '54321', 'order_identifier');
  console.assert(o.delivery_stop.location.city === 'Emstek', 'Emstek reroute must apply');
  console.assert(/Fleischhandel/.test(o.delivery_stop.note), 'original delivery kept in note');
  console.assert(o.metadata.no_exchange_pallets === true, 'no-exchange flag');
  console.assert(o.goods[0].total_weight_kg === 24500, 'weight parse');
  console.assert(o.goods[0].temperature_c === -2, 'temperature parse');
  console.log('HPT parser self-test OK');
}
