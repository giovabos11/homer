// Pre-apply liveness verification + ATS re-resolution.
//
// WHY THIS EXISTS (a real failure, diagnosed live):
// application 12 (mintmcp, Ashby, fit 78) parked with "A Google reCAPTCHA is
// blocking mintmcp". There was no captcha. The stored posting id was stale —
// freehire.me had served `b3334a8b-…`, the company's live Ashby board carries
// `34d8220f-…` — so the page rendered Ashby's "Job not found" shell, whose HTML
// happens to contain `.grecaptcha-badge { visibility: hidden }`, and the captcha
// regex matched a CSS rule on an error page. The user was told to go solve a
// captcha that does not exist, on a posting that no longer exists.
//
// Two rules follow from that, and this module implements both:
//   1. Liveness is checked BEFORE anything else, so "dead posting" always wins
//      over any other diagnosis.
//   2. A dead posting is not the end: when the URL belongs to an ATS whose
//      company board is queryable, the board is re-fetched and the same role is
//      matched by normalized title (narrowed by location when it helps). One
//      confident match → the job's URL is rewritten in place and the apply
//      continues. Ambiguity or a miss → expired, with the board's current
//      openings recorded so the user can see what else is open there.
//
// Everything here takes an injectable `fetch`, so tests never touch the network.
import { normalizeText } from '../sources/dedupe';

export type AtsBoard = 'ashby' | 'greenhouse' | 'lever';

/** A company job board that can be listed by API, plus the posting we want. */
export interface BoardRef {
  ats: AtsBoard;
  /** Ashby board slug / Greenhouse board token / Lever site name. */
  slug: string;
  /** The posting id carried by the stored URL, when it had one. */
  postingId: string | null;
}

export interface BoardPosting {
  id: string;
  title: string;
  location: string | null;
  url: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; redirect?: 'manual' | 'follow'; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  url?: string;
  text(): Promise<string>;
}>;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function defaultFetch(): FetchLike {
  return globalThis.fetch as unknown as FetchLike;
}

