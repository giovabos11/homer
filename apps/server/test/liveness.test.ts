// Pre-apply liveness + ATS re-resolution + the captcha-precision fix.
//
// The regression this file locks down, in the words of the live run:
// application 12 (mintmcp, Ashby) parked with "A Google reCAPTCHA is blocking
// mintmcp". There was no captcha and no posting — the stored id was stale, the
// page was Ashby's "Job not found" shell, and the shell's stylesheet contains
// `.grecaptcha-badge { visibility: hidden }`. Liveness must run first, and a
// CSS rule must never be mistaken for a wall.
import { describe, expect, it } from 'vitest';
import { detectCaptcha } from '../src/apply/driver';
import {
  boardApiUrl,
  checkPostingLiveness,
  deriveBoardRef,
  detectDeadPosting,
  followRedirectChain,
  matchBoardPosting,
  parseBoardPostings,
  postingUrl,
  reresolvePosting,
  type BoardPosting,
} from '../src/apply/liveness';
import { stubFetch } from './helpers';

/** The real Ashby SPA shell, trimmed to the parts that matter. */
const ASHBY_SHELL = `<!DOCTYPE html><html lang="en"><head><title>Jobs</title>
<style>.grecaptcha-badge { visibility: hidden; }</style></head>
<body><noscript>You need to enable JavaScript to run this app.</noscript>
<div id="root"><div class="center"><div class="spinner"></div></div></div></body></html>`;

const ASHBY_BOARD = JSON.stringify({
  jobs: [
    { id: '02100327-c47a-413a-98d5-b7b4025a7b94', title: 'Technical Customer Success Manager', location: 'San Francisco, CA', isListed: true, jobUrl: 'https://jobs.ashbyhq.com/mintmcp/02100327-c47a-413a-98d5-b7b4025a7b94' },
    { id: '34d8220f-a48e-4f9a-bfc6-2079f775ef1b', title: 'Software Engineer', location: 'San Francisco, CA', isListed: true, jobUrl: 'https://jobs.ashbyhq.com/mintmcp/34d8220f-a48e-4f9a-bfc6-2079f775ef1b' },
    { id: '185bd659-fd23-45d3-b505-47e940ad29da', title: 'Account Executive', location: 'San Francisco, CA', isListed: true, jobUrl: 'https://jobs.ashbyhq.com/mintmcp/185bd659-fd23-45d3-b505-47e940ad29da' },
  ],
});

const MINTMCP_BOARD_API = 'https://api.ashbyhq.com/posting-api/job-board/mintmcp?includeCompensation=true';
const STALE_URL = 'https://jobs.ashbyhq.com/mintmcp/b3334a8b-521e-4989-82b1-988ff52a2671?utm_source=freehire.me';

describe('captcha detection precision', () => {
  it('does NOT fire on the Ashby error shell that caused the mintmcp misdiagnosis', () => {
    expect(ASHBY_SHELL).toContain('grecaptcha-badge'); // the trap is really there
    expect(detectCaptcha(ASHBY_SHELL)).toBeNull();
  });

  it('does NOT fire on invisible reCAPTCHA v3 (a score, not a wall)', () => {
    const v3 = `<form><input name="email"><script src="https://www.google.com/recaptcha/api.js?render=KEY"></script>
      <script>grecaptcha.ready(function(){grecaptcha.execute('KEY')});</script><button type="submit">Apply</button></form>`;
    expect(detectCaptcha(v3)).toBeNull();
  });

  it('still fires on a real v2 widget guarding a form', () => {
    const v2 = '<form><input name="email"><div class="g-recaptcha" data-sitekey="k"></div><button type="submit">Apply</button></form>';
    expect(detectCaptcha(v2)).toBe('Google reCAPTCHA');
  });

  it('a captcha widget with no form to guard is page furniture, not a wall', () => {
    expect(detectCaptcha('<div class="g-recaptcha"></div><p>Job not found</p>')).toBeNull();
  });
});

