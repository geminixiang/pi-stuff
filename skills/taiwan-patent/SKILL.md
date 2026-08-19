---
name: taiwan-patent
description: Look up Taiwan TIPO patents by certificate number, application number, applicant, inventor, agent, IPC, dates, or name. Use when the user asks about 專利, 證書號, 新型/發明/設計專利, TIPO, I/M/D numbers, fees, annuity status, or the specification.
---

# Taiwan patent

Look up Republic of China (Taiwan) patents through TIPO open data first. Do not start with Google Patents, Jina Search, or the TIPO SPA.

Read [references/schema.json](references/schema.json) `$defs.Query` before calling. Map the user request onto **one** Query object.

## 1. Build one Query

Infer `applclass` from the identifier when possible:

| Input | Kind | `applclass` |
| --- | --- | --- |
| `I` + digits | 發明 | `1` |
| `M` + digits | 新型 | `2` |
| `D` + digits | 設計 | `3` |
| 申請案號, 4th digit `1`/`2`/`3` | 申請案號 | that digit |
| 公開號 | 發明公開 | `1` |

Put **every** known filter on that one object (`applnamec` + `ipcfull` + date range + …). Same-field OR uses `|` (`patentno=M000001|M000002`). Do not emit one HTTP call per name, number, or record.

`applclass` is the only dimension that needs a second request: TIPO serves 發明/新型/設計 as separate datasets. Scan classes `1,2,3` only when class cannot be inferred.

**Complete when:** you have a Query that matches the schema.

## 2. Send as few HTTP calls as possible

From this skill directory:

```sh
./scripts/lookup.sh --query '{"patentno":"M000000"}'
./scripts/lookup.sh --query '{"applclass":2,"applnamec":"申請人","ipcfull":"G08B21/10"}'
./scripts/lookup.sh --schema
```

The script issues **at most one `PatentRights` and one `PatentAnnuity` per `applclass`**, with all filters on each URL. It does not page and does not N+1.

- Specific 證書號 / 申請案號 / 公告號 → default `service=both` (2 calls).
- Name / IPC / date search → default `service=rights` (1 call). `PatentRights` already has `charge-expir-date`. Add `"service":"both"` only if the user wants the payment ledger.
- Need more rows → raise `top` (max 5000) in the **same** Query. Do not loop `skip`.

**Complete when:** `total` is known. If `0`, say not found.

## 3. Read legal status

- `patent-bdate` / `patent-edate` — right start / statutory end
- `charge-expir-date` / `charge-expir-year` — paid through
- `annuity[]` — payment rows (only when `service=both`)
- `cancel-date` / `revoke-date` — explicit cancellation / revocation

If `charge-expir-date` is past and the 6-month grace period has also passed, the right is **消滅** even when `cancel-date` is null.

Fees: [references/fees.md](references/fees.md). Endpoint notes: [references/api.md](references/api.md).

**Complete when:** you can say in force, grace period, lapsed, or revoked.

## 4. Specification only if asked

1. Use fields already returned.
2. Google Patents PDF: `https://patents.google.com/patent/TW<cert><kind>` (`M`→`U`, `D`→`S`, `I`→no letter). HTML search is often blocked; the PDF host usually is not.
3. Scanned PDF: `pdftoppm -png -r 200 patent.pdf pages/pg` then `swift scripts/ocr.swift pages/pg-01.png`.

**Complete when:** the user has the facts they asked for.

## 5. Answer

Lead with certificate number, title, kind, applicant, dates, and whether it is still in force. Cite TIPO open data. Human UI: https://cloud.tipo.gov.tw/S220/cert/patentRights
