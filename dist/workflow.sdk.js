import {
  workflow, node, trigger, ifElse, switchCase, merge, sticky,
  languageModel, newCredential, expr
} from '@n8n/workflow-sdk';

const NORMALIZE_EMAIL_JS = "function safeString(v, f=\u0027\u0027) { if (v==null) return f; try { return String(v).trim(); } catch { return f; } }\nfunction squish(s) { return safeString(s).replace(/[\\u00A0\\s]+/g, \u0027 \u0027).trim(); }\nfunction extractEmail(s) { const m = safeString(s).match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,})/i); return m ? m[1].toLowerCase() : null; }\nfunction originalSender(mail) {\n  const OWN = /@(agroworld\\.|agro-world\\.|agro\\.world)/i;\n  const outer = extractEmail(mail.from?.emailAddress?.address || mail.from || \u0027\u0027);\n  const body  = safeString(mail.body?.content || mail.bodyPreview || \u0027\u0027);\n  const fwd = body.match(/^\\s*(?:From|Van|Von|De)\\s*:\\s*[^\u003c\\n]*\u003c?\\s*([^\\s\u003c\u003e]+@[^\\s\u003c\u003e]+)/im)\n           || body.match(/-{2,}\\s*Original Message\\s*-{2,}[\\s\\S]*?(?:From|Van|Von)\\s*:\\s*[^\u003c\\n]*\u003c?\\s*([^\\s\u003c\u003e]+@[^\\s\u003c\u003e]+)/im)\n           || body.match(/-{2,}\\s*Oorspronkelijk bericht\\s*-{2,}[\\s\\S]*?Van\\s*:\\s*[^\u003c\\n]*\u003c?\\s*([^\\s\u003c\u003e]+@[^\\s\u003c\u003e]+)/im);\n  const forwarded = fwd ? fwd[1].toLowerCase().replace(/[\u003e]+$/, \u0027\u0027) : null;\n  if (forwarded \u0026\u0026 outer \u0026\u0026 OWN.test(outer)) return forwarded;\n  return outer || forwarded || null;\n}\nconst out = [];\nfor (const item of $input.all()) {\n  const m = item.json;\n  const orig = originalSender(m);\n  out.push({\n    json: {\n      mail: {\n        id:                  m.id || null,\n        internetMessageId:   m.internetMessageId || m.messageId || m.id || null,\n        subject:             squish(m.subject),\n        receivedDateTime:    m.receivedDateTime || m.receivedAt || null,\n        from: {\n          displayName: squish(m.from?.emailAddress?.name),\n          address:     (m.from?.emailAddress?.address || \u0027\u0027).toLowerCase() || null,\n        },\n        originalSender: orig,\n        body: {\n          content:     safeString(m.body?.content),\n          contentType: m.body?.contentType || \u0027text\u0027,\n        },\n        bodyPreview:         squish(m.bodyPreview),\n        hasAttachments:      !!m.hasAttachments,\n        parentFolderId:      m.parentFolderId || null,\n        conversationId:      m.conversationId || null,\n        categories:          Array.isArray(m.categories) ? m.categories : [],\n      },\n      raw: m,\n    },\n  });\n}\nreturn out;";
const DEDUPE_JS          = "const out = [];\nfor (const item of $input.all()) {\n  const mail = item.json.mail || item.json;\n  const id   = mail.internetMessageId\n            || mail.messageId\n            || mail.id\n            || null;\n  const hits = item.json.processed_hits || [];\n  const hit  = id \u0026\u0026 hits.find((h) =\u003e h.internetMessageId === id || h.message_id === id);\n  out.push({\n    json: {\n      ...item.json,\n      already_processed: !!hit,\n      skip_reason: hit ? `Mail ${id} already processed at ${hit.processed_at || \u0027unknown\u0027}` : null,\n      mail_id_for_dedupe: id,\n    },\n  });\n}\nreturn out;";
const HPT_JS             = "function safeString(v, f = \u0027\u0027) {\n  if (v === null || v === undefined) return f;\n  try { return String(v).trim(); } catch { return f; }\n}\nfunction squish(s) { return safeString(s).replace(/[\\u00A0\\s]+/g, \u0027 \u0027).trim(); }\nfunction parseWeight(raw) {\n  if (raw == null || raw === \u0027\u0027) return null;\n  if (typeof raw === \u0027number\u0027) return raw;\n  const s = squish(raw).toLowerCase().replace(/\\s+/g, \u0027\u0027);\n  const m = s.match(/^([\\d.,]+)(kg|g|t|ton)?$/);\n  if (!m) return null;\n  const num = m[1].includes(\u0027,\u0027) \u0026\u0026 !m[1].includes(\u0027.\u0027)\n    ? parseFloat(m[1].replace(\u0027,\u0027, \u0027.\u0027))\n    : parseFloat(m[1].replace(/\\.(?=\\d{3}(?:\\D|$))/g, \u0027\u0027).replace(\u0027,\u0027, \u0027.\u0027));\n  if (!Number.isFinite(num)) return null;\n  switch (m[2]) {\n    case \u0027g\u0027:  return num / 1000;\n    case \u0027t\u0027: case \u0027ton\u0027: return num * 1000;\n    default:   return num;\n  }\n}\nfunction parseTemperature(raw) {\n  if (raw == null || raw === \u0027\u0027) return null;\n  const m = squish(raw).toLowerCase().replace(\u0027°c\u0027, \u0027\u0027).replace(\u0027,\u0027, \u0027.\u0027).match(/(-?\\d+(?:\\.\\d+)?)/);\n  return m ? parseFloat(m[1]) : null;\n}\nfunction parseQty(raw) {\n  if (raw == null || raw === \u0027\u0027) return { quantity: null, packaging: null };\n  if (typeof raw === \u0027number\u0027) return { quantity: Math.trunc(raw), packaging: null };\n  const s = squish(raw).replace(\u0027,\u0027, \u0027.\u0027);\n  const m = s.match(/^(\\d+(?:\\.\\d+)?)\\s*[xX×]?\\s*([A-Za-z]{2,})?/);\n  if (!m) return { quantity: null, packaging: null };\n  return { quantity: Math.round(parseFloat(m[1])), packaging: m[2] ? m[2].toUpperCase() : null };\n}\nconst AGROWORLD_EMSTEK = {\n  name: \u0027Agro World Emstek\u0027,\n  street: \u0027Industriestrasse 21\u0027,\n  postalCode: \u002749685\u0027,\n  city: \u0027Emstek\u0027,\n  country: \u0027DE\u0027,\n};\nconst EMSTEK_INSTRUCTION_RE =\n  /please\\s+deliver\\s+it\\s+to\\s+your\\s+emstek\\s+warehouse[^.\\n]*(?:load\\s+it[^.\\n]*evening)?/i;\nconst DONT_EXCHANGE_RE = /do\\s*not\\s*exchange\\s*pallets?/i;\nfunction splitBlocks(text) {\n  const lines = safeString(text).split(/\\r?\\n/);\n  const blocks = [];\n  let current = [];\n  for (const line of lines) {\n    if (/^\\s*Orderno\\s*[:#]/i.test(line) \u0026\u0026 current.length \u003e 0) {\n      blocks.push(current.join(\u0027\\n\u0027));\n      current = [];\n    }\n    current.push(line);\n  }\n  if (current.length) blocks.push(current.join(\u0027\\n\u0027));\n  return blocks.filter((b) =\u003e /Orderno/i.test(b));\n}\nfunction extractLabel(block, label) {\n  const re = new RegExp(`${label}\\\\s*[:#]?\\\\s*(.+)`, \u0027i\u0027);\n  const m = block.match(re);\n  return m ? squish(m[1].split(\u0027\\n\u0027)[0]) : null;\n}\nfunction extractAddressBlock(block, heading) {\n  const re = new RegExp(\n    `${heading}\\\\s*(?:address)?\\\\s*[:\\\\n]([\\\\s\\\\S]*?)(?=\\\\n\\\\s*(?:Loading|Delivery|Items?|Pall|Grosswgt|Temperature|Orderno|$))`,\n    \u0027i\u0027,\n  );\n  const m = block.match(re);\n  if (!m) return null;\n  const lines = m[1].split(\u0027\\n\u0027).map((l) =\u003e squish(l)).filter(Boolean);\n  if (lines.length === 0) return null;\n  const [name, street = \u0027\u0027, last = \u0027\u0027] = lines;\n  const postalCity = last.match(/(\\d{4,6})\\s+(.+)/);\n  return {\n    name,\n    street,\n    postalCode: postalCity ? postalCity[1] : null,\n    city: postalCity ? squish(postalCity[2]) : squish(last),\n    country: /denmark|dk/i.test(block) ? \u0027DK\u0027 : null,\n    raw_address: lines.join(\u0027, \u0027),\n  };\n}\nfunction parseHptBlock(block) {\n  const orderNo = extractLabel(block, \u0027Orderno\u0027);\n  const customerRef = extractLabel(block, \u0027Customer\\\\s*ref(?:erence)?\u0027) ||\n                      extractLabel(block, \u0027Your\\\\s*ref(?:erence)?\u0027)   ||\n                      orderNo;\n  const pickupAddr   = extractAddressBlock(block, \u0027Loading\u0027);\n  const deliveryAddr = extractAddressBlock(block, \u0027Delivery\u0027);\n  const itemsRaw = extractLabel(block, \u0027Items?\\\\s*/?\\\\s*type\u0027);\n  const pallRaw  = extractLabel(block, \u0027Pall(?:et)?s?\\\\s*/?\\\\s*type\u0027);\n  const weightRaw = extractLabel(block, \u0027Grosswgt\u0027) ||\n                    extractLabel(block, \u0027Gross\\\\s*weight\u0027);\n  const tempRaw  = extractLabel(block, \u0027Temperature\u0027);\n  const emstek   = EMSTEK_INSTRUCTION_RE.test(block);\n  const noSwap   = DONT_EXCHANGE_RE.test(block);\n  const qty = parseQty(pallRaw);\n  const deliveryNoteParts = [];\n  if (deliveryAddr) deliveryNoteParts.push(`Original delivery address: ${deliveryAddr.raw_address}`);\n  const emstekSentence = block.match(EMSTEK_INSTRUCTION_RE);\n  if (emstekSentence) deliveryNoteParts.push(`HPT instruction: ${squish(emstekSentence[0])}`);\n  if (noSwap) deliveryNoteParts.push(\u0027DO NOT EXCHANGE PALLETS\u0027);\n  const delivery_stop = emstek\n    ? {\n        location: {\n          name:        AGROWORLD_EMSTEK.name,\n          street:      AGROWORLD_EMSTEK.street,\n          postal_code: AGROWORLD_EMSTEK.postalCode,\n          city:        AGROWORLD_EMSTEK.city,\n          country:     AGROWORLD_EMSTEK.country,\n          raw_address: `${AGROWORLD_EMSTEK.name}, ${AGROWORLD_EMSTEK.street}, ${AGROWORLD_EMSTEK.postalCode} ${AGROWORLD_EMSTEK.city}, ${AGROWORLD_EMSTEK.country}`,\n        },\n        note:         deliveryNoteParts.filter(Boolean).join(\u0027 | \u0027) || null,\n        instructions: noSwap ? \u0027DO NOT EXCHANGE PALLETS\u0027 : null,\n      }\n    : {\n        location: deliveryAddr ? {\n          name:        deliveryAddr.name || null,\n          street:      deliveryAddr.street || null,\n          postal_code: deliveryAddr.postalCode || null,\n          city:        deliveryAddr.city || null,\n          country:     deliveryAddr.country || null,\n          raw_address: deliveryAddr.raw_address,\n        } : null,\n        note:         noSwap ? \u0027DO NOT EXCHANGE PALLETS\u0027 : null,\n        instructions: noSwap ? \u0027DO NOT EXCHANGE PALLETS\u0027 : null,\n      };\n  return {\n    customer: \u0027HPT\u0027,\n    order_identifier: orderNo,\n    customer_reference_number: customerRef,\n    pickup_stop: pickupAddr ? {\n      location: {\n        name:        pickupAddr.name || null,\n        street:      pickupAddr.street || null,\n        postal_code: pickupAddr.postalCode || null,\n        city:        pickupAddr.city || null,\n        country:     pickupAddr.country || null,\n        raw_address: pickupAddr.raw_address,\n      },\n      note: null,\n      instructions: null,\n    } : null,\n    delivery_stop,\n    goods: [{\n      type: /colli/i.test(itemsRaw || \u0027\u0027) ? \u0027colli\u0027 : (itemsRaw ? squish(itemsRaw).toLowerCase() : \u0027colli\u0027),\n      quantity: qty.quantity,\n      packaging: qty.packaging,\n      total_weight_kg: parseWeight(weightRaw),\n      temperature_c: parseTemperature(tempRaw),\n    }],\n    metadata: {\n      source: \u0027hpt-pdf-parser\u0027,\n      emstek_rerouted: emstek,\n      no_exchange_pallets: noSwap,\n      raw_block: block,\n    },\n  };\n}\nfunction parseHpt(pdfText) {\n  const blocks = splitBlocks(pdfText);\n  return blocks.map(parseHptBlock).filter((o) =\u003e o.order_identifier);\n}\nconst out = [];\nfor (const item of $input.all()) {\n  const pdfText = item.json.pdf_text || item.json.text || item.json.extracted_text || \u0027\u0027;\n  if (!pdfText) {\n    out.push({ json: { ...item.json, hpt_error: \u0027pdf_text missing on input item\u0027 } });\n    continue;\n  }\n  const orders = parseHpt(pdfText);\n  if (orders.length === 0) {\n    out.push({ json: { ...item.json, hpt_error: \u0027no order blocks detected\u0027 } });\n    continue;\n  }\n  for (const order of orders) {\n    out.push({\n      json: {\n        ...item.json,\n        qargo_payload: order,\n        customer: \u0027HPT\u0027,\n        parser: \u0027lib/hpt.js\u0027,\n      },\n    });\n  }\n}\nreturn out;\nif (typeof require !== \u0027undefined\u0027 \u0026\u0026 require.main === module) {\n  const sample = `\n  Orderno: 54321\n  Customer ref: PO-9988\n  Loading address:\n  SlagterA/S\n  Hovedvej 12\n  8000 Aarhus\n  Delivery address:\n  Fleischhandel GmbH\n  Musterstr 1\n  20095 Hamburg\n  Please deliver it to your Emstek warehouse and we will load it Friday evening.\n  DO NOT EXCHANGE PALLETS\n  Items/type: colli\n  Pall/Type: 33 PAL\n  Grosswgt: 24.500 kg\n  Temperature: -2 C\n  `;\n  const orders = parseHpt(sample);\n  console.assert(orders.length === 1, \u0027expected one order\u0027);\n  const o = orders[0];\n  console.assert(o.order_identifier === \u002754321\u0027, \u0027order_identifier\u0027);\n  console.assert(o.delivery_stop.location.city === \u0027Emstek\u0027, \u0027Emstek reroute must apply\u0027);\n  console.assert(/Fleischhandel/.test(o.delivery_stop.note), \u0027original delivery kept in note\u0027);\n  console.assert(o.metadata.no_exchange_pallets === true, \u0027no-exchange flag\u0027);\n  console.assert(o.goods[0].total_weight_kg === 24500, \u0027weight parse\u0027);\n  console.assert(o.goods[0].temperature_c === -2, \u0027temperature parse\u0027);\n  console.log(\u0027HPT parser self-test OK\u0027);\n}";
const CUSTOMERS_JS       = "function safeString(v, f=\u0027\u0027) { if (v==null) return f; try { return String(v).trim(); } catch { return f; } }\nfunction squish(s)  { return safeString(s).replace(/[\\u00A0\\s]+/g, \u0027 \u0027).trim(); }\nfunction upper(s)   { return squish(s).toUpperCase(); }\nfunction lower(s)   { return squish(s).toLowerCase(); }\nfunction extractEmail(str) { const m = safeString(str).match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,})/i); return m ? m[1].toLowerCase() : null; }\nfunction domainOf(addr) { const a = extractEmail(addr); return a ? a.split(\u0027@\u0027)[1] : null; }\nfunction parseQty(raw) {\n  if (raw == null || raw === \u0027\u0027) return { quantity: null, packaging: null };\n  if (typeof raw === \u0027number\u0027) return { quantity: Math.trunc(raw), packaging: null };\n  const s = squish(raw).replace(\u0027,\u0027, \u0027.\u0027);\n  const m = s.match(/^(\\d+(?:\\.\\d+)?)\\s*[xX×]?\\s*([A-Za-z]{2,})?/);\n  if (!m) return { quantity: null, packaging: null };\n  return { quantity: Math.round(parseFloat(m[1])), packaging: m[2] ? m[2].toUpperCase() : null };\n}\nfunction parseWeight(raw) {\n  if (raw == null || raw === \u0027\u0027) return null;\n  if (typeof raw === \u0027number\u0027) return raw;\n  const s = squish(raw).toLowerCase().replace(/\\s+/g, \u0027\u0027);\n  const m = s.match(/^([\\d.,]+)(kg|g|t|ton)?$/); if (!m) return null;\n  const num = m[1].includes(\u0027,\u0027) \u0026\u0026 !m[1].includes(\u0027.\u0027)\n    ? parseFloat(m[1].replace(\u0027,\u0027,\u0027.\u0027))\n    : parseFloat(m[1].replace(/\\.(?=\\d{3}(?:\\D|$))/g,\u0027\u0027).replace(\u0027,\u0027,\u0027.\u0027));\n  if (!Number.isFinite(num)) return null;\n  switch (m[2]) { case \u0027g\u0027: return num/1000; case \u0027t\u0027: case \u0027ton\u0027: return num*1000; default: return num; }\n}\nfunction parseTemperature(raw) {\n  if (raw == null || raw === \u0027\u0027) return null;\n  const m = squish(raw).toLowerCase().replace(\u0027°c\u0027,\u0027\u0027).replace(\u0027,\u0027,\u0027.\u0027).match(/(-?\\d+(?:\\.\\d+)?)/);\n  return m ? parseFloat(m[1]) : null;\n}\nfunction parseDate(raw) {\n  if (!raw) return null;\n  const s = squish(raw);\n  const iso = s.match(/^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2}))?)?/);\n  if (iso) { const [_,Y,M,D,h=\u002700\u0027,m=\u002700\u0027,se=\u002700\u0027]=iso; return new Date(Date.UTC(+Y,+M-1,+D,+h,+m,+se)).toISOString(); }\n  const eu = s.match(/^(\\d{1,2})[-./ ](\\d{1,2})[-./ ](\\d{2,4})(?:\\s+(\\d{1,2}):(\\d{2}))?/);\n  if (eu) { let [_,D,M,Y,h=\u002700\u0027,m=\u002700\u0027]=eu; if (Y.length===2) Y=(+Y\u003e50?\u002719\u0027:\u002720\u0027)+Y; return new Date(Date.UTC(+Y,+M-1,+D,+h,+m)).toISOString(); }\n  const f = new Date(s); return Number.isNaN(f.getTime())?null:f.toISOString();\n}\nfunction labelValue(text, label) {\n  const re = new RegExp(`${label}\\\\s*[:#]?\\\\s*([^\\\\n]+)`, \u0027i\u0027);\n  const m  = safeString(text).match(re); return m ? squish(m[1]) : null;\n}\nfunction between(text, startRe, endRe) {\n  const s = safeString(text);\n  const m = s.match(new RegExp(`${startRe.source}([\\\\s\\\\S]*?)${endRe.source}`, startRe.flags.replace(\u0027g\u0027,\u0027\u0027)));\n  return m ? squish(m[1]) : null;\n}\nfunction addrFromBlock(block) {\n  const lines = safeString(block).split(\u0027\\n\u0027).map(squish).filter(Boolean);\n  if (!lines.length) return null;\n  const [name, street = \u0027\u0027, last = \u0027\u0027] = lines;\n  const pc = last.match(/(\\d{4,6})\\s+(.+)/);\n  return {\n    name, street,\n    postalCode: pc ? pc[1] : null,\n    city: pc ? squish(pc[2]) : squish(last),\n    country: null,\n    raw_address: lines.join(\u0027, \u0027),\n  };\n}\nfunction stopFromAddr(a, extras = {}) {\n  if (!a) return null;\n  return {\n    location: {\n      name: a.name || null, street: a.street || null,\n      postal_code: a.postalCode || null, city: a.city || null, country: a.country || null,\n      raw_address: a.raw_address || [a.name, a.street, a.postalCode, a.city, a.country].filter(Boolean).join(\u0027, \u0027),\n    },\n    note:         extras.note || null,\n    instructions: extras.instructions || null,\n  };\n}\nfunction mapTonnies({ attachments }) {\n  const xml = attachments.find((a) =\u003e /\\.xml$/i.test(a.filename) \u0026\u0026 a.xml_json);\n  if (!xml) return null;\n  const root = xml.xml_json?.TransportOrder || xml.xml_json?.transportorder || xml.xml_json;\n  if (!root) return null;\n  const orders = Array.isArray(root.Order) ? root.Order : [root.Order || root];\n  return orders.filter(Boolean).map((o) =\u003e {\n    const loading   = o.Loading  || o.LoadingStop  || o.Pickup   || {};\n    const unloading = o.Unloading|| o.UnloadingStop|| o.Delivery || {};\n    const goods     = []\n      .concat(o.Goods?.Item || o.Goods || [])\n      .filter(Boolean)\n      .map((g) =\u003e ({\n        type: squish(g.Type || \u0027colli\u0027).toLowerCase(),\n        quantity: parseInt(g.Quantity || g.Pallets || 0, 10) || null,\n        packaging: squish(g.Packaging || \u0027PAL\u0027) || null,\n        total_weight_kg: parseWeight(g.Weight || g.GrossWeight),\n        temperature_c: parseTemperature(g.Temperature),\n      }));\n    return {\n      customer: \u0027TONNIES\u0027,\n      order_identifier: squish(o.OrderNumber || o.OrderNo || o.Id),\n      customer_reference_number: squish(o.CustomerReference || o.Reference || o.OrderNumber),\n      pickup_stop:   stopFromAddr(addrFromBlock([\n        loading.Name, loading.Street, [loading.PostalCode, loading.City].filter(Boolean).join(\u0027 \u0027), loading.Country\n      ].filter(Boolean).join(\u0027\\n\u0027))),\n      delivery_stop: stopFromAddr(addrFromBlock([\n        unloading.Name, unloading.Street, [unloading.PostalCode, unloading.City].filter(Boolean).join(\u0027 \u0027), unloading.Country\n      ].filter(Boolean).join(\u0027\\n\u0027))),\n      goods: goods.length ? goods : [{ type: \u0027colli\u0027, quantity: null, packaging: null, total_weight_kg: null, temperature_c: null }],\n      metadata: {\n        source: \u0027tonnies-xml-parser\u0027,\n        pickup_date: parseDate(loading.Date || loading.LoadingDate),\n        delivery_date: parseDate(unloading.Date || unloading.UnloadingDate),\n      },\n    };\n  });\n}\nfunction mapEkro({ attachments }) {\n  const xlsx = attachments.find((a) =\u003e /\\.xlsx?$/i.test(a.filename) \u0026\u0026 Array.isArray(a.xlsx_rows));\n  if (!xlsx) return null;\n  const rows = xlsx.xlsx_rows.filter((r) =\u003e r \u0026\u0026 (r.OrderNumber || r.OrderNo || r.Order));\n  if (!rows.length) return null;\n  return rows.map((r) =\u003e ({\n    customer: \u0027EKRO\u0027,\n    order_identifier: squish(r.OrderNumber || r.OrderNo || r.Order),\n    customer_reference_number: squish(r.CustomerRef || r.Reference || r.PO || r.OrderNumber),\n    pickup_stop: stopFromAddr(addrFromBlock([r.PickupName, r.PickupStreet, [r.PickupPostal, r.PickupCity].filter(Boolean).join(\u0027 \u0027), r.PickupCountry].filter(Boolean).join(\u0027\\n\u0027))),\n    delivery_stop: stopFromAddr(addrFromBlock([r.DeliveryName, r.DeliveryStreet, [r.DeliveryPostal, r.DeliveryCity].filter(Boolean).join(\u0027 \u0027), r.DeliveryCountry].filter(Boolean).join(\u0027\\n\u0027))),\n    goods: [{\n      type: squish(r.GoodsType || \u0027colli\u0027).toLowerCase(),\n      quantity: parseInt(r.Pallets || r.Quantity || 0, 10) || null,\n      packaging: squish(r.Packaging || \u0027PAL\u0027),\n      total_weight_kg: parseWeight(r.Weight || r.GrossWeight),\n      temperature_c: parseTemperature(r.Temperature),\n    }],\n    metadata: {\n      source: \u0027ekro-xlsx-parser\u0027,\n      pickup_date: parseDate(r.PickupDate || r.LoadingDate),\n      delivery_date: parseDate(r.DeliveryDate || r.UnloadingDate),\n    },\n  }));\n}\nfunction mapCoomans({ context }) {\n  const text = safeString(context?.text || context);\n  const order = labelValue(text, \u0027Order(?:\\\\s*no)?\u0027) || labelValue(text, \u0027PO\u0027);\n  if (!order) return null;\n  const pickupBlock   = between(text, /Loading\\s*(?:address)?\\s*:?\\s*\\n/i, /(?:Delivery|Unloading|Items?|Pallet|Weight)/i);\n  const deliveryBlock = between(text, /(?:Delivery|Unloading)\\s*(?:address)?\\s*:?\\s*\\n/i, /(?:Items?|Pallet|Weight|$)/i);\n  return [{\n    customer: \u0027COOMANS\u0027,\n    order_identifier: order,\n    customer_reference_number: labelValue(text, \u0027Ref\u0027) || order,\n    pickup_stop:   stopFromAddr(addrFromBlock(pickupBlock)),\n    delivery_stop: stopFromAddr(addrFromBlock(deliveryBlock)),\n    goods: [{\n      type: \u0027colli\u0027,\n      quantity: parseInt(labelValue(text, \u0027Pallets?\u0027) || \u00270\u0027, 10) || null,\n      packaging: \u0027PAL\u0027,\n      total_weight_kg: parseWeight(labelValue(text, \u0027Weight\u0027) || labelValue(text, \u0027Gross\u0027)),\n      temperature_c: parseTemperature(labelValue(text, \u0027Temperature\u0027)),\n    }],\n    metadata: {\n      source: \u0027coomans-text-parser\u0027,\n      pickup_date: parseDate(labelValue(text, \u0027Loading\\\\s*date\u0027)),\n      delivery_date: parseDate(labelValue(text, \u0027Delivery\\\\s*date\u0027)),\n    },\n  }];\n}\nfunction mapTulling({ attachments }) {\n  const xml = attachments.find((a) =\u003e /\\.xml$/i.test(a.filename) \u0026\u0026 a.xml_json);\n  if (!xml) return null;\n  const root = xml.xml_json?.Shipments || xml.xml_json;\n  const shipments = []\n    .concat(root.Shipment || root)\n    .filter(Boolean);\n  if (!shipments.length) return null;\n  return shipments.map((s) =\u003e ({\n    customer: \u0027TULLING\u0027,\n    order_identifier: squish(s.ShipmentNumber || s.Id),\n    customer_reference_number: squish(s.CustomerReference || s.Reference || s.ShipmentNumber),\n    pickup_stop: stopFromAddr(addrFromBlock([s.ShipperName, s.ShipperStreet, [s.ShipperZip, s.ShipperCity].filter(Boolean).join(\u0027 \u0027), s.ShipperCountry].filter(Boolean).join(\u0027\\n\u0027))),\n    delivery_stop: stopFromAddr(addrFromBlock([s.ConsigneeName, s.ConsigneeStreet, [s.ConsigneeZip, s.ConsigneeCity].filter(Boolean).join(\u0027 \u0027), s.ConsigneeCountry].filter(Boolean).join(\u0027\\n\u0027))),\n    goods: [{\n      type: \u0027colli\u0027,\n      quantity: parseInt(s.Pallets || 0, 10) || null,\n      packaging: squish(s.Packaging || \u0027PAL\u0027),\n      total_weight_kg: parseWeight(s.Weight),\n      temperature_c: parseTemperature(s.Temperature),\n    }],\n    metadata: { source: \u0027tulling-xml-parser\u0027, pickup_date: parseDate(s.LoadingDate), delivery_date: parseDate(s.DeliveryDate) },\n  }));\n}\nfunction mapFnGlobal({ attachments, context }) {\n  const pdf = attachments.find((a) =\u003e /\\.pdf$/i.test(a.filename) \u0026\u0026 a.text);\n  const text = safeString(pdf?.text || context?.text || context);\n  if (!/FN\\s*Global/i.test(text) \u0026\u0026 !/fnglobalmeat/i.test(text)) return null;\n  const lines = text.split(\u0027\\n\u0027).map(squish).filter(Boolean);\n  const orderLineRe = /^(\\d{5,})\\s+(\\d+)\\s+([\\d.,]+)\\s+(-?\\d+(?:[.,]\\d+)?)?\\s*C?\\s+(.+?)\\s{2,}(.+)$/;\n  const orders = [];\n  for (const line of lines) {\n    const m = line.match(orderLineRe);\n    if (!m) continue;\n    orders.push({\n      customer: \u0027FN_GLOBAL\u0027,\n      order_identifier: m[1],\n      customer_reference_number: m[1],\n      pickup_stop:   stopFromAddr(addrFromBlock(m[5])),\n      delivery_stop: stopFromAddr(addrFromBlock(m[6])),\n      goods: [{\n        type: \u0027colli\u0027,\n        quantity: parseInt(m[2], 10),\n        packaging: \u0027PAL\u0027,\n        total_weight_kg: parseWeight(m[3]),\n        temperature_c: parseTemperature(m[4]),\n      }],\n      metadata: { source: \u0027fn-global-pdf-parser\u0027 },\n    });\n  }\n  return orders.length ? orders : null;\n}\nfunction mapCarnimex({ attachments, context }) {\n  const pdf = attachments.find((a) =\u003e /\\.pdf$/i.test(a.filename) \u0026\u0026 a.text);\n  const text = safeString(pdf?.text || context?.text || context);\n  const order = labelValue(text, \u0027Order\\\\s*number\u0027) || labelValue(text, \u0027Auftrag\u0027);\n  if (!order) return null;\n  return [{\n    customer: \u0027CARNIMEX\u0027,\n    order_identifier: order,\n    customer_reference_number: labelValue(text, \u0027Reference\u0027) || order,\n    pickup_stop:   stopFromAddr(addrFromBlock(between(text, /Loading\\s*:?\\s*\\n/i, /(?:Delivery|Unloading)/i))),\n    delivery_stop: stopFromAddr(addrFromBlock(between(text, /(?:Delivery|Unloading)\\s*:?\\s*\\n/i, /(?:Items?|Pallets|Weight|$)/i))),\n    goods: [{\n      type: \u0027colli\u0027,\n      quantity: parseInt(labelValue(text, \u0027Pallets?\u0027) || \u00270\u0027, 10) || null,\n      packaging: \u0027PAL\u0027,\n      total_weight_kg: parseWeight(labelValue(text, \u0027Weight\u0027) || labelValue(text, \u0027Gewicht\u0027)),\n      temperature_c: parseTemperature(labelValue(text, \u0027Temperature\u0027) || labelValue(text, \u0027Temperatur\u0027)),\n    }],\n    metadata: { source: \u0027carnimex-pdf-parser\u0027 },\n  }];\n}\nfunction mapAmeco({ attachments, context }) {\n  const text = safeString(attachments.find(a =\u003e a.text)?.text || context?.text || context);\n  const order = labelValue(text, \u0027Order\u0027) || labelValue(text, \u0027PO\u0027);\n  if (!order) return null;\n  return [{\n    customer: \u0027AMECO\u0027,\n    order_identifier: order,\n    customer_reference_number: labelValue(text, \u0027Ref\u0027) || order,\n    pickup_stop:   stopFromAddr(addrFromBlock(between(text, /Pick\\s*up\\s*:?\\s*\\n/i, /(?:Drop|Delivery|Items?)/i))),\n    delivery_stop: stopFromAddr(addrFromBlock(between(text, /(?:Drop|Delivery)\\s*:?\\s*\\n/i, /(?:Items?|Pallets|$)/i))),\n    goods: [{\n      type: \u0027colli\u0027,\n      quantity: parseInt(labelValue(text, \u0027Pallets?\u0027) || \u00270\u0027, 10) || null,\n      packaging: \u0027PAL\u0027,\n      total_weight_kg: parseWeight(labelValue(text, \u0027Weight\u0027)),\n      temperature_c: parseTemperature(labelValue(text, \u0027Temperature\u0027)),\n    }],\n    metadata: { source: \u0027ameco-parser\u0027 },\n  }];\n}\nfunction mapGoedegebuur(ctx) { return mapAmeco(ctx)?.map(o =\u003e ({ ...o, customer: \u0027GOEDEGEBUUR\u0027, metadata: { ...o.metadata, source: \u0027goedegebuur-parser\u0027 } })); }\nfunction mapThermotraffic(ctx) { return mapAmeco(ctx)?.map(o =\u003e ({ ...o, customer: \u0027THERMOTRAFFIC\u0027, metadata: { ...o.metadata, source: \u0027thermotraffic-parser\u0027 } })); }\nfunction mapWetralog(ctx) {\n  const out = mapAmeco(ctx); if (!out) return null;\n  return out.map(o =\u003e ({ ...o, customer: \u0027WETRALOG\u0027, metadata: { ...o.metadata, source: \u0027wetralog-parser\u0027 } }));\n}\nconst MAPPERS = {\n  TONNIES:       mapTonnies,\n  EKRO:          mapEkro,\n  COOMANS:       mapCoomans,\n  TULLING:       mapTulling,\n  FN_GLOBAL:     mapFnGlobal,\n  CARNIMEX:      mapCarnimex,\n  AMECO:         mapAmeco,\n  GOEDEGEBUUR:   mapGoedegebuur,\n  THERMOTRAFFIC: mapThermotraffic,\n  WETRALOG:      mapWetralog,\n};\nfunction detectCustomer(mail) {\n  const sender = extractEmail(mail?.from?.emailAddress?.address || mail?.from || \u0027\u0027) || \u0027\u0027;\n  const subject = safeString(mail?.subject);\n  const rules = [\n    [\u0027HPT\u0027,           /(^|@)(hpt\\.dk|therkelsen\\.)/i],\n    [\u0027TONNIES\u0027,       /(tonnies|weidemark|tevex)\\./i],\n    [\u0027EKRO\u0027,          /@ekro\\./i],\n    [\u0027COOMANS\u0027,       /(@coomans\\.|@ctimport\\.)/i],\n    [\u0027TULLING\u0027,       /@tulling\\./i],\n    [\u0027FN_GLOBAL\u0027,     /fn[-_ ]?global|@fnglobalmeat\\./i],\n    [\u0027CARNIMEX\u0027,      /@carnimex\\./i],\n    [\u0027AMECO\u0027,         /@ameco\\./i],\n    [\u0027GOEDEGEBUUR\u0027,   /@goedegebuur\\./i],\n    [\u0027THERMOTRAFFIC\u0027, /@thermotraffic\\./i],\n    [\u0027WETRALOG\u0027,      /@wetralog\\./i],\n  ];\n  for (const [key, re] of rules) if (re.test(sender) || re.test(subject)) return key;\n  return null;\n}\nconst out = [];\nfor (const item of $input.all()) {\n  const mail        = item.json.mail || {};\n  const attachments = item.json.attachments || [];\n  const context     = item.json.context      || {};\n  const override    = item.json.customer_key || null;\n  const customerKey = override || detectCustomer(mail);\n  if (!customerKey) {\n    out.push({ json: { ...item.json, needs_ai: true, reason: \u0027no_customer_rule_matched\u0027 } });\n    continue;\n  }\n  const mapper = MAPPERS[customerKey];\n  if (!mapper) {\n    out.push({ json: { ...item.json, customer: customerKey, needs_ai: true, reason: \u0027no_deterministic_mapper\u0027 } });\n    continue;\n  }\n  let orders = null;\n  try { orders = mapper({ mail, attachments, context }); }\n  catch (e) {\n    out.push({ json: { ...item.json, customer: customerKey, needs_ai: true, reason: `mapper_error: ${e.message}` } });\n    continue;\n  }\n  if (!orders || !orders.length) {\n    out.push({ json: { ...item.json, customer: customerKey, needs_ai: true, reason: \u0027mapper_no_match\u0027 } });\n    continue;\n  }\n  for (const o of orders) {\n    out.push({\n      json: {\n        ...item.json,\n        customer: customerKey,\n        qargo_payload: o,\n        parser: `lib/customers.js:${customerKey}`,\n        needs_ai: false,\n      },\n    });\n  }\n}\nreturn out;";
const VALIDATE_UPLOAD_JS = "const out = [];\nfor (const item of $input.all()) {\n  const resp   = item.json.response || item.json.body || item.json;\n  const status = item.json.statusCode || item.json.status || item.json.response?.status;\n  const sentId = item.json.qargo_payload?.order_identifier\n               || item.json.order_identifier\n               || null;\n  const qargoId = resp?.order_identifier\n               || resp?.data?.order_identifier\n               || resp?.id\n               || resp?.order?.order_identifier\n               || null;\n  const httpOk = (status \u003e= 200 \u0026\u0026 status \u003c 300) || status === undefined;\n  const ok = httpOk \u0026\u0026 !!qargoId \u0026\u0026 (!sentId || String(qargoId) === String(sentId) || !!resp?.success);\n  out.push({\n    json: {\n      ...item.json,\n      upload_ok: ok,\n      upload_http_status: status,\n      qargo_order_id: qargoId,\n      upload_error: ok ? null : (\n        !httpOk ? `HTTP ${status}` :\n        !qargoId ? \u0027Qargo response missing order_identifier\u0027 :\n        `Qargo echoed ${qargoId} but we sent ${sentId}`\n      ),\n    },\n  });\n}\nreturn out;";
const FINALIZE_JS        = "const out = [];\nfor (const item of $input.all()) {\n  const uploadOk     = item.json.upload_ok === true;\n  const importStatus = item.json.import_status || item.json.response?.status || null;\n  const needsReview  = item.json.needs_review === true\n                     || item.json.ignore_gate === \u0027review\u0027\n                     || item.json.review       === true;\n  const shouldIgnore = item.json.ignore_gate === \u0027ignore\u0027\n                     || item.json.ignore      === true;\n  let outcome;\n  if (shouldIgnore)                            outcome = \u0027ignore\u0027;\n  else if (!uploadOk || needsReview)           outcome = \u0027review\u0027;\n  else if (importStatus \u0026\u0026 /failed|error/i.test(importStatus)) outcome = \u0027review\u0027;\n  else                                         outcome = \u0027upload\u0027;\n  out.push({\n    json: {\n      ...item.json,\n      outcome,\n      finalize_reason:\n        outcome === \u0027upload\u0027 ? \u0027Qargo upload + import confirmed\u0027\n      : outcome === \u0027review\u0027 ? (item.json.upload_error || \u0027needs manual review\u0027)\n      : \u0027customer marked ignore\u0027,\n      finalize_ts: new Date().toISOString(),\n    },\n  });\n}\nreturn out;";

