import {
  workflow, node, trigger, ifElse, switchCase, merge, sticky,
  languageModel, newCredential, expr
} from '@n8n/workflow-sdk';

const NORMALIZE_EMAIL_JS = '__NORMALIZE_EMAIL_JS__';
const DEDUPE_JS          = '__DEDUPE_JS__';
const HPT_JS             = '__HPT_JS__';
const CUSTOMERS_JS       = '__CUSTOMERS_JS__';
const VALIDATE_UPLOAD_JS = '__VALIDATE_UPLOAD_JS__';
const FINALIZE_JS        = '__FINALIZE_JS__';

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
