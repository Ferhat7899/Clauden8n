/**
 * lib/normalize_email.js – Normalize Email.
 *
 * DROP-IN n8n CODE NODE BODY, first Code node after the Outlook Trigger.
 *   Mode: "Run Once for All Items"
 *
 * Purpose:
 *   - Lift the original sender out of forwarded mails (our own Agro World
 *     colleague forwards customer orders from their inbox).
 *   - Produce a canonical `mail` object with fields every downstream
 *     node can rely on, regardless of Outlook's payload quirks.
 */

function safeString(v, f='') { if (v==null) return f; try { return String(v).trim(); } catch { return f; } }
function squish(s) { return safeString(s).replace(/[\u00A0\s]+/g, ' ').trim(); }
function extractEmail(s) { const m = safeString(s).match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i); return m ? m[1].toLowerCase() : null; }

function originalSender(mail) {
  const OWN = /@(agroworld\.|agro-world\.|agro\.world)/i;
  const outer = extractEmail(mail.from?.emailAddress?.address || mail.from || '');
  const body  = safeString(mail.body?.content || mail.bodyPreview || '');
  const fwd = body.match(/^\s*(?:From|Van|Von|De)\s*:\s*[^<\n]*<?\s*([^\s<>]+@[^\s<>]+)/im)
           || body.match(/-{2,}\s*Original Message\s*-{2,}[\s\S]*?(?:From|Van|Von)\s*:\s*[^<\n]*<?\s*([^\s<>]+@[^\s<>]+)/im)
           || body.match(/-{2,}\s*Oorspronkelijk bericht\s*-{2,}[\s\S]*?Van\s*:\s*[^<\n]*<?\s*([^\s<>]+@[^\s<>]+)/im);
  const forwarded = fwd ? fwd[1].toLowerCase().replace(/[>]+$/, '') : null;
  if (forwarded && outer && OWN.test(outer)) return forwarded;
  return outer || forwarded || null;
}

const out = [];
for (const item of $input.all()) {
  const m = item.json;
  const orig = originalSender(m);

  out.push({
    json: {
      mail: {
        id:                  m.id || null,
        internetMessageId:   m.internetMessageId || m.messageId || m.id || null,
        subject:             squish(m.subject),
        receivedDateTime:    m.receivedDateTime || m.receivedAt || null,
        from: {
          displayName: squish(m.from?.emailAddress?.name),
          address:     (m.from?.emailAddress?.address || '').toLowerCase() || null,
        },
        originalSender: orig,
        body: {
          content:     safeString(m.body?.content),
          contentType: m.body?.contentType || 'text',
        },
        bodyPreview:         squish(m.bodyPreview),
        hasAttachments:      !!m.hasAttachments,
        parentFolderId:      m.parentFolderId || null,
        conversationId:      m.conversationId || null,
        categories:          Array.isArray(m.categories) ? m.categories : [],
      },
      raw: m,
    },
  });
}
return out;