const outlookCred  = newCredential('Microsoft Outlook');
const qargoCred    = newCredential('Qargo_Api_Key');
const anthropicCred = newCredential('Anthropic account');

const outlookTrigger = trigger({
  type: 'n8n-nodes-base.microsoftOutlookTrigger',
  version: 1,
  config: {
    name: 'Outlook Trigger',
    position: [0, 0],
    parameters: {
      pollTimes: { item: [{ mode: 'everyMinute' }] },
      output: 'raw',
      filters: { readStatus: 'unread' },
      options: {}
    },
    credentials: { microsoftOutlookOAuth2Api: outlookCred }
  },
  output: [{
    id: 'AAMkAD...',
    internetMessageId: '<abc@example.com>',
    subject: 'Forwarded order',
    hasAttachments: true,
    from: { emailAddress: { address: 'colleague@agroworld.nl', name: 'Colleague' } },
    body: { content: 'From: customer@hpt.dk\n\nOrderno: 12345\n...', contentType: 'text' },
    receivedDateTime: '2026-04-17T10:00:00Z'
  }]
});

const normalizeEmail = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Email',
    position: [240, 0],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: NORMALIZE_EMAIL_JS }
  },
  output: [{
    mail: {
      id: 'AAMkAD...',
      internetMessageId: '<abc@example.com>',
      subject: 'Forwarded order',
      originalSender: 'customer@hpt.dk',
      from: { address: 'colleague@agroworld.nl', displayName: 'Colleague' },
      hasAttachments: true,
      body: { content: 'From: customer@hpt.dk\n\nOrderno: 12345\n...', contentType: 'text' }
    },
    raw: {}
  }]
});

