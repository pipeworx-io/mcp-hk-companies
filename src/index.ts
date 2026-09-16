interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Hong Kong Companies Registry (香港公司註冊處) — open incorporation/name-change
 * feed via data.gov.hk (keyless).
 *
 * SOURCE, VERIFIED LIVE 2026-09-07 (data.gov.hk's own CKAN-style API — the
 * dataset listing page at cr.gov.hk/en/open-data/ is 404 and data.gov.hk's own
 * HTML listing is client-rendered, so the real resource URLs come only from
 * the CKAN API, not from guessing or scraping the page):
 *
 *   Package: https://data.gov.hk/en-data/api/3/action/package_show?id=hk-cr-crdata-list-newly-registered-companies-2526
 *   (found via https://data.gov.hk/en-data/api/3/action/organization_show?id=hk-cr,
 *   the Companies Registry's org slug on data.gov.hk)
 *
 * That package lists ~350 weekly CSV resources, one pair per week since
 * 2024-12-30: RNC063L_YYYYMMDD.csv (Hong Kong local companies — newly
 * incorporated/re-domiciled, or renamed) and RNC063F_YYYYMMDD.csv (non-Hong
 * Kong companies — newly registered/re-domiciled, or renamed), e.g.
 *   https://www.cr.gov.hk/docs/wrpt/RNC063/RNC063L_20260824.csv
 * Columns (verified from a live fetch): Seq, Current Company Name in English,
 * Current Company Name in Chinese, BR Number, Date of Incorporation /
 * Re-domiciliation Date, Date of Change of name.
 *
 * IMPORTANT SCOPE LIMIT, found during research, not assumed: this is the
 * Companies Registry's ONLY open-data set with individual company records.
 * The other 3 packages under org hk-cr (statistics_01/02/03) are aggregate
 * monthly counts, not company-level. There is no open, keyless API that
 * returns a company's REGISTERED ADDRESS or STATUS for an arbitrary company —
 * that is the Companies Registry's paid Cyber Search Centre (ICRIS) product,
 * not open data, and IRD's Business Registration database has no open API
 * either (checked: package_search finds zero datasets under org hk-ird).
 * So this pack can resolve a company NAME/BR-number for anything newly
 * incorporated, registered, or renamed since 2024-12-30 — it CANNOT answer
 * "what is the registered address of <any company>" for companies outside
 * that window (e.g. long-established ones). Every tool description below
 * says so; do not let a caller assume more than the data supports.
 *
 * Fetch strategy: the weekly resource list is read fresh from data.gov.hk's
 * package_show on every call (small JSON, no local cache — Workers module
 * scope must not cache a Date-sensitive value, see fleet runtime notes), then
 * only the CSV weeks that can contain a match are fetched, in parallel,
 * bounded by MAX_WEEKS_PER_TYPE so one request can't fan out into hundreds of
 * upstream fetches.
 */


const UA = 'pipeworx-mcp-hk-companies/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, init: RequestInit, label: string): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, label);
}

const PACKAGE_SHOW_URL =
  'https://data.gov.hk/en-data/api/3/action/package_show?id=hk-cr-crdata-list-newly-registered-companies-2526';

// Bounds on how many weekly CSVs one tool call will fetch, so a wide `since`
// can't fan out into hundreds of upstream requests in a single call.
const MAX_WEEKS_PER_TYPE = 20;
const DEFAULT_LOOKBACK_WEEKS = 12;
const DATASET_START = '2024-12-30';