describe('detectDeadPosting (pure)', () => {
  it('404 and 410 are dead', () => {
    expect(detectDeadPosting({ status: 404, html: '<html><body>whatever</body></html>' })).toMatchObject({
      dead: true, reason: 'http_gone',
    });
    expect(detectDeadPosting({ status: 410, html: '' }).dead).toBe(true);
  });

  it('reads the phrases every ATS uses when a posting is over', () => {
    const cases = [
      '<html><body><h1>Job not found</h1><p>Try the board.</p></body></html>',
      '<html><body><p>We are no longer accepting applications for this role.</p></body></html>',
      '<html><body><p>This position is closed.</p></body></html>',
      '<html><body><h1>Page not found</h1></body></html>',
    ];
    for (const html of cases) {
      const v = detectDeadPosting({ status: 200, html });
      expect(v.dead).toBe(true);
      expect(v.reason).toBe('closed_text');
      expect(v.evidence).toBeTruthy();
    }
  });

  it('an empty shell with no form is dead', () => {
    expect(detectDeadPosting({ status: 200, html: '<html><body></body></html>' })).toMatchObject({
      dead: true, reason: 'empty_shell',
    });
  });

  it('a JS app shell is NOT condemned for having no server-rendered text', () => {
    expect(detectDeadPosting({ status: 200, html: ASHBY_SHELL }).dead).toBe(false);
  });

  it('401 / 403 / 5xx are bot walls or blips, never "expired"', () => {
    expect(detectDeadPosting({ status: 403, html: '<form><input></form>' }).dead).toBe(false);
    expect(detectDeadPosting({ status: 503, html: '<form><input></form>' }).dead).toBe(false);
  });

  it('a live form is live', () => {
    expect(detectDeadPosting({ status: 200, html: '<form><input name="email"><button>Apply</button></form>' }).dead).toBe(false);
  });
});

describe('board reference derivation', () => {
  it('covers all three ATS URL shapes', () => {
    expect(deriveBoardRef(STALE_URL)).toEqual({ ats: 'ashby', slug: 'mintmcp', postingId: 'b3334a8b-521e-4989-82b1-988ff52a2671' });
    expect(deriveBoardRef('https://boards.greenhouse.io/andurilindustries/jobs/5197408007')).toEqual({
      ats: 'greenhouse', slug: 'andurilindustries', postingId: '5197408007',
    });
    expect(deriveBoardRef('https://job-boards.greenhouse.io/warp/jobs/4324888004?utm_source=freehire.me')).toEqual({
      ats: 'greenhouse', slug: 'warp', postingId: '4324888004',
    });
    expect(deriveBoardRef('https://jobs.lever.co/acme/9d2f4a1b/apply')).toEqual({
      ats: 'lever', slug: 'acme', postingId: '9d2f4a1b',
    });
  });

  it('falls back to the external id for a careers page hosting an embedded board', () => {
    // The live Abnormal AI row: the token only survives on the discovery record.
    expect(
      deriveBoardRef('https://abnormal.ai/careers/jobs/7814567003?gh_jid=7814567003', 'greenhouse:abnormalsecurity:7814567003'),
    ).toEqual({ ats: 'greenhouse', slug: 'abnormalsecurity', postingId: '7814567003' });
  });

  it('returns null when there is no queryable board', () => {
    expect(deriveBoardRef('https://www.whatjobs.com/pub_api__cpl__1__2')).toBeNull();
    expect(deriveBoardRef('not a url')).toBeNull();
  });

  it('builds the documented listing endpoints', () => {
    expect(boardApiUrl({ ats: 'ashby', slug: 'mintmcp' })).toBe(MINTMCP_BOARD_API);
    expect(boardApiUrl({ ats: 'greenhouse', slug: 'warp' })).toBe('https://boards-api.greenhouse.io/v1/boards/warp/jobs');
    expect(boardApiUrl({ ats: 'lever', slug: 'acme' })).toBe('https://api.lever.co/v0/postings/acme?mode=json');
  });
});

describe('board payload parsing', () => {
  it('reads each ATS payload shape into the common posting form', () => {
    expect(parseBoardPostings('ashby', JSON.parse(ASHBY_BOARD))).toHaveLength(3);
    expect(parseBoardPostings('ashby', { jobs: [{ id: 'x', title: 'Hidden', isListed: false }] })).toHaveLength(0);
    expect(
      parseBoardPostings('greenhouse', { jobs: [{ id: 4324888004, title: 'Software Engineer', location: { name: 'Remote' }, absolute_url: 'https://gh/x' }] }),
    ).toEqual([{ id: '4324888004', title: 'Software Engineer', location: 'Remote', url: 'https://gh/x' }]);
    expect(
      parseBoardPostings('lever', [{ id: 'abc', text: 'Backend Engineer', categories: { location: 'Austin' }, hostedUrl: 'https://lever/x' }]),
    ).toEqual([{ id: 'abc', title: 'Backend Engineer', location: 'Austin', url: 'https://lever/x' }]);
  });
});

