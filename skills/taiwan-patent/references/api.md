# TIPO open data API

Public patent-rights APIs. Docs: https://cloud.tipo.gov.tw/S220/opdata/api/file/api/patent

Query fields and result shape: [schema.json](schema.json). Prefer `scripts/lookup.sh --query '{...}'` over hand-rolled curl.

Token (`tk`) is the public key on data.gov.tw [30126](https://data.gov.tw/dataset/30126) (發明), [30125](https://data.gov.tw/dataset/30125) (新型), [30127](https://data.gov.tw/dataset/30127) (設計). Override with `TIPO_OPDATA_TK` if a request returns only sample data.

```
BASE=https://cloud.tipo.gov.tw/S220/opdataapi/api
TK=${TIPO_OPDATA_TK:-43b47d07-4795-45d9-819a-9c71c72e4105}
```

## Combine filters

TIPO ANDs different parameters and ORs repeated values joined by `|`. Put every known constraint on **one** URL. Do not send one request per name, number, or hit.

```sh
curl -fsS --get "$BASE/PatentRights" \
  --data-urlencode "format=json" --data-urlencode "tk=$TK" \
  --data-urlencode "applclass=2" \
  --data-urlencode "applnamec=申請人" \
  --data-urlencode "ipcfull=G08B21/10" \
  --data-urlencode "top=25"
```

`applclass` is required (`1` 發明, `2` 新型, `3` 設計) and is the only reason to repeat a call. Same-field OR: `patentno=M000001|M000002`. Raise `top` (max 5000) instead of looping `skip`. Skip `format=count` if you are about to fetch rows anyway.

`PatentRights` already includes `charge-expir-date`. Call `PatentAnnuity` only when the payment ledger is needed, and reuse the **same** filter set (still one extra request, not one per record).

## Other APIs (same `tk`)

| Service | Use |
| --- | --- |
| `PatentPriority` | 優先權 |
| `PatentDivide` | 分割 |
| `PatentAlteration` | 讓與/異動 |
| `PatentAppl` | 申請案 IPC / 國籍 |
| `PatentPub` | 發明公開案 |

Do not fan these out either. One filter object, one call.

## Official UIs

- 權證查詢: https://cloud.tipo.gov.tw/S220/cert/patentRights
- 年費試算: https://tiponet.tipo.gov.tw/S080WV1/#/estimate
- 規費清單: https://www.tipo.gov.tw/tw/patents/482.html
- 專利資訊檢索: https://tiponet.tipo.gov.tw/twpat3/twpatc/twpatkm

## Dead ends

- `patents.google.com` HTML / search often 503s automated clients.
- TIPO 權證查詢 is a React SPA; a reader only sees the empty form.
