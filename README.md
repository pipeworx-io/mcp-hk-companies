# @pipeworx/hk-companies

Hong Kong Companies Registry (香港公司註冊處) open data — a live feed of
companies newly incorporated, registered, or renamed on the register, with a
name/BR-number search and an HKEX ticker join.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `hk_company_search({ name?, brn?, type?, since?, limit? })` — search by
  company name (English or Chinese, substring) or exact BR number. Returns BR
  number, English/Chinese name, type, incorporation/registration date, any
  name-change date, and the matching HKEX ticker when the name resolves to a
  listed stock.
- `hk_company({ brn, since? })` — look up one company's full history (initial
  incorporation/registration + any renames) by BR number.
- `hk_new_companies({ since?, type?, limit? })` — companies newly incorporated
  or registered since a date, most recent first.
- `hk_company_name_changes({ since?, limit? })` — companies that changed their
  registered name since a date, most recent first.

## Auth

Keyless. `data.gov.hk` and `cr.gov.hk` are public, unauthenticated open data.

## Data source — verified live 2026-09-07

The Companies Registry's open-data landing page (`cr.gov.hk/en/open-data/`) is
404 and `data.gov.hk`'s own HTML dataset listing is client-rendered (zero
`<a href>`s in the page source), so the real resource URLs come only from
`data.gov.hk`'s CKAN-style API, found via its org slug for the Registry:

```
https://data.gov.hk/en-data/api/3/action/organization_show?id=hk-cr
https://data.gov.hk/en-data/api/3/action/package_show?id=hk-cr-crdata-list-newly-registered-companies-2526
```

That package lists ~350 weekly CSV resource pairs, one per week since
2024-12-30:

- `https://www.cr.gov.hk/docs/wrpt/RNC063/RNC063L_YYYYMMDD.csv` — Hong Kong
  local companies (newly incorporated / re-domiciled / renamed)
- `https://www.cr.gov.hk/docs/wrpt/RNC063/RNC063F_YYYYMMDD.csv` — non-Hong
  Kong companies (newly registered / re-domiciled / renamed)

`YYYYMMDD` is the Monday of the covered week; each file covers that Monday
through the following Sunday. Publication runs roughly a week behind (the
24-30 Aug 2026 week was published 2 Sep).

This pack fetches the live resource list from `package_show` on every call
(no guessed URL pattern), then only fetches the CSV weeks that can contain a
match, in parallel, bounded to 20 weeks per company type per call so one
request can't fan out into hundreds of upstream fetches. `hk_company_search`
and `hk_company` default to a 12-week lookback unless `since` is given (as
far back as `2024-12-30`, the dataset start); `hk_new_companies` and
`hk_company_name_changes` default to the 7 days before the latest published
week.

### CSV shapes (they differ — verified from a live fetch of both)

Local (`RNC063L`): `Seq, Current Company Name in English, Current Company
Name in Chinese, BR Number, Date of Incorporation / Re-domiciliation Date,
Date of Change of name` — English and Chinese are already separate columns.

Non-HK (`RNC063F`): `Seq, Current Corporate Name / Other Corporate Name,
Current Approved Name for Carrying on Business in H.K., BR Number, Date of
Registration, Date of Change of name` — there is **no separate Chinese-name
column**. A non-HK company with both an English and a Chinese name gets two
physical rows sharing the same BR number and Seq, one name per row in the
single "Current Corporate Name / Other Corporate Name" column. This pack
merges those pairs by BR number (routing CJK text to `name_zh`, everything
else to `name_en`) rather than surfacing them as two different companies.

## Scope limit — found during research, not assumed

This is the **only** company-level open dataset the Companies Registry
publishes. Its other three `data.gov.hk` packages under org `hk-cr`
(`crdata-stat-non-hk-companies`, `crdata-stat-local-companies-incorporated`,
`crdata-stat-local-companies`) are aggregate **monthly counts** (public /
private / guarantee company totals), not per-company records — checked live,
they carry no name, BR number, or address fields. `data.gov.hk`'s org for the
Inland Revenue Department (`hk-ird`) publishes **zero** datasets, so Business
Registration data has no open API either.

There is **no open, keyless API that returns a company's registered address
or status** for an arbitrary Hong Kong company. That is the Companies
Registry's paid Cyber Search Centre (ICRIS) product — a per-document
commercial search, not open data. So:

- This pack can resolve a **name or BR number** for anything newly
  incorporated, registered, or renamed since **2024-12-30**.
- It **cannot** answer "what is the registered address of `<any company>`"
  for a company outside that window (most established companies, including
  every HKEX-listed blue chip) — there is genuinely no open source for that.
  Every tool description says so rather than let a caller assume more than
  the data supports.
- Money-lender and TCSP-licensee registers were in scope per the original
  ask; neither exists as an open dataset on `data.gov.hk` (checked: zero
  results searching "money lender", "TCSP", "trust company", "licensed money
  lenders" against the CKAN API) — not built.

## HKEX ticker join

`hk_company_search` and `hk_company` call the same keyless Yahoo Finance
search endpoint `@pipeworx/hk-stocks`'s `hk_resolve_symbol` uses (called
directly here, not cross-pack, since packs don't call each other at
runtime), restricted to `.HK`-suffixed symbols, and only attach a ticker on a
normalized exact-name match (stripping "Limited"/"Ltd"/"Co"/"Holdings"/
"Group" and non-alphanumerics) — never a fuzzy guess. In practice this fires
rarely: a company appearing in this feed was newly incorporated, registered,
or renamed in the last ~20 months, and HKEX-listed companies are almost
always older than that.

## Data lag

The feed publishes roughly a week behind. A `since` date newer than the
latest published week returns `count: 0` with a `data_lag_note` field
explaining that this is publication lag, not "no new companies" — check that
field before reading a zero as a clean result.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hk-companies": {
      "url": "https://gateway.pipeworx.io/hk-companies/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/hk-companies/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/hk_company_search \
  -H 'Content-Type: application/json' \
  -d '{"name":"HSBC"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/hk_company_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "hk-companies": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-hk-companies"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-hk-companies
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Hk Companies data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