const tools: McpToolExport['tools'] = [
  {
    name: 'hk_company_search',
    description:
      'Search Hong Kong companies newly incorporated, registered, or renamed on the Companies Registry (香港公司註冊處, cr.gov.hk) since 30 Dec 2024 — official open data via data.gov.hk, updated weekly. Match by company name (English or Chinese, substring, case-insensitive) or an exact Business Registration (BR) number. Returns each match\'s BR number, English and Chinese name, company type (Hong Kong local / non-Hong Kong), incorporation-or-registration date, and any name-change date, plus the matching HKEX ticker when the name resolves to a listed stock (joined via the same Yahoo Finance lookup hk_resolve_symbol uses — only attached on a confident name match, never guessed). LIMITATION: this only covers companies newly incorporated, registered, or renamed since 2024-12-30 — it is NOT the full historical company register and does NOT return registered address or company status for companies outside that window (Hong Kong publishes no open API for those; only the Companies Registry\'s paid Cyber Search Centre does). Use for "is there a new HK company called X", "HK BR number for Y", "香港新註冊公司 X".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Company name substring, English or Chinese, e.g. "HSBC" or "滙豐". Case-insensitive.' },
        brn: { type: 'string', description: 'Exact Business Registration (BR) number, e.g. "81129706".' },
        type: { type: 'string', enum: ['local', 'non_hk'], description: 'Restrict to Hong Kong local companies ("local") or non-Hong Kong companies registered in HK ("non_hk"). Omit to search both.' },
        since: { type: 'string', description: 'Only search weeks on/after this date (YYYY-MM-DD). Default: last 12 weeks. Earliest possible: 2024-12-30 (the dataset start).' },
        limit: { type: ['number', 'string'], description: 'Max matches to return, 1-100 (default 25).' },
      },
    },
  },
  {
    name: 'hk_company',
    description:
      'Look up a single Hong Kong company by its exact Business Registration (BR) number in the Companies Registry\'s open incorporation/name-change feed (data.gov.hk, weekly, since 2024-12-30). Returns every appearance of that BR number in the feed — its initial incorporation/registration and any later name change — with the English/Chinese name at each point, company type, and the matching HKEX ticker if it resolves to a listed stock. Returns found:false if the BR number never appears in the feed, which most often means the company pre-dates 2024-12-30 (nothing was wrong — the feed genuinely has no earlier data) or the number is not a real HK BR number. DOES NOT return registered address or company status — Hong Kong has no open API for those (香港公司註冊地址 is not published as open data; the Companies Registry\'s paid Cyber Search Centre is the only source).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        brn: { type: 'string', description: 'Exact Business Registration (BR) number, e.g. "81129706".' },
        since: { type: 'string', description: 'Search back only to this date (YYYY-MM-DD) instead of the default 12-week lookback. Use 2024-12-30 to search the entire feed (fetches more weeks, slower).' },
      },
      required: ['brn'],
    },
  },
  {
    name: 'hk_new_companies',
    description:
      'Companies newly incorporated (Hong Kong local) or newly registered/re-domiciled (non-Hong Kong) on the Companies Registry since a given date — the official weekly open-data feed via data.gov.hk (新註冊/新成立公司, since 2024-12-30). Returns each company\'s BR number, English/Chinese name, type, and incorporation-or-registration date, most recent first. The feed has roughly a 1-week publication lag, so a `since` newer than the latest published week returns zero rows with a `data_lag_note` explaining it — that is lag, not "no new companies". Use for "new Hong Kong companies this week", "companies incorporated in HK since <date>".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Only include companies incorporated/registered on/after this date (YYYY-MM-DD). Default: 7 days before the latest published week.' },
        type: { type: 'string', enum: ['local', 'non_hk'], description: 'Restrict to Hong Kong local companies ("local") or non-Hong Kong companies ("non_hk"). Omit for both.' },
        limit: { type: ['number', 'string'], description: 'Max companies to return, 1-200 (default 50).' },
      },
    },
  },
  {
    name: 'hk_company_name_changes',
    description:
      'Hong Kong companies that changed their registered name, per the Companies Registry\'s weekly open-data feed (data.gov.hk, 公司名稱變更, since 2024-12-30). Returns each company\'s BR number, current English/Chinese name, and the date of the name change, most recent first. The feed has roughly a 1-week publication lag, so a `since` newer than the latest published week returns zero rows with a `data_lag_note` explaining it — that is lag, not "no name changes". Use for "Hong Kong companies that changed their name since <date>", "HK company renames this month".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Only include name changes on/after this date (YYYY-MM-DD). Default: 7 days before the latest published week.' },
        limit: { type: ['number', 'string'], description: 'Max name changes to return, 1-200 (default 50).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'hk_company_search':
        return await companySearch(args);
      case 'hk_company':
        return await companyLookup(args);
      case 'hk_new_companies':
        return await newCompanies(args);
      case 'hk_company_name_changes':
        return await nameChanges(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Resource discovery (data.gov.hk CKAN API)
// ---------------------------------------------------------------------------

interface WeekResource {
  type: 'local' | 'non_hk';
  weekStart: string; // YYYY-MM-DD, Monday
  weekEnd: string; // YYYY-MM-DD, weekStart + 6 days
  url: string;
}

async function listWeekResources(): Promise<WeekResource[]> {
  const label = 'data.gov.hk CKAN API (Companies Registry package)';
  const res = await pwFetch(PACKAGE_SHOW_URL, { headers: { Accept: 'application/json' } }, label);
  if (!res.ok) throw await httpError(res, label);
  const data = await parseJson<{ success?: boolean; result?: { resources?: Array<{ format?: string; url?: string }> } }>(res, label);
  if (!data.success || !data.result?.resources) throw new Error(`${label}: response had no resources`);

  const out: WeekResource[] = [];
  for (const r of data.result.resources) {
    if (!r.url || (r.format ?? '').toUpperCase() !== 'CSV') continue;
    const m = r.url.match(/RNC063([LF])_(\d{4})(\d{2})(\d{2})\.csv$/i);
    if (!m) continue;
    const type: 'local' | 'non_hk' = m[1].toUpperCase() === 'L' ? 'local' : 'non_hk';
    const weekStart = `${m[2]}-${m[3]}-${m[4]}`;
    const weekEnd = isoAddDays(weekStart, 6);
    out.push({ type, weekStart, weekEnd, url: r.url });
  }
  // Most recent first.
  out.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
  return out;
}

interface WeekSelection {
  weeks: WeekResource[];
  truncated: boolean;
  latest_week_available: string | null;
  earliest_week_searched: string | null;
}

function selectWeeks(
  all: WeekResource[],
  opts: { since?: string; type?: 'local' | 'non_hk'; maxPerType?: number; defaultLookbackWeeks?: number },
): WeekSelection {
  const maxPerType = opts.maxPerType ?? MAX_WEEKS_PER_TYPE;
  let pool = opts.type ? all.filter((w) => w.type === opts.type) : all;
  const latest_week_available = pool.length ? pool[0].weekStart : null;

  let matching: WeekResource[];
  if (opts.since) {
    matching = pool.filter((w) => w.weekEnd >= opts.since!);
  } else {
    const lookback = opts.defaultLookbackWeeks ?? DEFAULT_LOOKBACK_WEEKS;
    // Default lookback applies per type, so take the N most recent of each type.
    const byType: Record<string, WeekResource[]> = {};
    for (const w of pool) (byType[w.type] ??= []).push(w);
    matching = Object.values(byType).flatMap((ws) => ws.slice(0, lookback));
  }
  matching.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));

  // Cap per type to bound total upstream fetches.
  const byType: Record<string, WeekResource[]> = {};
  for (const w of matching) (byType[w.type] ??= []).push(w);
  let truncated = false;
  const weeks: WeekResource[] = [];
  for (const arr of Object.values(byType)) {
    if (arr.length > maxPerType) truncated = true;
    weeks.push(...arr.slice(0, maxPerType));
  }
  weeks.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));

  return {
    weeks,
    truncated,
    latest_week_available,
    earliest_week_searched: weeks.length ? weeks[weeks.length - 1].weekStart : null,
  };
}

