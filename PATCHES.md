# PATCHES – How to apply this rebuild to the n8n workflows

Each entry below is a concrete action on a node that exists in one of the two
workflow JSONs.  Actions: **KEEP** / **REPLACE-WITH** / **DELETE** /
**INSERT-AFTER** / **RE-WIRE**.

The library files referenced (e.g. `lib/common.js`) are *drop-in n8n Code node
bodies* – paste the file contents into the Code node. Mode = "Run Once for All
Items". No external NPM modules required.

---

## A · Orderimport(4).json — **RETIRE**

Rationale: see `ARCHITECTURE.md §1.1 & §1.3`. This workflow double-processes
every mail V8 already handles, and it has no dedup or retry.

Action plan:

1. **Deactivate** the workflow in n8n (toggle OFF in the UI). Do *not* delete
   for 14 days – keep a safety net while the V8.1 migration bakes in.
2. Ensure V8.1 (patched below) is Active and that its Outlook Trigger points to
   the same Inbox folder(s) that Orderimport was polling.
3. After 14 days of clean V8.1 runs (spot-check the Data Table and Review
   folder daily), delete Orderimport.

Before deactivation, move any customer whose deterministic mapper exists only
in Orderimport into `lib/customers.js`. Current coverage:

| Customer | Orderimport branch | Now in `lib/customers.js`? |
|---|---|---|
| FN Global Meat | `Get Attachments (FN Gobal)` + XML chain | ✅ `mapFnGlobal` |
| Tönnies / Weidemark / Tevex | XML branches (`Filter XML Files`) | ✅ `mapTonnies` |
| Coomans / CTimport | `Get Attachments (coomans)` + PDF | ✅ `mapCoomans` |
| Tulling | `Qargo XML Tulling` | ✅ `mapTulling` |
| Ekro | `Get Attachments (Ekro)` + XLSX | ✅ `mapEkro` |
| Carnimex | `Get Attachments (Carnimex)` + PDF | ✅ `mapCarnimex` |
| Ameco | `Ameco` sticky + PDF | ✅ `mapAmeco` |
| Goedegebuur | `Goedegebuur` branch | ✅ `mapGoedegebuur` |
| Thermotraffic | `Thermotraffic` branch | ✅ `mapThermotraffic` |
| Wetralog | `Wetralog` + `Wetralog extract` | ✅ `mapWetralog` |
| HPT / H.P. Therkelsen | *missing in both workflows* | ✅ `lib/hpt.js` (new) |

No Orderimport branch is lost.

---

## B · Agro World AI Order Intake Agent V8.0.2.json — **PATCH TO V8.1**

Apply in order. Every change is a node-level edit in the n8n UI; no JSON
surgery required.

### B.1 Trigger & first steps

| Node | Action | Detail |
|---|---|---|
| `Outlook Trigger` | KEEP | Ensure polling interval ≤ 2 min and `includeResourceData = true`. |
| `Normalize Email` | REPLACE-WITH `lib/normalize_email.js` | Old node only copied fields; new one extracts original sender from forwards. |
| `Already Processed?` | REPLACE-WITH `lib/dedupe.js` + **INSERT-BEFORE** a `Data Table → Search Rows` node keyed on `internetMessageId` producing `processed_hits[]`. | The old IF only compared subjects – unreliable. |
| `Has Attachments?` | KEEP | IF on `mail.hasAttachments`. |
| `Mail-only Context` | KEEP | For attachment-less mails. |

### B.2 Attachment pipeline

| Node | Action | Detail |
|---|---|---|
| `Get Attachments` | KEEP | |
| `Prep Attachment Meta` | KEEP | |
| `Attachment Type Switch` | KEEP | |
| `Download XML` / `Download PDF` / `Download XLSX` / `Download Text` / `Download Image` / `Download Universal` | RE-WIRE | Wrap each in a `Retry On Fail` (n8n built-in, Max 3, Wait Between = 5 s). Previously no retry → transient Graph 5xx drops mails. |
| `Extract XML` / `Extract PDF` / `Extract XLSX` | KEEP | |
| `XML Context` / `PDF Context` / `XLSX Context` / etc. | KEEP | |
| `Aggregate Attachment Context` | KEEP | |

### B.3 Memory and routing

| Node | Action | Detail |
|---|---|---|
| `Load Memory` | KEEP | Continues to hydrate per-sender templates. |
| `Customer Router` | REPLACE-WITH `lib/customers.js` | **Main change.** Deterministic mappers run first for Tönnies / Ekro / Coomans / Tulling / FN / Carnimex / Ameco / Goedegebuur / Thermotraffic / Wetralog. Falls through to `needs_ai: true` only when no rule matches or the mapper returns empty. |
| `Tönnies Mapper` | DELETE | Its logic is now inside `lib/customers.js → mapTonnies`, with the same normalization rules. |
| `Address Lookup Tool` | KEEP | Still used by the AI Agent as a tool. |
| `Build AI Prompt` | EDIT | Cap `attachment context` at 12 000 chars per attachment and 40 000 total. Add sentence: *"Return JSON matching the schema exactly. Do not invent addresses. If any required field is missing, set `needs_review: true`."* |
| `AI Agent` | KEEP | Claude model via Anthropic account. |
| `Claude Model` | KEEP | `claude-opus-4-7` is fine; if cost matters, switch the tool-use path to `claude-sonnet-4-6`. |
| `Structured Parser Tool` | EDIT | Tighten the JSON Schema to mirror `lib/common.js → buildQargoPayload`. |
| `Parse AI Result` | EDIT | Add try/catch; on `JSON.parse` error set `needs_review: true` with `review_reason: 'ai_parse_error'`. |