const processedHitsStub = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Processed Hits (stub - wire Data Table)',
    position: [480, 0],
    parameters: {
      assignments: { assignments: [
        { id: 'a1', name: 'processed_hits', value: expr('{{ [] }}'), type: 'array' }
      ] },
      options: {}
    }
  },
  output: [{ mail: {}, processed_hits: [] }]
});

const dedupeGate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Already Processed?',
    position: [720, 0],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: DEDUPE_JS }
  },
  output: [{ mail: {}, already_processed: false, mail_id_for_dedupe: '<abc@example.com>', skip_reason: null }]
});

const ifProcessed = ifElse({
  version: 2.2,
  config: {
    name: 'If Already Processed',
    position: [960, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
        combinator: 'and',
        conditions: [{
          id: 'c-already',
          leftValue: expr('{{ $json.already_processed }}'),
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true }
        }]
      },
      options: {}
    }
  }
});

const skipNoop = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Skip (already processed)', position: [1200, -200], parameters: {} },
  output: [{}]
});

const ifHasAttachments = ifElse({
  version: 2.2,
  config: {
    name: 'Has Attachments?',
    position: [1200, 200],
    parameters: {
      conditions: {
        options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
        combinator: 'and',
        conditions: [{
          id: 'c-has-att',
          leftValue: expr('{{ $json.mail.hasAttachments }}'),
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true }
        }]
      },
      options: {}
    }
  }
});