// ---------------------------------------------------------------------------
// Row fetching / parsing
// ---------------------------------------------------------------------------

interface CrRow {
  brn: string;
  name_en: string;
  name_zh: string | null;
  type: 'local' | 'non_hk';
  incorporation_date: string | null;
  name_change_date: string | null;
  source_week: string;
}

const CJK_RE = /[一-鿿]/;

// The two CSV shapes differ, verified from a live fetch of both:
//   Local (RNC063L):    Seq, Current Company Name in English,
//                        Current Company Name in Chinese, BR Number,
//                        Date of Incorporation / Re-domiciliation Date,
//                        Date of Change of name
//   Non-HK (RNC063F):   Seq, Current Corporate Name / Other Corporate Name,
//                        Current Approved Name for Carrying on Business in
//                        H.K., BR Number, Date of Registration,
//                        Date of Change of name
// Non-HK companies with both an English and a Chinese name get TWO physical
// rows sharing the same BR number and Seq, one per script, in the single
// "Current Corporate Name / Other Corporate Name" column — there is no
// separate Chinese-name column to read. Those pairs are merged by BR number
// below rather than treated as two different companies.
async function fetchWeekRows(w: WeekResource): Promise<CrRow[]> {
  const res = await pwFetch(w.url, { headers: { Accept: 'text/csv,text/plain,*/*' } }, 'HK Companies Registry weekly CSV (cr.gov.hk)');
  if (!res.ok) return [];
  const csv = await res.text();
  const table = parseCsv(csv);
  if (table.length < 2) return [];
  const header = table[0].map((h) => h.trim().toLowerCase());
  const idx = (want: string) => header.findIndex((h) => h.includes(want));
  const iBrn = idx('br number');
  const iChange = idx('change of name');

  const iNameEnSplit = idx('name in english');
  const iNameZhSplit = idx('name in chinese');
  const iIncorpSplit = idx('incorporation');

  if (iNameEnSplit !== -1) {
    // Local-company shape: English and Chinese are already separate columns.
    const out: CrRow[] = [];
    for (let r = 1; r < table.length; r++) {
      const row = table[r];
      if (!row.length || row.every((c) => !c.trim())) continue;
      const brn = cell(row, iBrn);
      if (!brn) continue;
      out.push({
        brn,
        name_en: cell(row, iNameEnSplit),
        name_zh: cell(row, iNameZhSplit) || null,
        type: w.type,
        incorporation_date: toIso(cell(row, iIncorpSplit)),
        name_change_date: toIso(cell(row, iChange)),
        source_week: w.weekStart,
      });
    }
    return out;
  }

  // Non-HK-company shape: one mixed-script name column, up to two rows per BRN.
  const iNameMixed = idx('corporate name');
  const iRegistration = idx('registration');
  const merged = new Map<string, CrRow>();
  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    if (!row.length || row.every((c) => !c.trim())) continue;
    const brn = cell(row, iBrn);
    if (!brn) continue;
    const name = cell(row, iNameMixed);
    const incorp = toIso(cell(row, iRegistration));
    const change = toIso(cell(row, iChange));
    const existing = merged.get(brn) ?? {
      brn,
      name_en: '',
      name_zh: null,
      type: w.type,
      incorporation_date: null,
      name_change_date: null,
      source_week: w.weekStart,
    };
    if (CJK_RE.test(name)) existing.name_zh = existing.name_zh ?? name;
    else if (!existing.name_en) existing.name_en = name;
    existing.incorporation_date = existing.incorporation_date ?? incorp;
    existing.name_change_date = existing.name_change_date ?? change;
    merged.set(brn, existing);
  }
  return [...merged.values()];
}