### B.4 HPT branch (new)

INSERT a dedicated mini-branch upstream of `Customer Router`:

```
PDF Context ──► IF (customer === 'HPT')
                 │ true  → lib/hpt.js  ─► Customer Router (bypass, already has qargo_payload)
                 │ false → Customer Router
```

Implementation:

1. Add an `IF` node after `PDF Context` named `Is HPT?` with condition
   `{{ $json.mail.originalSender }}` matches `/@(hpt\.dk|therkelsen\.)/i` or
   subject contains `H.P. Therkelsen`.
2. Add a `Code` node named `HPT Parser` with body = `lib/hpt.js`.
3. Wire: `Is HPT?` (true) → `HPT Parser` → `Customer Router`.
4. The `Customer Router` Code (`lib/customers.js`) already bypasses when
   `qargo_payload` is present, so HPT items flow straight to `Upload to Qargo`.

### B.5 Upload & status

| Node | Action | Detail |
|---|---|---|
| `New Customer?` | KEEP | |
| `Register New Customer` | KEEP | |
| `Manual Review Gate` | KEEP | Fires on `needs_review === true`. |
| `Ignore Gate` | KEEP | |
| `Upload to Qargo` | RE-WIRE | Add `Retry On Fail` (Max 3, Wait 3 s). |
| `Validate Upload` | REPLACE-WITH `lib/validate_upload.js` | Old node only checked HTTP. New one also verifies `order_identifier` echo. |
| `Upload Accepted?` | EDIT | IF branches on `$json.upload_ok` (was mixed bag). |
| `Wait for Import` | KEEP | 30 s is correct. |
| `Get Import Status` | KEEP | |
| `Finalize Import` | REPLACE-WITH `lib/finalize.js` | Deterministic outcome router: `upload` / `review` / `ignore`. |
| `Import Status Check` | EDIT | Branch on `$json.outcome`. |

### B.6 Post-processing (idempotency fix)

**Previous order was `Store Memory → Track Processed → Mark Read → Move to Folder`.**
Problem: if Mark Read or Move fails, we never retry because Track Processed
already wrote.

**New order:** `Store Memory → Mark Read → Move to Client Folder → Track Processed`.

| Node | Action |
|---|---|
| `Store Memory` | KEEP, but move in the flow to run before `Mark Mail Read`. |
| `Mark Mail Read` | RE-WIRE; add `Retry On Fail` (3×, 5 s). |
| `Move to Client Folder` | RE-WIRE; add `Retry On Fail` (3×, 5 s). If both succeed → proceed. If either 404s (folder missing) → fall through to a new `Create Client Folder` node (uses the `customer` field to build the folder name) and retry once. |
| `Track Processed` | **Make this the LAST write.** Wire it after `Move to Client Folder`. This is the single place that writes `processed_at` to the Data Table. Idempotency key = `mail.internetMessageId`. |

For the `review` and `ignore` outcomes:

```
review : Move to Review  → Track Processed
ignore : Mark Mail Read  → Track Processed
```

### B.7 Feedback loop

| Node | Action |
|---|---|
| `Is Feedback?` | KEEP |
| `Store Feedback` | KEEP |
| `Download EML` / `Fix EML Format` / `Upload EML to Qargo` / `Log EML Upload` | KEEP — this is the attachment-to-Qargo debug trail. |

### B.8 Deprecations inside V8

| Node | Action |
|---|---|
| `Note V7`, `V8 Changelog`, stray sticky notes | KEEP (documentation). |
| `Tönnies Mapper` | DELETE (replaced by `lib/customers.js → mapTonnies`). |
| Any unlinked AI Transform leftovers | DELETE. |

---

## C · Smoke test after patching

1. **Self-test the HPT parser locally**
   *(only if you have Node on your laptop; optional)*
   `node lib/hpt.js` — the asserts at the bottom should print `HPT parser self-test OK`.

2. **Run V8.1 in n8n with "Test workflow"** against a captured Outlook event
   for each customer in `CUSTOMER_RULES`. Expected:
   - deterministic mapper hit (no AI call in the execution log)
   - `upload_ok === true`
   - `outcome === 'upload'`
   - Mail moved to the matching client folder, marked read, Data Table row
     written with `processed_at`.

3. **Run one novel sender** through — should fall through to the AI Agent,
   `Register New Customer` should fire, and the next run from that sender
   should be deterministic (assuming a template was added).

4. **Kill one Graph API call mid-flow** (use the "disable node" toggle on a
   download step for one run) to prove:
   - Mail is NOT moved to `Order Succesvol`.
   - Mail is NOT in the Data Table.
   - Next execution retries the same mail.

---

## D · Repository layout

```
/
├── ARCHITECTURE.md              ← analysis + verdict
├── PATCHES.md                   ← this file
├── lib/
│   ├── common.js                ← shared helpers (drop-in Code node)
│   ├── normalize_email.js       ← first Code node after Outlook Trigger
│   ├── dedupe.js                ← Already Processed? gate
│   ├── customers.js             ← Customer Router (deterministic mappers)
│   ├── hpt.js                   ← H.P. Therkelsen PDF parser + Emstek rule
│   ├── validate_upload.js       ← Qargo response validation
│   └── finalize.js              ← outcome router (upload / review / ignore)
├── Agro World AI Order Intake Agent V8.0.2.json   ← source workflow (unchanged)
└── Orderimport(4).json                             ← legacy workflow (to retire)
```