async function getText(
  fetchImpl: FetchLike,
  url: string,
  opts: { redirect?: 'manual' | 'follow'; timeoutMs?: number } = {},
): Promise<{ status: number; body: string; finalUrl: string; location: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: opts.redirect ?? 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: controller.signal,
    });
    let body = '';
    try {
      body = await res.text();
    } catch {
      body = '';
    }
    return {
      status: res.status,
      body,
      finalUrl: res.url ?? url,
      location: res.headers?.get?.('location') ?? null,
    };
  } catch {
    return null; // network failure is inconclusive, never "dead"
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// URL → board reference (all three ATSs)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive the queryable company board behind a posting URL.
 *
 *   Ashby       jobs.ashbyhq.com/<slug>/<uuid>[/application]
 *   Greenhouse  boards.greenhouse.io/<token>/jobs/<id>
 *               job-boards.greenhouse.io/<token>/jobs/<id>
 *               boards.greenhouse.io/embed/job_app?for=<token>&token=<id>
 *               any company page carrying ?gh_jid=<id> (token comes from externalId)
 *   Lever       jobs.lever.co/<site>/<id>[/apply], jobs.eu.lever.co/<site>/<id>
 *
 * `externalId` is consulted too: discovery stores `greenhouse:<token>:<id>` for
 * board-embedded postings whose own URL is the company's careers page, which is
 * the only place the board token survives.
 */
export function deriveBoardRef(url: string, externalId?: string | null): BoardRef | null {
  const fromExternal = boardRefFromExternalId(externalId);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fromExternal;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (host === 'jobs.ashbyhq.com' || host.endsWith('.ashbyhq.com')) {
    const slug = segments[0];
    if (!slug) return fromExternal;
    const candidate = segments[1] && UUID_RE.test(segments[1]) ? segments[1]! : null;
    return { ats: 'ashby', slug, postingId: candidate };
  }

  if (host.endsWith('greenhouse.io')) {
    // Embedded form: /embed/job_app?for=<token>&token=<id>
    const embedToken = parsed.searchParams.get('for');
    if (embedToken) {
      return { ats: 'greenhouse', slug: embedToken, postingId: parsed.searchParams.get('token') };
    }
    const token = segments[0];
    if (!token) return fromExternal;
    const jobsIdx = segments.indexOf('jobs');
    const id = jobsIdx >= 0 ? (segments[jobsIdx + 1] ?? null) : null;
    return { ats: 'greenhouse', slug: token, postingId: id ?? parsed.searchParams.get('gh_jid') };
  }

  if (host.endsWith('lever.co')) {
    const site = segments[0];
    if (!site) return fromExternal;
    const id = segments[1] && segments[1] !== 'apply' ? segments[1]! : null;
    return { ats: 'lever', slug: site, postingId: id };
  }

  // Company careers page hosting a Greenhouse board (?gh_jid=…): the token only
  // exists on the discovery record, so fall through to it.
  const ghJid = parsed.searchParams.get('gh_jid');
  if (ghJid && fromExternal?.ats === 'greenhouse') {
    return { ...fromExternal, postingId: fromExternal.postingId ?? ghJid };
  }
  return fromExternal;
}

/** `greenhouse:<token>:<id>` / `lever:<site>:<id>` / `ashby:<slug>:<id>`. */
function boardRefFromExternalId(externalId: string | null | undefined): BoardRef | null {
  if (!externalId) return null;
  const m = /^(greenhouse|lever|ashby):([^:]+):(.+)$/i.exec(externalId.trim());
  if (!m) return null;
  return { ats: m[1]!.toLowerCase() as AtsBoard, slug: m[2]!, postingId: m[3]! };
}

/** The public listing endpoint for a board. */
export function boardApiUrl(ref: Pick<BoardRef, 'ats' | 'slug'>): string {
  const slug = encodeURIComponent(ref.slug);
  switch (ref.ats) {
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
  }
}

/** Parse a board listing payload into the common posting shape (pure). */
export function parseBoardPostings(ats: AtsBoard, payload: unknown): BoardPosting[] {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  if (ats === 'ashby') {
    const jobs = (payload as { jobs?: unknown[] })?.jobs;
    if (!Array.isArray(jobs)) return [];
    return jobs
      .map((j) => {
        const r = j as Record<string, unknown>;
        if (r.isListed === false) return null; // unlisted = not open to applicants
        const id = str(r.id);
        const title = str(r.title);
        if (!id || !title) return null;
        return {
          id,
          title,
          location: str(r.location),
          url: str(r.jobUrl) ?? str(r.applyUrl) ?? '',
        };
      })
      .filter((p): p is BoardPosting => p !== null);
  }
  if (ats === 'greenhouse') {
    const jobs = (payload as { jobs?: unknown[] })?.jobs;
    if (!Array.isArray(jobs)) return [];
    return jobs
      .map((j) => {
        const r = j as Record<string, unknown>;
        const id = r.id != null ? String(r.id) : null;
        const title = str(r.title);
        if (!id || !title) return null;
        const loc = (r.location as { name?: unknown } | undefined)?.name;
        return {
          id,
          title,
          location: typeof loc === 'string' ? loc : null,
          url: str(r.absolute_url) ?? '',
        };
      })
      .filter((p): p is BoardPosting => p !== null);
  }
  // lever: a bare array of postings
  const list = Array.isArray(payload) ? payload : (payload as { data?: unknown[] })?.data;
  if (!Array.isArray(list)) return [];
  return list
    .map((j) => {
      const r = j as Record<string, unknown>;
      const id = str(r.id);
      const title = str(r.text) ?? str(r.title);
      if (!id || !title) return null;
      const cat = r.categories as { location?: unknown } | undefined;
      return {
        id,
        title,
        location: typeof cat?.location === 'string' ? cat.location : null,
        url: str(r.hostedUrl) ?? str(r.applyUrl) ?? '',
      };
    })
    .filter((p): p is BoardPosting => p !== null);
}

export interface BoardFetchResult {
  ok: boolean;
  postings: BoardPosting[];
  /** Why the board could not be listed (network, 404 board, non-JSON). */
  error?: string;
}

export async function fetchBoardPostings(
  ref: BoardRef,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<BoardFetchResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const res = await getText(fetchImpl, boardApiUrl(ref), { timeoutMs: opts.timeoutMs });
  if (!res) return { ok: false, postings: [], error: 'board request failed' };
  if (res.status >= 400) return { ok: false, postings: [], error: `board responded ${res.status}` };
  let payload: unknown;
  try {
    payload = JSON.parse(res.body);
  } catch {
    return { ok: false, postings: [], error: 'board returned non-JSON' };
  }
  return { ok: true, postings: parseBoardPostings(ref.ats, payload) };
}

// ---------------------------------------------------------------------------
// Dead-posting detection (pure)
// ---------------------------------------------------------------------------

export type LivenessReason =
  | 'live'
  | 'http_gone'
  | 'closed_text'
  | 'empty_shell'
  | 'board_missing'
  | 'unreachable'
  | 'not_checked';

/** Phrases every major ATS (and most careers pages) use for a posting that is over. */
const DEAD_TEXT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(job|position|posting|opening|role)\s+not\s+found\b/i, label: 'posting not found' },
  { re: /\bno\s+longer\s+(be\s+)?accept(?:ing|ed)\s+applications?\b/i, label: 'no longer accepting applications' },
  { re: /\bwe\s+are\s+no\s+longer\s+accepting\b/i, label: 'no longer accepting applications' },
  { re: /\bthis\s+(job|position|role|posting|opening)\s+(?:is|has)\s+(?:been\s+)?(?:no\s+longer\s+available|closed|filled|expired)\b/i, label: 'position closed' },
  { re: /\b(position|posting|job|role)\s+(?:is\s+)?(?:now\s+)?closed\b/i, label: 'position closed' },
  { re: /\bthis\s+(job|posting|position|role)\s+is\s+no\s+longer\s+(?:available|open|active)\b/i, label: 'posting no longer available' },
  { re: /\b(job|posting)\s+(?:has\s+)?expired\b/i, label: 'posting expired' },
  { re: /\bpage\s+not\s+found\b/i, label: 'page not found' },
  { re: /\b404\b[\s\-—:|]*not\s+found\b/i, label: 'HTTP 404 page' },
  { re: /\bthe\s+(job|role|position)\s+you(?:'re| are)?\s+looking\s+for\s+(?:is\s+)?(?:no\s+longer|not)\b/i, label: 'posting not found' },
];

/** Markers that say "this HTML is a JS app shell", not an empty error body. */
const SPA_SHELL_RE = /id=["'](?:root|app|__next|__nuxt)["']|__NEXT_DATA__|window\.__INITIAL/i;

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DeadPostingVerdict {
  dead: boolean;
  reason: LivenessReason;
  evidence: string | null;
}

/**
 * Decide whether a fetched (or rendered) page is a dead posting. Pure, so the
 * same function serves the pre-flight HTTP check and the in-browser check the
 * driver runs on the rendered DOM.
 *
 * Deliberately conservative in both directions:
 *  - 401/403 is NOT dead (that is a bot wall or a login, handled elsewhere).
 *  - 5xx is NOT dead (transient).
 *  - an empty body is only "dead" when it is genuinely empty: a JS app shell
 *    (Ashby, Workday, Greenhouse embeds) has almost no server-rendered text and
 *    must never be condemned on that basis.
 */
export function detectDeadPosting(input: { status?: number | null; html?: string | null }): DeadPostingVerdict {
  const status = input.status ?? null;
  if (status === 404 || status === 410) {
    return { dead: true, reason: 'http_gone', evidence: `HTTP ${status}` };
  }
  const html = input.html ?? '';
  const text = htmlToText(html);
  for (const p of DEAD_TEXT_PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      const at = Math.max(0, (m.index ?? 0) - 60);
      return { dead: true, reason: 'closed_text', evidence: `${p.label}: “${text.slice(at, at + 180).trim()}”` };
    }
  }
  const hasForm = /<form\b/i.test(html) || /<input\b/i.test(html) || /<textarea\b/i.test(html);
  if (!hasForm && text.length < 200 && !SPA_SHELL_RE.test(html)) {
    return { dead: true, reason: 'empty_shell', evidence: `page returned ${text.length} characters of text and no form` };
  }
  return { dead: false, reason: 'live', evidence: null };
}

// ---------------------------------------------------------------------------
// Liveness check
// ---------------------------------------------------------------------------

export interface LivenessResult {
  alive: boolean;
  reason: LivenessReason;
  status: number | null;
  evidence: string | null;
  /** True when nothing conclusive could be learned — never treat as dead. */
  inconclusive: boolean;
  /** Board listing fetched while checking, reused by re-resolution. */
  board: { ref: BoardRef; postings: BoardPosting[] } | null;
}

/**
 * Verify a posting is still live BEFORE any form interaction.
 *
 * For Ashby / Greenhouse / Lever the company board API is authoritative and is
 * used instead of scraping: those pages are JS shells that answer 200 with no
 * server-rendered content whether the posting exists or not (exactly how the
 * mintmcp failure hid). Everything else falls back to an HTTP fetch plus the
 * pure text heuristics above.
 */
export async function checkPostingLiveness(
  url: string,
  opts: { externalId?: string | null; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<LivenessResult> {
  const base: LivenessResult = {
    alive: true, reason: 'not_checked', status: null, evidence: null, inconclusive: true, board: null,
  };
  if (!url || !/^https?:\/\//i.test(url)) return base;

  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const ref = deriveBoardRef(url, opts.externalId);

  if (ref) {
    const board = await fetchBoardPostings(ref, { fetchImpl, timeoutMs: opts.timeoutMs });
    if (board.ok) {
      const postings = board.postings;
      if (ref.postingId == null) {
        // A board URL with no posting id: nothing to verify, but the listing is
        // still useful downstream.
        return { ...base, reason: 'not_checked', board: { ref, postings } };
      }
      const found = postings.some((p) => p.id.toLowerCase() === ref.postingId!.toLowerCase());
      if (found) {
        return { alive: true, reason: 'live', status: null, evidence: null, inconclusive: false, board: { ref, postings } };
      }
      return {
        alive: false,
        reason: 'board_missing',
        status: null,
        evidence: `${ref.ats} board “${ref.slug}” no longer lists posting ${ref.postingId} (${postings.length} opening${postings.length === 1 ? '' : 's'} currently listed)`,
        inconclusive: false,
        board: { ref, postings },
      };
    }
    // Board unreachable → fall through to the generic HTTP check rather than
    // guessing. A network blip must never expire somebody's application.
  }

  const res = await getText(fetchImpl, url, { timeoutMs: opts.timeoutMs });
  if (!res) {
    return { ...base, reason: 'unreachable', evidence: 'the posting URL could not be fetched' };
  }
  if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429) {
    return { ...base, reason: 'unreachable', status: res.status, evidence: `HTTP ${res.status}` };
  }
  const verdict = detectDeadPosting({ status: res.status, html: res.body });
  if (verdict.dead) {
    return { alive: false, reason: verdict.reason, status: res.status, evidence: verdict.evidence, inconclusive: false, board: null };
  }
  return { alive: true, reason: 'live', status: res.status, evidence: null, inconclusive: false, board: null };
}

// ---------------------------------------------------------------------------
// Re-resolution
// ---------------------------------------------------------------------------

export type ReresolveOutcome = 'resolved' | 'ambiguous' | 'miss' | 'unavailable';

export interface ReresolveResult {
  outcome: ReresolveOutcome;
  /** The single confident match (outcome === 'resolved'). */
  posting: BoardPosting | null;
  /** Everything the board currently lists — shown to the user on a miss. */
  openings: BoardPosting[];
  /** Narrowed-down finalists when the match was ambiguous. */
  candidates: BoardPosting[];
  detail: string;
}

function titleTokens(title: string): Set<string> {
  return new Set(normalizeText(title).split(' ').filter((t) => t.length > 1));
}

/** Jaccard similarity over normalized title tokens. */
export function titleSimilarity(a: string, b: string): number {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / (A.size + B.size - shared);
}

function locationMatches(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const head = (s: string) => s.split(' ')[0] ?? s;
  return na.includes(nb) || nb.includes(na) || head(na) === head(nb);
}

/**
 * Find the same role on a freshly-listed board. Exact normalized title first;
 * a fuzzy pass only when nothing matched exactly. Multiple survivors are
 * narrowed by location, and anything still tied stays ambiguous on purpose —
 * applying to the wrong role at the right company is worse than asking.
 */
export function matchBoardPosting(
  postings: BoardPosting[],
  want: { title: string; location?: string | null },
  opts: { minSimilarity?: number } = {},
): ReresolveResult {
  const openings = postings;
  if (postings.length === 0) {
    return { outcome: 'miss', posting: null, openings, candidates: [], detail: 'the board lists no open postings' };
  }
  const wantTitle = normalizeText(want.title);
  let candidates = postings.filter((p) => normalizeText(p.title) === wantTitle);
  let how = 'exact title';

  if (candidates.length === 0) {
    const min = opts.minSimilarity ?? 0.7;
    const scored = postings
      .map((p) => ({ p, s: titleSimilarity(p.title, want.title) }))
      .filter((x) => x.s >= min)
      .sort((a, b) => b.s - a.s);
    candidates = scored.map((x) => x.p);
    how = 'similar title';
    // A clear leader is not ambiguous: keep it when it is well ahead.
    if (scored.length > 1 && scored[0]!.s - scored[1]!.s >= 0.25) candidates = [scored[0]!.p];
  }

  if (candidates.length === 0) {
    return {
      outcome: 'miss',
      posting: null,
      openings,
      candidates: [],
      detail: `no posting on the board matches “${want.title}”`,
    };
  }
  if (candidates.length > 1 && want.location) {
    const narrowed = candidates.filter((p) => locationMatches(p.location, want.location ?? null));
    if (narrowed.length === 1) {
      return { outcome: 'resolved', posting: narrowed[0]!, openings, candidates: narrowed, detail: `${how} + location` };
    }
    if (narrowed.length > 1) candidates = narrowed;
  }
  if (candidates.length === 1) {
    return { outcome: 'resolved', posting: candidates[0]!, openings, candidates, detail: how };
  }
  return {
    outcome: 'ambiguous',
    posting: null,
    openings,
    candidates,
    detail: `${candidates.length} postings match “${want.title}” and nothing distinguishes them`,
  };
}

/** Board lookup + title match in one call (the apply worker's entry point). */
export async function reresolvePosting(
  args: {
    url: string;
    externalId?: string | null;
    title: string;
    location?: string | null;
    /** Board listing already fetched by the liveness check, when there is one. */
    board?: { ref: BoardRef; postings: BoardPosting[] } | null;
  },
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<ReresolveResult & { ref: BoardRef | null }> {
  let board = args.board ?? null;
  const ref = board?.ref ?? deriveBoardRef(args.url, args.externalId);
  if (!ref) {
    return { outcome: 'unavailable', posting: null, openings: [], candidates: [], detail: 'this posting is not on a queryable ATS board', ref: null };
  }
  if (!board) {
    const fetched = await fetchBoardPostings(ref, opts);
    if (!fetched.ok) {
      return { outcome: 'unavailable', posting: null, openings: [], candidates: [], detail: fetched.error ?? 'board unavailable', ref };
    }
    board = { ref, postings: fetched.postings };
  }
  return { ...matchBoardPosting(board.postings, { title: args.title, location: args.location ?? null }), ref };
}

/** Canonical apply URL for a re-resolved posting (board URL when it gave one). */
export function postingUrl(ref: BoardRef, posting: BoardPosting): string {
  if (posting.url) return posting.url;
  switch (ref.ats) {
    case 'ashby':
      return `https://jobs.ashbyhq.com/${ref.slug}/${posting.id}`;
    case 'greenhouse':
      return `https://job-boards.greenhouse.io/${ref.slug}/jobs/${posting.id}`;
    case 'lever':
      return `https://jobs.lever.co/${ref.slug}/${posting.id}`;
  }
}

// ---------------------------------------------------------------------------
// Aggregator redirect following
// ---------------------------------------------------------------------------

export interface RedirectTrace {
  finalUrl: string;
  hops: string[];
  status: number | null;
  /** True when the chain never left the host it started on. */
  sameHost: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const META_REFRESH_RE = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i;

/**
 * Follow an aggregator link to whatever it actually points at. HTTP redirects
 * first (bounded hops), then one meta-refresh hop, because that is the other
 * shape syndication networks use. Stops as soon as the chain reaches a host
 * different from where it started — that is the employer.
 */
export async function followRedirectChain(
  url: string,
  opts: { fetchImpl?: FetchLike; maxHops?: number; timeoutMs?: number } = {},
): Promise<RedirectTrace> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const maxHops = opts.maxHops ?? 6;
  const startHost = hostOf(url);
  const hops: string[] = [url];
  let current = url;
  let status: number | null = null;

  for (let i = 0; i < maxHops; i += 1) {
    const res = await getText(fetchImpl, current, { redirect: 'manual', timeoutMs: opts.timeoutMs });
    if (!res) break;
    status = res.status;
    if (res.status >= 300 && res.status < 400 && res.location) {
      let next: string;
      try {
        next = new URL(res.location, current).href;
      } catch {
        break;
      }
      if (hops.includes(next)) break; // redirect loop
      hops.push(next);
      current = next;
      continue;
    }
    // Terminal response: try one meta-refresh hop before giving up.
    const meta = META_REFRESH_RE.exec(res.body ?? '');
    if (meta?.[1]) {
      let next: string;
      try {
        next = new URL(meta[1].trim(), current).href;
      } catch {
        break;
      }
      if (!hops.includes(next)) {
        hops.push(next);
        current = next;
        continue;
      }
    }
    break;
  }

  return { finalUrl: current, hops, status, sameHost: hostOf(current) === startHost };
}