const getAttachments = node({
  type: 'n8n-nodes-base.microsoftOutlook',
  version: 2,
  config: {
    name: 'Get Attachments',
    position: [1440, 100],
    parameters: {
      resource: 'messageAttachment',
      operation: 'getAll',
      messageId: expr('{{ $json.mail.id }}'),
      returnAll: true,
      additionalFields: {}
    },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    credentials: { microsoftOutlookOAuth2Api: outlookCred }
  },
  output: [{ id: 'att1', name: 'order.pdf', contentType: 'application/pdf', size: 1234, contentBytes: 'AAA==' }]
});

const aggregateAttachments = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Aggregate Attachments',
    position: [1680, 100],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const all = $input.all();\nconst mailItem = all[0]?.json?.mail ? all[0].json : null;\nconst atts = [];\nfor (const it of all) {\n  const a = it.json;\n  if (!a || !a.name) continue;\n  const mime = (a.contentType || '').toLowerCase();\n  const filename = a.name || '';\n  let text = null;\n  if (a.contentBytes && (/xml|json|text|csv/.test(mime) || /\\.(xml|json|txt|csv)$/i.test(filename))) {\n    try { text = Buffer.from(a.contentBytes, 'base64').toString('utf8'); } catch (e) { text = null; }\n  }\n  atts.push({ filename, mime, size: a.size || 0, text, contentBytes: a.contentBytes || null, attachmentId: a.id || null, xml_json: null, xlsx_rows: null });\n}\nreturn [{ json: { ...(mailItem || {}), attachments: atts } }];"
    }
  },
  output: [{ mail: {}, attachments: [{ filename: 'order.pdf', mime: 'application/pdf', size: 1234, text: null }] }]
});

