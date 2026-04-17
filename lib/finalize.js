/**
 * lib/finalize.js – Finalize Import (idempotent wrap-up).
 *
 * DROP-IN n8n CODE NODE BODY.
 *   Replaces the existing "Finalize Import" node in the V8 workflow.
 *   Mode: "Run Once for All Items"
 *
 * Decides the routing outcome:
 *   outcome === 'upload'   → proceed to Store Memory → Track Processed → Mark Read → Move to Client Folder
 *   outcome === 'review'   → Move to Review → Track Processed (stops there, not marked read)
 *   outcome === 'ignore'   → Mark Read → Track Processed
 *
 * Track Processed MUST be the last write so the mail is re-tryable on
 * transient failures upstream.
 */

const out = [];
for (const item of $input.all()) {
  const uploadOk     = item.json.upload_ok === true;
  const importStatus = item.json.import_status || item.json.response?.status || null;
  const needsReview  = item.json.needs_review === true
                     || item.json.ignore_gate === 'review'
                     || item.json.review       === true;
  const shouldIgnore = item.json.ignore_gate === 'ignore'
                     || item.json.ignore      === true;

  let outcome;
  if (shouldIgnore)                            outcome = 'ignore';
  else if (!uploadOk || needsReview)           outcome = 'review';
  else if (importStatus && /failed|error/i.test(importStatus)) outcome = 'review';
  else                                         outcome = 'upload';

  out.push({
    json: {
      ...item.json,
      outcome,
      finalize_reason:
        outcome === 'upload' ? 'Qargo upload + import confirmed'
      : outcome === 'review' ? (item.json.upload_error || 'needs manual review')
      : 'customer marked ignore',
      finalize_ts: new Date().toISOString(),
    },
  });
}
return out;
