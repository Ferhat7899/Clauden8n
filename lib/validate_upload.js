/**
 * lib/validate_upload.js – Validate Qargo's upload response.
 *
 * DROP-IN n8n CODE NODE BODY.
 *   Replaces the existing "Validate Upload" node in the V8 workflow.
 *   Mode: "Run Once for All Items"
 *
 * The old node checked only HTTP status. This one also requires a non-empty
 * echo of the order_identifier; otherwise it flags for Review.
 */

const out = [];
for (const item of $input.all()) {
  const resp   = item.json.response || item.json.body || item.json;
  const status = item.json.statusCode || item.json.status || item.json.response?.status;

  const sentId = item.json.qargo_payload?.order_identifier
               || item.json.order_identifier
               || null;

  const qargoId = resp?.order_identifier
               || resp?.data?.order_identifier
               || resp?.id
               || resp?.order?.order_identifier
               || null;

  const httpOk = (status >= 200 && status < 300) || status === undefined;

  const ok = httpOk && !!qargoId && (!sentId || String(qargoId) === String(sentId) || !!resp?.success);

  out.push({
    json: {
      ...item.json,
      upload_ok: ok,
      upload_http_status: status,
      qargo_order_id: qargoId,
      upload_error: ok ? null : (
        !httpOk ? `HTTP ${status}` :
        !qargoId ? 'Qargo response missing order_identifier' :
        `Qargo echoed ${qargoId} but we sent ${sentId}`
      ),
    },
  });
}
return out;