async function fetchRowsForWeeks(weeks: WeekResource[]): Promise<CrRow[]> {
  const settled = await Promise.allSettled(weeks.map(fetchWeekRows));
  const out: CrRow[] = [];
  for (const s of settled) if (s.status === 'fulfilled') out.push(...s.value);
  return out;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function companySearch(args: Record<string, unknown>): Promise<unknown> {
  const name = strArg(args.name);
  const brn = strArg(args.brn);
  if (!name && !brn) return { error: 'Provide at least one of: name, brn.' };
  const type = typeArg(args.type);
  const since = dateArg(args.since);
  const limit = clampLimit(args.limit, 25, 100);

  const all = await listWeekResources();
  const sel = selectWeeks(all, { since, type });
  const rows = await fetchRowsForWeeks(sel.weeks);

  let matched = rows;
  if (brn) matched = matched.filter((r) => r.brn === brn);
  if (name) {
    const q = name.toLowerCase();
    matched = matched.filter((r) => r.name_en.toLowerCase().includes(q) || (r.name_zh ?? '').includes(name));
  }
  // De-dupe by BR number, keeping the most recent appearance (renames create
  // two rows for the same company across different weeks).
  const byBrn = new Map<string, CrRow>();
  for (const r of matched) {
    const existing = byBrn.get(r.brn);
    if (!existing || r.source_week > existing.source_week) byBrn.set(r.brn, r);
  }
  const deduped = [...byBrn.values()].sort((a, b) => (a.source_week < b.source_week ? 1 : -1));
  const page = deduped.slice(0, limit);

  const companies = await Promise.all(
    page.map(async (r) => ({
      brn: r.brn,
      name_en: r.name_en,
      name_zh: r.name_zh,
      type: r.type,
      incorporation_date: r.incorporation_date,
      name_change_date: r.name_change_date,
      hkex: await tryResolveTicker(r.name_en),
    })),
  );

  return {
    source: 'HK Companies Registry (cr.gov.hk) — weekly open-data feed via data.gov.hk',
    scope: 'Only companies newly incorporated, registered, or renamed since 2024-12-30. Not the full historical register; no registered address or status.',
    query: { name: name ?? null, brn: brn ?? null, type: type ?? null },
    weeks_searched: sel.weeks.length,
    earliest_week_searched: sel.earliest_week_searched,
    latest_week_available: sel.latest_week_available,
    truncated: sel.truncated,
    matched: deduped.length,
    count: companies.length,
    companies,
  };
}

async function companyLookup(args: Record<string, unknown>): Promise<unknown> {
  const brn = strArg(args.brn);
  if (!brn) return { error: 'brn is required.' };
  const since = dateArg(args.since);

  const all = await listWeekResources();
  const sel = selectWeeks(all, { since, maxPerType: since ? MAX_WEEKS_PER_TYPE * 2 : undefined });
  const rows = await fetchRowsForWeeks(sel.weeks);
  const appearances = rows
    .filter((r) => r.brn === brn)
    .sort((a, b) => (a.source_week < b.source_week ? -1 : 1));

  if (!appearances.length) {
    return {
      source: 'HK Companies Registry (cr.gov.hk) — weekly open-data feed via data.gov.hk',
      brn,
      found: false,
      weeks_searched: sel.weeks.length,
      earliest_week_searched: sel.earliest_week_searched,
      message:
        'This BR number does not appear in the incorporation/name-change feed for the weeks searched. It most likely pre-dates 2024-12-30 (the feed has no earlier data) — Hong Kong publishes no open API for a company\'s registered address or status; only the Companies Registry\'s paid Cyber Search Centre has it. Pass since=2024-12-30 to search the entire feed.',
    };
  }
  const latest = appearances[appearances.length - 1];
  return {
    source: 'HK Companies Registry (cr.gov.hk) — weekly open-data feed via data.gov.hk',
    brn,
    found: true,
    current_name_en: latest.name_en,
    current_name_zh: latest.name_zh,
    type: latest.type,
    hkex: await tryResolveTicker(latest.name_en),
    history: appearances.map((r) => ({
      week: r.source_week,
      name_en: r.name_en,
      name_zh: r.name_zh,
      incorporation_date: r.incorporation_date,
      name_change_date: r.name_change_date,
    })),
    note: 'No registered address or company status — not published as open data.',
  };
}

async function newCompanies(args: Record<string, unknown>): Promise<unknown> {
  const type = typeArg(args.type);
  const limit = clampLimit(args.limit, 50, 200);

  const all = await listWeekResources();
  const latest = all.length ? all[0].weekStart : null;
  const since = dateArg(args.since) ?? (latest ? isoAddDays(latest, -7) : DATASET_START);
  const sel = selectWeeks(all, { since, type });
  const rows = await fetchRowsForWeeks(sel.weeks);

  const matched = rows
    .filter((r) => r.incorporation_date && r.incorporation_date >= since)
    .sort((a, b) => (a.incorporation_date! < b.incorporation_date! ? 1 : -1));

  return {
    source: 'HK Companies Registry (cr.gov.hk) — weekly open-data feed via data.gov.hk',
    since,
    weeks_searched: sel.weeks.length,
    latest_week_available: sel.latest_week_available,
    truncated: sel.truncated,
    matched: matched.length,
    count: Math.min(matched.length, limit),
    companies: matched.slice(0, limit).map((r) => ({
      brn: r.brn,
      name_en: r.name_en,
      name_zh: r.name_zh,
      type: r.type,
      incorporation_date: r.incorporation_date,
    })),
    ...dataLagNote(since, sel.latest_week_available),
  };
}

async function nameChanges(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampLimit(args.limit, 50, 200);

  const all = await listWeekResources();
  const latest = all.length ? all[0].weekStart : null;
  const since = dateArg(args.since) ?? (latest ? isoAddDays(latest, -7) : DATASET_START);
  const sel = selectWeeks(all, { since });
  const rows = await fetchRowsForWeeks(sel.weeks);

  const matched = rows
    .filter((r) => r.name_change_date && r.name_change_date >= since)
    .sort((a, b) => (a.name_change_date! < b.name_change_date! ? 1 : -1));

  return {
    source: 'HK Companies Registry (cr.gov.hk) — weekly open-data feed via data.gov.hk',
    since,
    weeks_searched: sel.weeks.length,
    latest_week_available: sel.latest_week_available,
    truncated: sel.truncated,
    matched: matched.length,
    count: Math.min(matched.length, limit),
    name_changes: matched.slice(0, limit).map((r) => ({
      brn: r.brn,
      current_name_en: r.name_en,
      current_name_zh: r.name_zh,
      type: r.type,
      name_change_date: r.name_change_date,
    })),
    ...dataLagNote(since, sel.latest_week_available),
  };
}

// The Companies Registry publishes each weekly CSV with roughly a 1-week lag
// (verified 2026-09-07: the week covering 24-30 Aug was published 2 Sep), so a
// `since` date more recent than the latest published week legitimately
// returns zero rows — that is real publication lag, not a bug or an empty
// upstream. Say so explicitly rather than let a bare `count: 0` read as "no
// new companies", which is how a silent-zero gets mistaken for a clean result
// (fleet #608 / docs/silent-zero-policy.md).
function dataLagNote(since: string, latestWeekAvailable: string | null): { data_lag_note?: string } {
  if (!latestWeekAvailable) return {};
  const latestCovered = isoAddDays(latestWeekAvailable, 6);
  if (since > latestCovered) {
    return {
      data_lag_note: `No data yet for ${since}: the Companies Registry's open-data feed has ~1 week of publication lag and the latest published week only covers up to ${latestCovered}. This is expected lag, not zero new companies — try again in a few days, or omit \`since\` to get the most recent available week.`,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// HKEX ticker join (Yahoo Finance search, keyless) — same upstream as
// hk-stocks' hk_resolve_symbol, called directly here rather than depending on
// another pack at runtime. Only attaches a ticker on a confident, normalized
// exact-name match — never a fuzzy guess.
// ---------------------------------------------------------------------------

async function tryResolveTicker(nameEn: string): Promise<{ code: string; yahoo_symbol: string; matched_name: string } | null> {
  if (!nameEn) return null;
  try {
    const url = new URL('https://query1.finance.yahoo.com/v1/finance/search');
    url.searchParams.set('q', nameEn);
    url.searchParams.set('quotesCount', '8');
    url.searchParams.set('newsCount', '0');
    const res = await pwFetch(url, { headers: { Accept: 'application/json' } }, 'Yahoo Finance search (HKEX ticker join)');
    if (!res.ok) return null;
    const data = (await res.json()) as { quotes?: Array<{ symbol?: string; shortname?: string; longname?: string }> };
    const target = normalizeCompanyName(nameEn);
    if (!target) return null;
    for (const q of data.quotes ?? []) {
      const sym = q.symbol;
      if (!sym || !/\.HK$/i.test(sym)) continue;
      const qn = normalizeCompanyName(q.shortname || q.longname || '');
      if (qn && qn === target) {
        const code = sym.replace(/\.HK$/i, '').padStart(5, '0');
        return { code, yahoo_symbol: sym, matched_name: q.shortname || q.longname || '' };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeCompanyName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\b(the\s+)?(company\s+)?limited\b/g, '')
    .replace(/\bltd\.?\b/g, '')
    .replace(/\bco\.?\b/g, '')
    .replace(/\bholdings?\b/g, '')
    .replace(/\bgroup\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cell(row: string[], i: number): string {
  if (i < 0 || i >= row.length) return '';
  return (row[i] ?? '').trim();
}

// DD-MM-YYYY -> YYYY-MM-DD; empty/unparseable -> null.
function toIso(d: string): string | null {
  const m = d.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function dateArg(v: unknown): string | undefined {
  const s = strArg(v);
  if (!s) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

function typeArg(v: unknown): 'local' | 'non_hk' | undefined {
  const s = strArg(v);
  return s === 'local' || s === 'non_hk' ? s : undefined;
}

function clampLimit(v: unknown, def: number, max: number): number {
  let n = def;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Number(v);
  n = Math.floor(n);
  if (n < 1) n = 1;
  if (n > max) n = max;
  return n;
}

// Minimal RFC-4180 CSV parser: handles quoted fields, escaped ("") quotes,
// commas and newlines inside quotes, and a leading UTF-8 BOM.
function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