describe('checkPostingLiveness', () => {
  it('the mintmcp case: the board no longer lists the stored id → dead, with the board attached', async () => {
    const res = await checkPostingLiveness(STALE_URL, { fetchImpl: stubFetch({ [MINTMCP_BOARD_API]: ASHBY_BOARD }) });
    expect(res.alive).toBe(false);
    expect(res.reason).toBe('board_missing');
    expect(res.inconclusive).toBe(false);
    expect(res.evidence).toContain('b3334a8b');
    expect(res.board?.postings).toHaveLength(3);
  });

  it('a listed posting is live without ever scraping the JS shell', async () => {
    const live = 'https://jobs.ashbyhq.com/mintmcp/34d8220f-a48e-4f9a-bfc6-2079f775ef1b';
    const res = await checkPostingLiveness(live, { fetchImpl: stubFetch({ [MINTMCP_BOARD_API]: ASHBY_BOARD }) });
    expect(res.alive).toBe(true);
    expect(res.reason).toBe('live');
  });

  it('falls back to HTTP + text heuristics off the ATS boards', async () => {
    const url = 'https://careers.acme.com/jobs/9';
    const dead = await checkPostingLiveness(url, {
      fetchImpl: stubFetch({ [url]: { status: 200, body: '<html><body><h1>This position is closed.</h1></body></html>' } }),
    });
    expect(dead.alive).toBe(false);
    expect(dead.reason).toBe('closed_text');

    const gone = await checkPostingLiveness(url, { fetchImpl: stubFetch({}) }); // 404 from the stub
    expect(gone.alive).toBe(false);
    expect(gone.reason).toBe('http_gone');
  });

  it('an unreachable posting is inconclusive, never expired', async () => {
    const res = await checkPostingLiveness('https://careers.acme.com/jobs/9', {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(res.alive).toBe(true);
    expect(res.inconclusive).toBe(true);
    expect(res.reason).toBe('unreachable');
  });

  it('a board that will not answer falls through to the page rather than guessing', async () => {
    const res = await checkPostingLiveness(STALE_URL, {
      fetchImpl: stubFetch({
        [MINTMCP_BOARD_API]: { status: 500, body: 'boom' },
        'https://jobs.ashbyhq.com/mintmcp/b3334a8b-521e-4989-82b1-988ff52a2671?utm_source=freehire.me': { status: 200, body: ASHBY_SHELL },
      }),
    });
    expect(res.alive).toBe(true); // the SPA shell is not evidence of death
  });
});

describe('matchBoardPosting', () => {
  const board: BoardPosting[] = parseBoardPostings('ashby', JSON.parse(ASHBY_BOARD));

  it('resolves the same role by normalized title', () => {
    const r = matchBoardPosting(board, { title: 'Software Engineer', location: 'San Francisco, CA' });
    expect(r.outcome).toBe('resolved');
    expect(r.posting?.id).toBe('34d8220f-a48e-4f9a-bfc6-2079f775ef1b');
  });

  it('narrows two same-titled postings by location', () => {
    const two: BoardPosting[] = [
      { id: 'a', title: 'Software Engineer', location: 'New York, NY', url: '' },
      { id: 'b', title: 'Software Engineer', location: 'San Francisco, CA', url: '' },
    ];
    expect(matchBoardPosting(two, { title: 'Software Engineer', location: 'San Francisco, CA' })).toMatchObject({
      outcome: 'resolved',
    });
  });

  it('stays ambiguous when nothing distinguishes the candidates', () => {
    const two: BoardPosting[] = [
      { id: 'a', title: 'Software Engineer', location: null, url: '' },
      { id: 'b', title: 'Software Engineer', location: null, url: '' },
    ];
    const r = matchBoardPosting(two, { title: 'Software Engineer' });
    expect(r.outcome).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
    expect(r.openings).toHaveLength(2);
  });

  it('misses cleanly and reports what the board does have open', () => {
    const r = matchBoardPosting(board, { title: 'Principal Kernel Engineer' });
    expect(r.outcome).toBe('miss');
    expect(r.posting).toBeNull();
    expect(r.openings.map((p) => p.title)).toContain('Account Executive');
  });

  it('an empty board is a miss, not a crash', () => {
    expect(matchBoardPosting([], { title: 'Software Engineer' }).outcome).toBe('miss');
  });
});

describe('reresolvePosting', () => {
  it('re-resolves the live mintmcp Software Engineer id from the stale URL', async () => {
    const r = await reresolvePosting(
      { url: STALE_URL, title: 'Software Engineer', location: 'San Francisco, CA' },
      { fetchImpl: stubFetch({ [MINTMCP_BOARD_API]: ASHBY_BOARD }) },
    );
    expect(r.outcome).toBe('resolved');
    expect(r.posting!.id).toBe('34d8220f-a48e-4f9a-bfc6-2079f775ef1b');
    expect(postingUrl(r.ref!, r.posting!)).toBe('https://jobs.ashbyhq.com/mintmcp/34d8220f-a48e-4f9a-bfc6-2079f775ef1b');
  });

  it('greenhouse: same role, new id', async () => {
    const api = 'https://boards-api.greenhouse.io/v1/boards/warp/jobs';
    const r = await reresolvePosting(
      { url: 'https://job-boards.greenhouse.io/warp/jobs/4324888004', title: 'Software Engineer' },
      {
        fetchImpl: stubFetch({
          [api]: JSON.stringify({
            jobs: [
              { id: 9999999, title: 'Software Engineer', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/warp/jobs/9999999' },
              { id: 8888888, title: 'Designer', location: { name: 'Remote' }, absolute_url: 'https://x' },
            ],
          }),
        }),
      },
    );
    expect(r.outcome).toBe('resolved');
    expect(r.posting!.id).toBe('9999999');
  });

  it('lever: miss reports the board contents', async () => {
    const api = 'https://api.lever.co/v0/postings/acme?mode=json';
    const r = await reresolvePosting(
      { url: 'https://jobs.lever.co/acme/deadbeef', title: 'Software Engineer' },
      { fetchImpl: stubFetch({ [api]: JSON.stringify([{ id: 'z', text: 'Head of Sales', categories: { location: 'NY' } }]) }) },
    );
    expect(r.outcome).toBe('miss');
    expect(r.openings.map((p) => p.title)).toEqual(['Head of Sales']);
  });

  it('is unavailable (not a miss) when the posting is not on a queryable board', async () => {
    const r = await reresolvePosting(
      { url: 'https://www.whatjobs.com/pub_api__cpl__1__2', title: 'Software Engineer' },
      { fetchImpl: stubFetch({}) },
    );
    expect(r.outcome).toBe('unavailable');
    expect(r.ref).toBeNull();
  });
});

describe('followRedirectChain', () => {
  it('follows an aggregator link to the employer ATS form', async () => {
    const start = 'https://www.whatjobs.com/pub_api__cpl__1__2';
    const mid = 'https://track.example.com/x';
    const dest = 'https://job-boards.greenhouse.io/acme/jobs/123';
    const trace = await followRedirectChain(start, {
      fetchImpl: stubFetch({
        [start]: { status: 302, headers: { location: mid } },
        [mid]: { status: 301, headers: { location: dest } },
        [dest]: { status: 200, body: '<form><input name="email"></form>' },
      }),
    });
    expect(trace.finalUrl).toBe(dest);
    expect(trace.hops).toHaveLength(3);
    expect(trace.sameHost).toBe(false);
  });

  it('reports the dead-end when the chain lands back on the aggregator (the live whatjobs behaviour)', async () => {
    const start = 'https://www.whatjobs.com/pub_api__cpl__2626788452__7065?geoID=2251';
    const home = 'https://www.whatjobs.com/';
    const trace = await followRedirectChain(start, {
      fetchImpl: stubFetch({
        [start]: { status: 301, headers: { location: home } },
        [home]: { status: 200, body: '<html><body>Search jobs</body></html>' },
      }),
    });
    expect(trace.finalUrl).toBe(home);
    expect(trace.sameHost).toBe(true);
  });

  it('follows one meta-refresh hop, and never loops forever', async () => {
    const start = 'https://agg.example/out?id=1';
    const dest = 'https://jobs.lever.co/acme/abc';
    const trace = await followRedirectChain(start, {
      fetchImpl: stubFetch({
        [start]: { status: 200, body: `<meta http-equiv="refresh" content="0;url=${dest}">` },
        [dest]: { status: 200, body: '<form><input></form>' },
      }),
    });
    expect(trace.finalUrl).toBe(dest);

    const loop = 'https://agg.example/loop';
    const looped = await followRedirectChain(loop, {
      fetchImpl: stubFetch({ [loop]: { status: 302, headers: { location: loop } } }),
    });
    expect(looped.finalUrl).toBe(loop);
  });
});