const mailOnlyContext = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Mail-only Context',
    position: [1440, 300],
    parameters: {
      assignments: { assignments: [
        { id: 'a2', name: 'attachments', value: expr('{{ [] }}'), type: 'array' },
        { id: 'a3', name: 'context', value: expr('{{ { text: ($json.mail && $json.mail.body && $json.mail.body.content) ? String($json.mail.body.content).slice(0, 40000) : "" } }}'), type: 'object' }
      ] },
      options: {}
    }
  },
  output: [{ mail: {}, attachments: [], context: { text: '' } }]
});

const isHpt = ifElse({
  version: 2.2,
  config: {
    name: 'Is HPT?',
    position: [1920, 100],
    parameters: {
      conditions: {
        options: { caseSensitive: false, typeValidation: 'loose', version: 2 },
        combinator: 'or',
        conditions: [
          { id: 'c-hpt-sender', leftValue: expr('{{ ($json.mail && $json.mail.originalSender) || "" }}'), rightValue: 'hpt.dk|therkelsen', operator: { type: 'string', operation: 'regex' } },
          { id: 'c-hpt-subject', leftValue: expr('{{ ($json.mail && $json.mail.subject) || "" }}'), rightValue: 'H\\.?\\s*P\\.?\\s*Therkelsen', operator: { type: 'string', operation: 'regex' } }
        ]
      },
      options: {}
    }
  }
});

