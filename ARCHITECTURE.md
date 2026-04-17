# Order Intake Platform – Architecture Review & Rebuild

Two n8n workflows were analyzed:

| File | Nodes | Role |
|---|---|---|
| `Orderimport(4).json` | ~145 | **Legacy** customer-keyed parallel branches |
| `Agro World AI Order Intake Agent V8.0.2.json` | ~60 | **New** unified AI intake pipeline |

## 1 · Analysis

### 1.1 Orderimport (legacy) – what is wrong
- **10+ near-identical branches**, one per customer (FN Global, Tönnies, Coomans, Tulling, Ekro, Carnimex, Ameco, Goedegebuur, Thermotraffic, Wetralog). Each branch has its own *Get Attachments → Filter → Download → Extract → Transform → Upload → Move* chain. Any bug fix must be applied 10×.
- **Trigger/polling mix**: `Get many folder messages` (polling) *and* `Microsoft Outlook Trigger` (push) both present → races + duplicate processing.
- **Filter/extract/download node order differs per branch** (some filter before download, some after) → silent data loss for attachments whose MIME type n8n reports non-canonically.
- **`AI Transform*`** nodes (×10) each contain a free-form prompt — no shared schema, no JSON-Schema validation of output, no retry on malformed JSON.
- **No duplicate-mail protection**. Moving to *Order Succesvol* is the only guard; if the move fails silently the mail is re-processed forever.
- **No memory**. Customer detection is hard-coded in `Switch` + node names; every new customer = clone a branch.
- **`Code in JavaScript`, `…1`, `…2`…** — identical helpers (header normalization, date parsing) copy-pasted with drift.
- **HPT path** missing entirely — no branch for `hpt.dk` / H.P. Therkelsen.
- **Upload status never checked**. `Upload to QargoN` runs, then we immediately move the mail; a 4xx on Qargo leaves the mail marked "successful".

### 1.2 AI Order Intake V8.0.2 – what is right and wrong
Right:
- Single trigger (`Outlook Trigger`), `Already Processed?` de-dupe via Data Table, `Normalize Email` extracts original sender from forwards.
- Proper attachment-type switch (xml / pdf / xlsx / text / image / universal) — each returns normalized *Context* items into one `Aggregate Attachment Context`.
- `Load Memory` + `Register New Customer` + `Store Memory` → learning loop.
- `Upload to Qargo` → `Wait` → `Get Import Status` → `Finalize` → `Store Memory` → `Mark Mail Read` → `Move to Client Folder` is the correct happy-path order.
- `Manual Review Gate` and `Ignore Gate` separate the three outcomes (upload / review / ignore).

Wrong / fragile:
- **`Customer Router`** drops to AI for every customer; only `Tönnies Mapper` is deterministic. The other 10 customers still pay AI latency and token cost per mail.
- **`Build AI Prompt`** concatenates raw PDF/XLSX text without truncation → blows the model context on large packing lists.
- **`Parse AI Result`** trusts the model's JSON. One malformed token and the whole chain throws.
- **HPT not implemented** — same gap as Orderimport.
- **`Validate Upload`** only checks HTTP status; it does not re-read the Qargo payload echo for `order_identifier` — a 200 with empty body still "passes".
- **Retry logic is absent** on `Download XML/PDF/XLSX` (Graph API occasionally returns 502). One transient blip → mail moved to review.
- **`Track Processed`** writes *after* `Store Memory`. If the flow fails between them, mail is re-processed even though Qargo already has the order → duplicate orders.
- **`Move Mail Read` vs `Move to Client Folder`**: two separate Outlook calls; neither is idempotent. A half-failure leaves mail read but in Inbox, or moved but unread.

### 1.3 Overlap between the two workflows
The legacy file and V8 both try to do the same job for the same customers. Running both against the same Inbox = **every order processed twice**: once by a per-customer branch in Orderimport (with no dedup) and once by V8 (with dedup). This is the single biggest production risk.

## 2 · Verdict

**Retire `Orderimport(4).json`.** Keep V8 as the only production workflow. Migrate every deterministic mapper from Orderimport into `lib/customers.js` in this repo; V8's `Customer Router` calls them first, AI is the fallback. Rationale:

