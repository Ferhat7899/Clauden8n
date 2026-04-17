/**
 * lib/dedupe.js – "Already Processed?" gate.
 *
 * DROP-IN n8n CODE NODE BODY, used directly after Outlook Trigger.
 *   Mode: "Run Once for All Items"
 *
 * Reads the processed-mail Data Table (via a preceding n8n "Data Table: search")
 * and blocks already-processed messageIds.
 *
 * The node expects on the incoming item:
 *   json.mail.internetMessageId    – the stable Outlook message id
 *   json.processed_hits            – array of rows found in the Data Table
 *                                     (from the preceding search, can be empty)
 *
 * It outputs a single item with:
 *   already_processed: boolean
 *   skip_reason:       string | null
 */

const out = [];
for (const item of $input.all()) {
  const mail = item.json.mail || item.json;
  const id   = mail.internetMessageId
            || mail.messageId
            || mail.id
            || null;
  const hits = item.json.processed_hits || [];
  const hit  = id && hits.find((h) => h.internetMessageId === id || h.message_id === id);

  out.push({
    json: {
      ...item.json,
      already_processed: !!hit,
      skip_reason: hit ? `Mail ${id} already processed at ${hit.processed_at || 'unknown'}` : null,
      mail_id_for_dedupe: id,
    },
  });
}
return out;