const prepHptPdf = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prep HPT PDF Text',
    position: [2160, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const out = [];\nfor (const it of $input.all()) {\n  const atts = it.json.attachments || [];\n  const pdfTexts = atts.filter(a => /\\.pdf$/i.test(a.filename) || /pdf/i.test(a.mime || '')).map(a => a.text || '').join('\\n');\n  out.push({ json: { ...it.json, pdf_text: pdfTexts || (it.json.context && it.json.context.text) || '' } });\n}\nreturn out;"
    }
  },
  output: [{ mail: {}, attachments: [], pdf_text: 'Orderno: 12345\n...' }]
});

const hptParser = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'HPT Parser',
    position: [2400, 0],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: HPT_JS }
  },
  output: [{ customer: 'HPT', qargo_payload: { order_identifier: '12345' }, parser: 'lib/hpt.js' }]
});

const customerRouter = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Customer Router',
    position: [2160, 200],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: CUSTOMERS_JS }
  },
  output: [{ customer: 'TONNIES', qargo_payload: { order_identifier: '99' }, needs_ai: false }]
});

const needsAi = ifElse({
  version: 2.2,
  config: {
    name: 'Needs AI?',
    position: [2400, 200],
    parameters: {
      conditions: {
        options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
        combinator: 'and',
        conditions: [{
          id: 'c-needs-ai',
          leftValue: expr('{{ $json.needs_ai === true }}'),
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true }
        }]
      },
      options: {}
    }
  }
});

const claudeModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
  version: 1.3,
  config: {
    name: 'Claude Model',
    position: [2640, 380],
    parameters: { model: 'claude-sonnet-4-6', options: { maxTokensToSample: 4096, temperature: 0 } },
    credentials: { anthropicApi: anthropicCred }
  }
});

const aiAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 1.9,
  config: {
    name: 'AI Agent',
    position: [2640, 200],
    parameters: {
      promptType: 'define',
      text: expr('You convert forwarded freight-order emails to Qargo JSON.\nReturn ONLY valid JSON with keys: customer, order_identifier, customer_reference_number, pickup_stop, delivery_stop, goods[], metadata, needs_review.\nRules: do NOT invent addresses. If required field missing set needs_review=true.\n\nSUBJECT: {{ $json.mail.subject }}\nFROM: {{ $json.mail.originalSender }}\nBODY: {{ (($json.context && $json.context.text) || "").slice(0, 12000) }}\nATTACHMENTS: {{ ($json.attachments || []).map(a => "--- " + a.filename + " ---\\n" + (a.text || "").slice(0, 12000)).join("\\n\\n").slice(0, 40000) }}'),
      options: { systemMessage: 'You are a careful logistics data extractor. Return JSON only. No prose.' }
    },
    subnodes: { model: claudeModel }
  },
  output: [{ output: '{"customer":"NEW","order_identifier":"X1","needs_review":false}' }]
});

const parseAi = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse AI Result',
    position: [2880, 200],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const out = [];\nfor (const it of $input.all()) {\n  const raw = it.json.output || it.json.text || it.json.response || '';\n  let payload = null, review = false, reason = null;\n  try {\n    const s = String(raw).trim();\n    const json = s.startsWith('{') ? s : (s.match(/\\{[\\s\\S]*\\}/) || [null])[0];\n    payload = json ? JSON.parse(json) : null;\n  } catch (e) { review = true; reason = 'ai_parse_error: ' + e.message; }\n  if (!payload) { review = true; reason = reason || 'ai_no_json'; }\n  if (payload && payload.needs_review === true) { review = true; reason = 'ai_flagged_review'; }\n  out.push({ json: { ...it.json, qargo_payload: payload, needs_review: review, review_reason: reason, parser: 'ai-fallback' } });\n}\nreturn out;"
    }
  },
  output: [{ qargo_payload: { order_identifier: 'X1' }, needs_review: false, parser: 'ai-fallback' }]
});

const mergeAiDeterm = merge({
  version: 3.2,
  config: { name: 'Merge', position: [3120, 200], parameters: { mode: 'append' } }
});

const validatePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Payload',
    position: [3360, 200],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "function validate(p){const e=[];if(!p||typeof p!=='object')e.push('not object');if(!p?.order_identifier)e.push('order_identifier');if(!p?.customer)e.push('customer');if(!p?.pickup_stop?.location)e.push('pickup_stop.location');if(!p?.delivery_stop?.location)e.push('delivery_stop.location');if(!Array.isArray(p?.goods)||p.goods.length===0)e.push('goods[]');return{ok:e.length===0,errors:e};}\nconst out=[];\nfor(const it of $input.all()){const p=it.json.qargo_payload;const v=validate(p);out.push({json:{...it.json,payload_valid:v.ok,payload_errors:v.errors,needs_review:it.json.needs_review||!v.ok,review_reason:it.json.review_reason||(!v.ok?'schema_invalid: '+v.errors.join(','):null)}});}\nreturn out;"
    }
  },
  output: [{ qargo_payload: {}, payload_valid: true, payload_errors: [], needs_review: false }]
});