- Single trigger, single dedup table → no double-processing.
- One mail pipeline → one place to fix normalization, retry, status-check bugs.
- Deterministic mappers beat AI on cost, latency and stability for customers whose template never changes (Tönnies, HPT, Ekro, Coomans).
- AI stays for the long tail and for genuinely novel senders (the "learning loop" is only valuable if it's the exception, not the rule).

## 3 · Target architecture (V8.1)

```
Outlook Trigger
 → Normalize Email           (extracts original-sender on forwards)
 → Already Processed?        (Data Table lookup by Message-ID)
 → Has Attachments?          (if no → Mail-only Context)
 → Get Attachments + Prep Attachment Meta
 → Attachment Type Switch    (xml | pdf | xlsx | text | image | universal)
 → Download + Extract …      (with retry 3× exp-backoff on 5xx)
 → Aggregate Attachment Context
 → Load Memory               (customer memory + feedback history)
 → Customer Router           ───┬─► Deterministic Mapper      (Tönnies, HPT, Ekro, Coomans, Tulling, FN, …)
                                └─► AI Agent + Structured Parser   (fallback)
 → Normalize → Validate → Qargo Payload
 → Upload to Qargo
 → Wait for Import → Get Import Status → Finalize Import
 → Import Status Check  ─┬─ok──► Store Memory → Track Processed (atomic) → Mark Read → Move to Client Folder
                         ├─review─► Move to Review → Track Processed
                         └─ignore─► Ignore Output → Track Processed → Mark Read
```

Key invariants:
1. **Track Processed is the last step**; it writes only after Mark Read / Move succeeded.
2. **Every Outlook mutation is retried** (3× exponential backoff, caps at 30 s).
3. **Customer Router is deterministic-first**. AI is only invoked when no customer key matches and memory has no template for the sender domain.
4. **Parser output is JSON-Schema validated** before upload. Invalid → Review gate, never Qargo.
5. **Qargo response is re-parsed**: 2xx + `{order_identifier: …}` is the only "success".

## 4 · Deliverables in this PR

- `ARCHITECTURE.md` (this file) — analysis + verdict + target architecture.
- `lib/common.js` — shared helpers: `normalizeEmail`, `originalSender`, `parseQty`, `parseWeight`, `parseDate`, `safeString`, `retryable`, `qargoPayloadSchema`, `validatePayload`.
- `lib/hpt.js` — H.P. Therkelsen PDF parser **with the Emstek business rule** fully implemented.
- `lib/customers.js` — deterministic mappers for Tönnies / Weidemark / Tevex, Ekro, Coomans / CTimport, Tulling, FN Global Meat, Carnimex, Ameco, Goedegebuur, Thermotraffic, Wetralog.
- `PATCHES.md` — for each node in both workflows: *keep* / *replace with ↴* / *delete*, with the exact Code-node body to paste.

The library files are drop-in **n8n Code node bodies**: paste the file contents into a Code node (Run Once per Item) and it works. That is why they are plain `.js` files, not a bundled NPM package — n8n Code nodes do not load external modules.

## 5 · HPT / H.P. Therkelsen business rule (spec)

From the HPT PDF: *"Please deliver it to your Emstek warehouse and we will load it Friday evening"*.

The delivery address in the order block is **not** the real Qargo delivery location. The real drop is **Agro World Emstek**. The original delivery address and the Emstek instruction both belong in `delivery_stop.note`, so the driver and planner see the full picture.

Per order block → exactly one Qargo order. Mapping:

| HPT field (PDF block) | Qargo field |
|---|---|
| `Orderno` | `order_identifier` + `customer_reference_number` |
| Loading address block | `pickup_stop.location` |
| Delivery address block (raw) | *kept verbatim* in `delivery_stop.note` |
| "deliver it to your Emstek warehouse" present? | `delivery_stop.location = AGROWORLD_EMSTEK` |
| "…load it Friday evening" | appended to `delivery_stop.note` |
| "DO NOT EXCHANGE PALLETS" if present | appended to `delivery_stop.instructions` and `note` |
| `Items/type` = "colli" | `goods.type = colli` |
| `Pall/Type` | `goods.quantity` + `goods.packaging` |
| `Grosswgt` | `goods.total_weight_kg` (unit normalized via `parseWeight`) |
| `Temperature` | `goods.temperature_c` (float, unit normalized) |

If the Emstek sentence is **absent**, we do NOT rewrite the delivery — we use the block's delivery address as-is. This is the single point where business logic diverges from a plain PDF-to-JSON parser.

See `lib/hpt.js` for the implementation.

## 6 · Operational risks covered

| Risk | Mitigation |
|---|---|
| Double-processing (both workflows running) | Deactivate `Orderimport` in n8n; single `Outlook Trigger` on the Inbox. |
| Duplicate Qargo orders on retry | `Track Processed` is the last write; idempotency key = Outlook `internetMessageId`. |
| Malformed AI JSON | JSON-Schema validation on the parser output; invalid → Review. |
| Graph API 5xx during download | `retryable()` wrapper, 3× exponential backoff, then Review. |
| HPT Emstek rule forgotten | Dedicated parser module + a unit-style assertion at the bottom of `lib/hpt.js`. |
| New customer appears | Falls through to AI + `Register New Customer`, then becomes a deterministic mapper on next iteration. |
