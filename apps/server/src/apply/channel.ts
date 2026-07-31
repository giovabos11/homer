// Apply-channel classification (pure, unit-testable).
//
// The apply pipeline used to assume every stored posting URL was a form it could
// drive. Against the live database that assumption was wrong for most of the
// queue: two thirds of the approved applications pointed at `whatjobs.com`
// syndication redirects or Hacker News "Who is hiring" comment threads. Driving
// a browser at either produces nothing but a wasted run and a misleading park
// reason, so the kind of target is now derived up front, persisted on the job,
// and branched on before any form interaction.
//
//   ats_form            → the driver can fill and submit it
//   aggregator_redirect → follow it to the employer first; it often dead-ends
//   email               → draft an approval-gated message, never a browser run
//   unknown             → never submitted automatically
import type { ApplyChannel } from '@shared/types';

/**
 * Hosts that serve real application forms. Suffix-matched, so
 * `acme.myworkdayjobs.com` and `boards.greenhouse.io` both hit.
 * A company careers page (anything else on the open web) is also `ats_form` —
 * this list only exists to keep well-known ATS hosts from being mistaken for an
 * aggregator when their URLs happen to carry redirect-ish path segments.
 */
export const ATS_HOSTS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workable.com',
  'smartrecruiters.com',
  'breezy.hr',
  'applytojob.com', // JazzHR
  'freshteam.com',
  'icims.com',
  'myworkdayjobs.com',
  'workday.com',
  'ultipro.com',
  'oraclecloud.com',
  'taleo.net',
  'bamboohr.com',
  'recruitee.com',
  'teamtailor.com',
  'personio.de',
  'jobvite.com',
  'successfactors.com',
  'paylocity.com',
  'dayforcehcm.com',
  'welcomekit.co',
  'welcometothejungle.com',
  'wellfound.com',
  'rippling.com',
] as const;

/**
 * Syndication networks whose links are click-tracking redirects to (maybe) the
 * employer, never a form of their own. `whatjobs.com` is the one that reached
 * the live queue; the rest are the same shape and fail the same way.
 */
export const AGGREGATOR_HOSTS = [
  'whatjobs.com',
  'jobrapido.com',
  'talent.com',
  'neuvoo.com',
  'jooble.org',
  'careerjet.com',
  'careerjet.co.uk',
  'simplyhired.com',
  'jobisjob.com',
  'jobtome.com',
  'joblift.com',
  'jobg8.com',
  'trabajo.org',
  'learn4good.com',
  'adzuna.com',
  'adzuna.co.uk',
  'jobsora.com',
  'jobted.com',
] as const;

/** Hosts where the "posting" is a discussion thread or a chat handle, not a form. */
const EMAIL_THREAD_HOSTS = ['news.ycombinator.com'] as const;
const UNAPPLYABLE_HOSTS = ['t.me', 'wa.me', 'discord.gg', 'discord.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com'] as const;

/** Sources whose postings are comment threads answered by email. */
const EMAIL_SOURCES = ['hn_hiring'] as const;

/**
 * Path shapes used by click-through/redirect endpoints. `pub_api__cpl__…` is
 * whatjobs's; the rest are the generic ones aggregators reuse.
 */
const REDIRECT_PATH_RE = /(^|\/)(pub_api|redirect|redir|out|clk|click|jump|goto|track|apply-redirect)([_/?.]|$)/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function hostMatches(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

export function isAtsHost(url: string): boolean {
  const host = hostOf(url);
  return host != null && hostMatches(host, ATS_HOSTS);
}

export function isAggregatorUrl(url: string): boolean {
  const host = hostOf(url);
  if (host == null) return false;
  if (hostMatches(host, ATS_HOSTS)) return false; // an ATS "apply" path is not a redirect
  if (hostMatches(host, AGGREGATOR_HOSTS)) return true;
  try {
    return REDIRECT_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface ChannelInput {
  canonicalUrl: string | null | undefined;
  source?: string | null;
  /** Stored posting text — the fallback signal for "the only way in is email". */
  descriptionMd?: string | null;
}

/**
 * Classify one posting. Deterministic and side-effect free: the same row always
 * lands on the same channel, which is what makes the backfill idempotent.
 */
export function classifyApplyChannel(input: ChannelInput): ApplyChannel {
  const url = (input.canonicalUrl ?? '').trim();
  const source = (input.source ?? '').toLowerCase();

  if (EMAIL_SOURCES.includes(source as (typeof EMAIL_SOURCES)[number])) return 'email';
  if (url === '') {
    // No link at all: an address in the posting text is still a way in.
    return extractContactEmail(input.descriptionMd ?? '') ? 'email' : 'unknown';
  }
  if (/^mailto:/i.test(url)) return 'email';
  // A local file IS a fillable form document — this is how the test suite points
  // the real driver at fixture forms without ever touching an employer.
  if (/^file:\/\//i.test(url)) return 'ats_form';
  if (!/^https?:\/\//i.test(url)) return 'unknown';

  const host = hostOf(url);
  if (host == null) return 'unknown';
  if (hostMatches(host, EMAIL_THREAD_HOSTS)) return 'email';
  if (hostMatches(host, UNAPPLYABLE_HOSTS)) return 'unknown';
  if (isAggregatorUrl(url)) return 'aggregator_redirect';
  return 'ats_form';
}

// ---------------------------------------------------------------------------
// Contact-email extraction (email channel)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Addresses that are never the place to send an application. */
const EMAIL_DENY_RE =
  /^(?:no-?reply|do-?not-?reply|postmaster|abuse|webmaster|support|privacy|legal|security|sales|billing|press|info@example|example@|you@|your@|name@|user@|someone@)/i;
const EMAIL_DENY_DOMAINS = ['example.com', 'example.org', 'domain.com', 'yourcompany.com', 'sentry.io', 'schema.org', 'w3.org'];

/** Words that mark an address as the intended application destination. */
const APPLY_HINT_RE = /(apply|jobs?|hiring|careers?|recruit|talent|resume|cv|work|join|hello|hi|team|contact)/i;

function scoreCandidate(address: string, haystack: string): number {
  const [local = '', domain = ''] = address.toLowerCase().split('@');
  let score = 0;
  if (APPLY_HINT_RE.test(local)) score += 3;
  // "Email your resume to x@y" / "apply: x@y" — proximity beats shape.
  const idx = haystack.toLowerCase().indexOf(address.toLowerCase());
  if (idx > 0) {
    const before = haystack.slice(Math.max(0, idx - 120), idx).toLowerCase();
    if (/\b(apply|e-?mail|send|reach out|contact|write to|resume|cv)\b/.test(before)) score += 4;
  }
  if (domain.endsWith('.gov') || domain.endsWith('.edu')) score += 1;
  return score;
}

/**
 * The address an application should be sent to, or null. Prefers an address the
 * text points at ("email your resume to …") over a bare mention, and refuses
 * the no-reply / boilerplate shapes outright rather than drafting into a void.
 */
export function extractContactEmail(text: string | null | undefined): string | null {
  if (!text) return null;
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of text.match(EMAIL_RE) ?? []) {
    const address = raw.replace(/[.,;:)\]}>'"]+$/, '');
    const lower = address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const domain = lower.split('@')[1] ?? '';
    if (EMAIL_DENY_RE.test(lower)) continue;
    if (EMAIL_DENY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) continue;
    if (!/\.[a-z]{2,}$/i.test(domain)) continue;
    candidates.push(address);
  }
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestScore = scoreCandidate(best, text);
  for (const c of candidates.slice(1)) {
    const s = scoreCandidate(c, text);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}