const ifValidUpload = ifElse({
  version: 2.2,
  config: {
    name: 'Valid for Upload?',
    position: [3600, 200],
    parameters: {
      conditions: {
        options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
        combinator: 'and',
        conditions: [{
          id: 'c-valid',
          leftValue: expr('{{ $json.payload_valid === true && !$json.needs_review }}'),
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true }
        }]
      },
      options: {}
    }
  }
});

const uploadQargo = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Upload to Qargo',
    position: [3840, 100],
    parameters: {
      method: 'POST',
      url: 'https://api.qargo.com/v1/orders',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.qargo_payload) }}'),
      options: { response: { response: { fullResponse: true, responseFormat: 'json' } } }
    },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    credentials: { httpHeaderAuth: qargoCred }
  },
  output: [{ statusCode: 201, response: { order_identifier: 'X1', success: true } }]
});

const validateUpload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Upload',
    position: [4080, 100],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: VALIDATE_UPLOAD_JS }
  },
  output: [{ upload_ok: true, qargo_order_id: 'X1' }]
});

const waitImport = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Wait for Import',
    position: [4320, 100],
    parameters: { amount: 30, unit: 'seconds' },
    webhookId: 'wait-import-30s'
  },
  output: [{ upload_ok: true }]
});

const getStatus = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Get Import Status',
    position: [4560, 100],
    parameters: {
      url: expr('https://api.qargo.com/v1/orders/{{ $json.qargo_order_id }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      options: {}
    },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    credentials: { httpHeaderAuth: qargoCred }
  },
  output: [{ status: 'imported', response: { status: 'imported' } }]
});

const finalizeImport = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Finalize Import',
    position: [4800, 100],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: FINALIZE_JS }
  },
  output: [{ outcome: 'upload', finalize_reason: 'ok', finalize_ts: '2026-04-17T10:00:00Z' }]
});

const outcomeSwitch = switchCase({
  version: 3.2,
  config: {
    name: 'Outcome Switch',
    position: [5040, 100],
    parameters: {
      rules: { values: [
        { outputKey: 'upload', conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: 'c-upload', leftValue: expr('{{ $json.outcome }}'), rightValue: 'upload', operator: { type: 'string', operation: 'equals' } }] } },
        { outputKey: 'review', conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: 'c-review', leftValue: expr('{{ $json.outcome }}'), rightValue: 'review', operator: { type: 'string', operation: 'equals' } }] } },
        { outputKey: 'ignore', conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: 'c-ignore', leftValue: expr('{{ $json.outcome }}'), rightValue: 'ignore', operator: { type: 'string', operation: 'equals' } }] } }
      ] },
      options: {}
    }
  }
});

const markReadUpload = node({
  type: 'n8n-nodes-base.microsoftOutlook',
  version: 2,
  config: {
    name: 'Mark Read (upload)',
    position: [5280, -100],
    parameters: { resource: 'message', operation: 'update', messageId: expr('{{ $json.mail.id }}'), updateFields: { isRead: true } },
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
    credentials: { microsoftOutlookOAuth2Api: outlookCred }
  },
  output: [{ ok: true }]
});

const moveClientFolder = node({
  type: 'n8n-nodes-base.microsoftOutlook',
  version: 2,
  config: {
    name: 'Move to Client Folder',
    position: [5520, -100],
    parameters: { resource: 'message', operation: 'move', messageId: expr('{{ $json.mail.id }}'), folderId: expr('{{ $json.client_folder_id || "" }}') },
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, continueOnFail: true,
    credentials: { microsoftOutlookOAuth2Api: outlookCred }
  },
  output: [{ ok: true }]
});

const moveReview = node({
  type: 'n8n-nodes-base.microsoftOutlook',
  version: 2,
  config: {
    name: 'Move to Review',
    position: [5280, 100],
    parameters: { resource: 'message', operation: 'move', messageId: expr('{{ $json.mail.id }}'), folderId: expr('{{ $json.review_folder_id || "" }}') },
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, continueOnFail: true,
    credentials: { microsoftOutlookOAuth2Api: outlookCred }
  },
  output: [{ ok: true }]
});

const markReadIgnore = node({
  type: 'n8n-nodes-base.microsoftOutlook',
  version: 2,
  config: {
    name: 'Mark Read (ignore)',
    position: [5280, 300],
    parameters: { resource: 'message', operation: 'update', messageId: expr('{{ $json.mail.id }}'), updateFields: { isRead: true } },
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
    credentials: { microsoftOutlookOAuth2Api: outlookCred }
  },
  output: [{ ok: true }]
});

const trackProcessed = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Track Processed (last write)',
    position: [5760, 100],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const out=[];\nfor(const it of $input.all()){\n  const row={ internetMessageId: it.json.mail_id_for_dedupe || it.json.mail?.internetMessageId || null, processed_at: new Date().toISOString(), outcome: it.json.outcome || null, customer: it.json.customer || null, qargo_order_id: it.json.qargo_order_id || null, review_reason: it.json.review_reason || it.json.finalize_reason || null };\n  out.push({ json: { ...it.json, tracked_row: row } });\n}\nreturn out;"
    }
  },
  output: [{ tracked_row: { internetMessageId: '<abc@example.com>', processed_at: '2026-04-17T10:00:00Z', outcome: 'upload' } }]
});

const notes = sticky(
  '## Agro World Order Intake V8.1\n\n' +
  'Drop-in Code nodes with inlined library bodies:\n' +
  '- Normalize Email (lib/normalize_email.js)\n' +
  '- Already Processed? (lib/dedupe.js)\n' +
  '- HPT Parser (lib/hpt.js, Emstek rule)\n' +
  '- Customer Router (lib/customers.js, 10 deterministic mappers)\n' +
  '- Validate Upload (lib/validate_upload.js)\n' +
  '- Finalize Import (lib/finalize.js)\n\n' +
  'Before running:\n' +
  '1. Replace "Processed Hits (stub)" with a Data Table Search row keyed on internetMessageId.\n' +
  '2. Replace "Track Processed (last write)" body with a Data Table Insert row.\n' +
  '3. Set client_folder_id and review_folder_id per customer (via Load Memory).\n' +
  '4. Verify Outlook / Qargo / Anthropic credentials are bound.',
  [],
  { color: 4 }
);

export default workflow('agroworld-order-intake-v81', 'Agro World Order Intake V8.1')
  .add(outlookTrigger)
  .to(normalizeEmail)
  .to(processedHitsStub)
  .to(dedupeGate)
  .to(ifProcessed
    .onTrue(skipNoop)
    .onFalse(ifHasAttachments
      .onTrue(getAttachments.to(aggregateAttachments.to(isHpt
        .onTrue(prepHptPdf.to(hptParser.to(needsAi
          .onTrue(aiAgent.to(parseAi.to(mergeAiDeterm.input(0))))
          .onFalse(mergeAiDeterm.input(1))
        )))
        .onFalse(customerRouter.to(needsAi))
      )))
      .onFalse(mailOnlyContext.to(isHpt))
    )
  )
  .add(mergeAiDeterm)
  .to(validatePayload)
  .to(ifValidUpload
    .onTrue(uploadQargo
      .to(validateUpload)
      .to(waitImport)
      .to(getStatus)
      .to(finalizeImport)
      .to(outcomeSwitch
        .onCase(0, markReadUpload.to(moveClientFolder.to(trackProcessed)))
        .onCase(1, moveReview.to(trackProcessed))
        .onCase(2, markReadIgnore.to(trackProcessed))
      )
    )
    .onFalse(moveReview)
  );
