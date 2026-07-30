import type {
  Application, Connection, CredentialMeta, EmailRecord, FeedbackEntry, Job,
  PrepTask, QueueTask, ScheduleEvent, Settings, SkillProgress, SourceBudget, UserProfile,
} from '@shared';

// ---------------------------------------------------------------------------
// Time helpers — fixtures are always relative to "now" so the demo feels live.
// ---------------------------------------------------------------------------
const NOW = Date.now();
const DAY = 86400000;
export const daysAgo = (d: number, h = 12): string => new Date(NOW - d * DAY - (12 - h) * 3600000).toISOString();
export const inDays = (d: number, h = 12, m = 0): string => {
  const t = new Date(NOW + d * DAY);
  t.setHours(h, m, 0, 0);
  return t.toISOString();
};

// ---------------------------------------------------------------------------
// Job descriptions (markdown, incl. pay section — FR-22)
// ---------------------------------------------------------------------------
function desc(company: string, title: string, pay: string, extras: string): string {
  return `## About ${company}

${company} is hiring a **${title}** to join a product engineering team that ships fast and owns outcomes end to end.

## What you'll do

- Design, build, and operate user-facing features across the stack
- Collaborate with product and design in short, iterative cycles
- Own services from architecture through deployment and on-call
- Raise the bar on testing, observability, and code review

## What we're looking for

- Strong TypeScript/JavaScript or Python fundamentals
- Experience shipping production web or mobile applications
- Familiarity with SQL and cloud deployment (AWS/GCP/Vercel)
- Clear written communication in a distributed team

${extras}

## Pay & benefits

${pay}

- Health, dental, and vision coverage
- 401(k) with company match
- Flexible PTO and remote-friendly culture
`;
}

let jobSeq = 1;
function job(o: Partial<Job> & Pick<Job, 'company' | 'title' | 'source' | 'status'>): Job {
  const id = jobSeq++;
  const salaryMin = o.salaryMin ?? null;
  const salaryMax = o.salaryMax ?? null;
  const payLine =
    salaryMin && salaryMax
      ? `**Base salary range: $${salaryMin.toLocaleString()} – $${salaryMax.toLocaleString()}** ${o.salaryPredicted ? '_(predicted from market data)_' : '(posted range)'} + equity`
      : '_Compensation not posted; flagged for salary question in screening._';
  return {
    id,
    source: o.source,
    externalId: o.externalId ?? `${o.source}-${1000 + id}`,
    canonicalUrl: o.canonicalUrl ?? `https://jobs.example.com/${o.company.toLowerCase().replace(/\W+/g, '-')}/${id}`,
    company: o.company,
    title: o.title,
    location: o.location ?? 'Remote (US)',
    remoteType: o.remoteType ?? 'remote',
    salaryMin,
    salaryMax,
    salaryCurrency: salaryMin || salaryMax ? 'USD' : null,
    salaryPredicted: o.salaryPredicted ?? false,
    descriptionMd: o.descriptionMd ?? desc(o.company, o.title, payLine, o.status === 'quarantined' ? '> **Warning:** This posting was flagged by the legitimacy checker.' : ''),
    postedAt: o.postedAt ?? daysAgo(6),
    firstSeen: o.firstSeen ?? daysAgo(5),
    status: o.status,
    fitScore: o.fitScore ?? null,
    fitBreakdown: o.fitBreakdown ?? (o.fitScore != null
      ? {
          technical: Math.min(100, o.fitScore + 6),
          experience: Math.max(0, o.fitScore - 8),
          behavioral: Math.min(100, o.fitScore + 3),
          career: o.fitScore,
          locationVeto: false,
        }
      : null),
    legitVerdict: o.legitVerdict ?? (o.fitScore != null ? 'legit' : 'unchecked'),
    legitReasons: o.legitReasons ?? (o.fitScore != null
      ? ['Company has verified web presence and engineering blog', 'Posting matches careers page listing', 'Salary within market band for the role']
      : []),
    managed: o.managed ?? 'auto',
  };
}

export const JOBS: Job[] = [
  // ------------------------------ discovered ------------------------------
  job({ company: 'Linear', title: 'Fullstack Engineer', source: 'ashby', status: 'discovered', salaryMin: 150000, salaryMax: 210000, postedAt: daysAgo(1), firstSeen: daysAgo(0, 9), location: 'Remote (US)' }),
  job({ company: 'Supabase', title: 'Software Engineer, Dashboard', source: 'greenhouse', status: 'discovered', salaryMin: 140000, salaryMax: 190000, postedAt: daysAgo(2), firstSeen: daysAgo(1) }),
  job({ company: 'Whatnot', title: 'Software Engineer, New Grad', source: 'greenhouse', status: 'discovered', salaryMin: 130000, salaryMax: 165000, postedAt: daysAgo(1), firstSeen: daysAgo(0, 10), location: 'Los Angeles, CA', remoteType: 'hybrid' }),
  job({ company: 'Mercury', title: 'Full Stack Engineer, Growth', source: 'lever', status: 'discovered', salaryMin: 145000, salaryMax: 187000, postedAt: daysAgo(3), firstSeen: daysAgo(2), location: 'San Francisco, CA', remoteType: 'hybrid' }),
  job({ company: 'Zapier', title: 'Frontend Engineer', source: 'remoteok', status: 'discovered', salaryMin: 128000, salaryMax: 168000, salaryPredicted: true, postedAt: daysAgo(4), firstSeen: daysAgo(3) }),
  // ------------------------------- screened -------------------------------
  job({ company: 'Vercel', title: 'Software Engineer, Next.js Ecosystem', source: 'greenhouse', status: 'screened', fitScore: 91, salaryMin: 160000, salaryMax: 220000, postedAt: daysAgo(5), firstSeen: daysAgo(4) }),
  job({ company: 'Retool', title: 'Software Engineer, Product', source: 'greenhouse', status: 'screened', fitScore: 84, salaryMin: 150000, salaryMax: 200000, location: 'New York, NY', remoteType: 'hybrid', postedAt: daysAgo(6), firstSeen: daysAgo(5) }),
  job({ company: 'Render', title: 'Product Engineer', source: 'ashby', status: 'screened', fitScore: 88, salaryMin: 145000, salaryMax: 195000, postedAt: daysAgo(4), firstSeen: daysAgo(3) }),
  job({ company: 'Chime', title: 'Software Engineer, Mobile (React Native)', source: 'lever', status: 'screened', fitScore: 89, salaryMin: 148000, salaryMax: 198000, location: 'Chicago, IL', remoteType: 'hybrid', postedAt: daysAgo(7), firstSeen: daysAgo(6) }),
  // ------------------------------- tailoring ------------------------------
  job({ company: 'Ramp', title: 'Software Engineer, Frontend', source: 'greenhouse', status: 'tailoring', fitScore: 87, salaryMin: 155000, salaryMax: 210000, location: 'New York, NY', remoteType: 'hybrid', postedAt: daysAgo(8), firstSeen: daysAgo(7) }),
  job({ company: 'Gusto', title: 'Full Stack Engineer, Payments', source: 'greenhouse', status: 'tailoring', fitScore: 82, salaryMin: 139000, salaryMax: 172000, location: 'Denver, CO', remoteType: 'hybrid', postedAt: daysAgo(9), firstSeen: daysAgo(8) }),
  // --------------------------- ready_for_review --------------------------
  job({ company: 'Plaid', title: 'Software Engineer, Web', source: 'lever', status: 'ready_for_review', fitScore: 90, salaryMin: 152000, salaryMax: 203000, postedAt: daysAgo(10), firstSeen: daysAgo(9) }),
  job({ company: 'Airtable', title: 'Software Engineer, Growth', source: 'greenhouse', status: 'ready_for_review', fitScore: 78, salaryMin: 143000, salaryMax: 185000, location: 'Austin, TX', remoteType: 'hybrid', postedAt: daysAgo(11), firstSeen: daysAgo(10) }),
  // -------------------------------- applied -------------------------------
  job({ company: 'Stripe', title: 'Software Engineer, Payments Platform', source: 'greenhouse', status: 'applied', fitScore: 93, salaryMin: 165000, salaryMax: 230000, location: 'South San Francisco, CA', remoteType: 'hybrid', postedAt: daysAgo(14), firstSeen: daysAgo(13) }),
  job({ company: 'Figma', title: 'Software Engineer, Early Career', source: 'greenhouse', status: 'applied', fitScore: 86, salaryMin: 149000, salaryMax: 188000, location: 'San Francisco, CA', remoteType: 'hybrid', postedAt: daysAgo(12), firstSeen: daysAgo(11) }),
  job({ company: 'Twilio', title: 'Software Engineer 2, Messaging', source: 'freehire', status: 'applied', fitScore: 81, salaryMin: 135000, salaryMax: 170000, postedAt: daysAgo(13), firstSeen: daysAgo(12) }),
  job({ company: 'GitLab', title: 'Fullstack Engineer, Growth', source: 'remotive', status: 'applied', fitScore: 83, salaryMin: 137000, salaryMax: 179000, postedAt: daysAgo(9), firstSeen: daysAgo(8) }),
  job({ company: 'NASA Johnson Space Center', title: 'Software Engineer (AST, Direct Hire)', source: 'usajobs', status: 'applied', fitScore: 74, salaryMin: 104000, salaryMax: 135000, location: 'Houston, TX', remoteType: 'onsite', postedAt: daysAgo(16), firstSeen: daysAgo(15) }),
  // ------------------------------- interview ------------------------------
  job({ company: 'Datadog', title: 'Software Engineer, Dashboards', source: 'greenhouse', status: 'interview', fitScore: 92, salaryMin: 158000, salaryMax: 215000, location: 'New York, NY', remoteType: 'hybrid', postedAt: daysAgo(21), firstSeen: daysAgo(20) }),
  job({ company: 'Cloudflare', title: 'Software Engineer, Dashboard Platform', source: 'lever', status: 'interview', fitScore: 88, salaryMin: 154000, salaryMax: 202000, location: 'Austin, TX', remoteType: 'hybrid', postedAt: daysAgo(24), firstSeen: daysAgo(23) }),
  // --------------------------------- offer --------------------------------
  job({ company: 'Notion', title: 'Software Engineer, Product', source: 'ashby', status: 'offer', fitScore: 94, salaryMin: 160000, salaryMax: 218000, location: 'San Francisco, CA', remoteType: 'hybrid', postedAt: daysAgo(35), firstSeen: daysAgo(34) }),
  // -------------------------------- closed --------------------------------
  job({ company: 'Discord', title: 'Software Engineer, Web Platform', source: 'greenhouse', status: 'rejected', fitScore: 85, salaryMin: 152000, salaryMax: 196000, postedAt: daysAgo(40), firstSeen: daysAgo(39) }),
  job({ company: 'Robinhood', title: 'Software Engineer, Brokerage', source: 'greenhouse', status: 'rejected', fitScore: 79, salaryMin: 146000, salaryMax: 188000, location: 'Menlo Park, CA', remoteType: 'onsite', postedAt: daysAgo(45), firstSeen: daysAgo(44) }),
  job({ company: 'DoorDash', title: 'Software Engineer, Logistics', source: 'linkedin', status: 'no_response', fitScore: 77, salaryMin: 150000, salaryMax: 195000, location: 'Seattle, WA', remoteType: 'hybrid', postedAt: daysAgo(38), firstSeen: daysAgo(37) }),
  job({ company: 'Affirm', title: 'Software Engineer, Consumer', source: 'lever', status: 'withdrawn', fitScore: 72, salaryMin: 142000, salaryMax: 178000, postedAt: daysAgo(30), firstSeen: daysAgo(29) }),
  job({ company: 'Instacart', title: 'Backend Engineer, Fulfillment', source: 'hn_hiring', status: 'skipped', fitScore: 58, salaryMin: 140000, salaryMax: 185000, location: 'San Francisco, CA', remoteType: 'onsite', postedAt: daysAgo(18), firstSeen: daysAgo(17) }),
  job({
    company: 'QuickHire Global', title: 'Sr. Developer — $300k, start today!', source: 'linkedin', status: 'quarantined',
    fitScore: null, salaryMin: 250000, salaryMax: 300000, salaryPredicted: false, postedAt: daysAgo(2), firstSeen: daysAgo(2),
    legitVerdict: 'scam',
    legitReasons: [
      'Identical posting text found under 14 different company names',
      'Salary 2.1x above market band for the stated seniority',
      'Contact address is a free-mail domain (quickhireglobal@gmail.com)',
      'No company web presence or business registration found',
      'Asks applicants to pay for a "background check kit"',
    ],
  }),
  job({ company: 'Hex', title: 'Product Engineer, Notebooks', source: 'weworkremotely', status: 'discovered', salaryMin: 150000, salaryMax: 200000, salaryPredicted: true, postedAt: daysAgo(1), firstSeen: daysAgo(0, 11) }),
  job({ company: 'Anduril (via recruiter)', title: 'Full Stack Software Engineer, Mission Autonomy', source: 'manual', status: 'screened', fitScore: 80, salaryMin: 155000, salaryMax: 205000, location: 'Costa Mesa, CA', remoteType: 'onsite', managed: 'manual', postedAt: daysAgo(3), firstSeen: daysAgo(3) }),
];

// ---------------------------------------------------------------------------
// Applications — for every job at or past tailoring
// ---------------------------------------------------------------------------
const byCompany = (c: string): Job => {
  const j = JOBS.find((x) => x.company === c);
  if (!j) throw new Error(`fixture missing ${c}`);
  return j;
};

let appSeq = 1;
function app(company: string, o: Partial<Application> = {}): Application {
  const j = byCompany(company);
  return {
    id: appSeq++,
    jobId: j.id,
    status: j.status,
    gate: 'review',
    approvedAt: null,
    submittedAt: null,
    resumePath: `/files/applications/${company.toLowerCase().replace(/\W+/g, '_')}/resume.pdf`,
    coverLetterPath: `/files/applications/${company.toLowerCase().replace(/\W+/g, '_')}/cover_letter.pdf`,
    answers: {
      'Are you authorized to work in the US?': 'Yes',
      'Will you now or in the future require sponsorship?': 'No',
      'Are you willing to relocate?': 'Yes, anywhere in the US',
      'Desired salary': 'Flagged for Giovanni — not auto-answered',
    },
    archiveDir: `documents/applications/${company.toLowerCase().replace(/\W+/g, '_')}`,
    notes: [],
    ...o,
  };
}

export const APPLICATIONS: Application[] = [
  app('Ramp', { resumePath: null, coverLetterPath: null, answers: null, notes: [{ date: daysAgo(0, 10), text: 'Tailoring worker drafting resume v2 (reviewer flagged weak keyword coverage for GraphQL).' }] }),
  app('Gusto', { resumePath: null, coverLetterPath: null, answers: null }),
  app('Plaid', { notes: [{ date: daysAgo(1), text: 'Drafts passed ATS text-layer check. 1 page each. Waiting for your review.' }] }),
  app('Airtable'),
  app('Stripe', { approvedAt: daysAgo(13), submittedAt: daysAgo(13), notes: [{ date: daysAgo(13), text: 'Submitted via Greenhouse. Confirmation #GH-88412 screenshot archived.' }] }),
  app('Figma', { approvedAt: daysAgo(11), submittedAt: daysAgo(11) }),
  app('Twilio', { approvedAt: daysAgo(12), submittedAt: daysAgo(12) }),
  app('GitLab', { approvedAt: daysAgo(8), submittedAt: daysAgo(8) }),
  app('NASA Johnson Space Center', { approvedAt: daysAgo(15), submittedAt: daysAgo(15), notes: [{ date: daysAgo(15), text: 'USAJobs federal resume format used (no 1-page limit).' }] }),
  app('Datadog', { approvedAt: daysAgo(19), submittedAt: daysAgo(19), notes: [{ date: daysAgo(4), text: 'Recruiter screen passed. Technical interview scheduled.' }] }),
  app('Cloudflare', { approvedAt: daysAgo(22), submittedAt: daysAgo(22), notes: [{ date: daysAgo(2), text: 'Hiring manager round scheduled.' }] }),
  app('Notion', { approvedAt: daysAgo(33), submittedAt: daysAgo(33), notes: [{ date: daysAgo(1), text: 'Verbal offer! Written offer expected within 3 business days.' }] }),
  app('Discord', { approvedAt: daysAgo(38), submittedAt: daysAgo(38), notes: [{ date: daysAgo(6), text: 'Rejection after onsite. Retro captured → profile updated.' }] }),
  app('Robinhood', { approvedAt: daysAgo(43), submittedAt: daysAgo(43) }),
  app('DoorDash', { approvedAt: daysAgo(36), submittedAt: daysAgo(36), notes: [{ date: daysAgo(1), text: 'Quiet 35 days. 2 follow-ups sent — max reached, auto-closed as no_response.' }] }),
  app('Affirm', { approvedAt: daysAgo(28), submittedAt: daysAgo(28), notes: [{ date: daysAgo(20), text: 'Withdrawn — accepted Datadog interview loop instead.' }] }),
];

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
export const QUEUE_TASKS: QueueTask[] = [
  {
    id: 101, type: 'discover', state: 'running',
    payload: { trigger: 'schedule' },
    cursor: { source: 'remoteok', page: 2, item: 14 },
    runAfter: null, attempts: 1, lastError: null, humanPrompt: null,
    createdAt: daysAgo(0, 9), updatedAt: new Date(NOW - 40000).toISOString(),
  },
  {
    id: 102, type: 'apply', state: 'needs_human',
    payload: { company: 'Airtable', jobId: byCompany('Airtable').id },
    cursor: { step: 'form_fill', field: 7 },
    runAfter: null, attempts: 1, lastError: null,
    humanPrompt: 'Greenhouse showed an hCaptcha on the Airtable application. The browser window is open and waiting — solve it, then click "I did it".',
    createdAt: daysAgo(0, 8), updatedAt: new Date(NOW - 600000).toISOString(),
  },
  {
    id: 103, type: 'tailor', state: 'running',
    payload: { company: 'Ramp', jobId: byCompany('Ramp').id, phase: 'reviewer' },
    cursor: { draft: 2 },
    runAfter: null, attempts: 1, lastError: null, humanPrompt: null,
    createdAt: daysAgo(0, 7), updatedAt: new Date(NOW - 15000).toISOString(),
  },
  {
    id: 104, type: 'email_scan', state: 'waiting_session',
    payload: { interval: 'periodic' },
    cursor: null, runAfter: inDays(0, 18), attempts: 0, lastError: null,
    humanPrompt: null, createdAt: daysAgo(0, 6), updatedAt: daysAgo(0, 6),
  },
  {
    id: 105, type: 'score', state: 'pending',
    payload: { company: 'Linear', jobId: byCompany('Linear').id },
    cursor: null, runAfter: null, attempts: 0, lastError: null, humanPrompt: null,
    createdAt: daysAgo(0, 9), updatedAt: daysAgo(0, 9),
  },
  {
    id: 106, type: 'score', state: 'pending',
    payload: { company: 'Hex', jobId: byCompany('Hex').id },
    cursor: null, runAfter: null, attempts: 0, lastError: null, humanPrompt: null,
    createdAt: daysAgo(0, 10), updatedAt: daysAgo(0, 10),
  },
  {
    id: 107, type: 'followup', state: 'pending',
    payload: { company: 'Figma', applicationId: 6, followupNumber: 1 },
    cursor: null, runAfter: inDays(1, 9), attempts: 0, lastError: null, humanPrompt: null,
    createdAt: daysAgo(1), updatedAt: daysAgo(1),
  },
  {
    id: 108, type: 'discover', state: 'failed',
    payload: { source: 'linkedin' },
    cursor: { source: 'linkedin', page: 1 },
    runAfter: null, attempts: 3,
    lastError: 'HTTP 429 from jobs-guest endpoint after 3 backoff retries; source budget exhausted for today.',
    humanPrompt: null, createdAt: daysAgo(1, 8), updatedAt: daysAgo(1, 9),
  },
  {
    id: 109, type: 'prep_guide', state: 'done',
    payload: { company: 'Datadog', eventId: 1 },
    cursor: null, runAfter: null, attempts: 1, lastError: null, humanPrompt: null,
    createdAt: daysAgo(3), updatedAt: daysAgo(3),
  },
];

export const BUDGETS: SourceBudget[] = [
  { source: 'ats_boards', health: 'ok', remainingTokens: 412, refillPerHour: 120, lastRun: new Date(NOW - 1800000).toISOString(), nextRun: inDays(0, new Date(NOW + 3600000).getHours()), enabled: true },
  { source: 'remoteok', health: 'ok', remainingTokens: 3, refillPerHour: 1, lastRun: new Date(NOW - 40000).toISOString(), nextRun: new Date(NOW + 120000).toISOString(), enabled: true },
  { source: 'remotive', health: 'degraded', remainingTokens: 0, refillPerHour: 0.08, lastRun: daysAgo(0, 6), nextRun: inDays(1, 6), enabled: true },
  { source: 'weworkremotely', health: 'ok', remainingTokens: 6, refillPerHour: 2, lastRun: daysAgo(0, 8), nextRun: new Date(NOW + 5400000).toISOString(), enabled: true },
  { source: 'hn_hiring', health: 'ok', remainingTokens: 20, refillPerHour: 4, lastRun: daysAgo(0, 7), nextRun: new Date(NOW + 7200000).toISOString(), enabled: true },
  { source: 'freehire', health: 'ok', remainingTokens: 55, refillPerHour: 30, lastRun: new Date(NOW - 900000).toISOString(), nextRun: new Date(NOW + 2700000).toISOString(), enabled: true },
  { source: 'linkedin', health: 'down', remainingTokens: 0, refillPerHour: 2, lastRun: daysAgo(1, 9), nextRun: inDays(1, 8), enabled: true },
  { source: 'adzuna', health: 'ok', remainingTokens: 0, refillPerHour: 0, lastRun: null, nextRun: null, enabled: false },
  { source: 'usajobs', health: 'ok', remainingTokens: 0, refillPerHour: 0, lastRun: null, nextRun: null, enabled: false },
];

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------
export const EMAILS: EmailRecord[] = [
  {
    id: 1, threadKey: 'datadog-1', direction: 'inbound', classification: 'interview_invite', applicationId: 10,
    subject: 'Datadog — Technical Interview Invitation',
    summary: 'Recruiter Sarah Kim invites you to a 60-min technical interview (dashboards team). Proposed slot accepted for tomorrow 2:00 PM CT.',
    bodyMd: 'Hi Giovanni,\n\nGreat news — the team enjoyed your recruiter screen! We would like to invite you to a **60-minute technical interview** with two engineers from the Dashboards team.\n\n**When:** Tomorrow, 2:00–3:00 PM CT\n**Where:** Zoom (link in calendar invite)\n\nThe interview covers a practical React/TypeScript exercise and a systems discussion.\n\nBest,\nSarah Kim · Technical Recruiter, Datadog',
    needsApproval: false, approvedAt: null, sentAt: null, receivedAt: daysAgo(4, 10),
  },
  {
    id: 2, threadKey: 'notion-1', direction: 'inbound', classification: 'reply_accepted', applicationId: 12,
    subject: 'Notion — Offer details to follow',
    summary: 'Hiring manager confirms the team is extending an offer; written details within 3 business days.',
    bodyMd: 'Giovanni,\n\nIt was a pleasure meeting you through this process. I am delighted to share that **we will be extending you an offer** for the Software Engineer, Product role.\n\nOur recruiting team will send the written details within 3 business days.\n\n— Priya, EM at Notion',
    needsApproval: false, approvedAt: null, sentAt: null, receivedAt: daysAgo(1, 15),
  },
  {
    id: 3, threadKey: 'discord-1', direction: 'inbound', classification: 'reply_rejected', applicationId: 13,
    subject: 'Your application to Discord',
    summary: 'Rejection after onsite: strong frontend signal, looking for deeper distributed-systems experience. Door open in 12 months.',
    bodyMd: 'Hi Giovanni,\n\nThank you for the time you invested in our process. The panel was impressed with your frontend depth and product sense, but we have decided not to move forward — we need deeper distributed-systems experience for this particular seat.\n\nWe would genuinely welcome another application in 12 months.\n\n— Discord Recruiting',
    needsApproval: false, approvedAt: null, sentAt: null, receivedAt: daysAgo(6, 11),
  },
  {
    id: 4, threadKey: 'stripe-1', direction: 'inbound', classification: 'reply_rejected', applicationId: 5,
    subject: 'Update on your Stripe application',
    summary: 'Auto-rejection at resume screen for Payments Platform; encouraged to apply to Early Career pipeline.',
    bodyMd: 'Hi Giovanni,\n\nThank you for applying to Stripe. After careful review we will not be moving forward with the Payments Platform role. We encourage you to explore our **Early Career** openings.\n\n— Stripe Recruiting',
    needsApproval: false, approvedAt: null, sentAt: null, receivedAt: daysAgo(2, 9),
  },
  {
    id: 5, threadKey: 'recruiter-anduril', direction: 'inbound', classification: 'opportunity', applicationId: null,
    subject: 'Full Stack SWE — Mission Autonomy (Anduril)',
    summary: 'External recruiter outreach: full-stack role at Anduril, Costa Mesa. Job record created and screened (fit 80).',
    bodyMd: 'Hi Giovanni,\n\nI came across your profile (nice work on Rigaly!) and think you would be a strong fit for a **Full Stack Software Engineer** opening on Anduril\'s Mission Autonomy team.\n\nComp band is $155k–$205k + equity. Would you be open to a 15-minute intro call this week?\n\n— Marcus Webb, Talent Partner',
    needsApproval: false, approvedAt: null, sentAt: null, receivedAt: daysAgo(3, 14),
  },
  {
    id: 6, threadKey: 'cloudflare-1', direction: 'inbound', classification: 'other', applicationId: 11,
    subject: 'Cloudflare interview logistics',
    summary: 'Coordinator confirms hiring-manager round Thursday 10:30 AM CT; panel names shared.',
    bodyMd: 'Hi Giovanni,\n\nConfirming your **hiring manager interview** on Thursday at 10:30 AM CT with Dana Reyes (EM) and Tom Iwata (Staff Eng). 45 minutes, Google Meet.\n\n— Cloudflare Recruiting Coordination',
    needsApproval: false, approvedAt: null, sentAt: null, receivedAt: daysAgo(2, 16),
  },
  // ------------------------------- outbox --------------------------------
  {
    id: 7, threadKey: 'recruiter-anduril', direction: 'outbound', classification: 'other', applicationId: null,
    subject: 'Re: Full Stack SWE — Mission Autonomy (Anduril)',
    summary: 'Drafted reply accepting the intro call, proposing Wed/Thu afternoon slots.',
    bodyMd: 'Hi Marcus,\n\nThank you for reaching out, and for the kind words about Rigaly. I would be glad to set up a 15 minute intro call. I am available Wednesday or Thursday afternoon Central time; happy to work around your schedule if another slot is easier.\n\nA quick note on fit: I build full-stack products end to end (React, React Native, Next.js, Express, TypeScript) and I am authorized to work in the US for any employer, with full willingness to relocate to Costa Mesa.\n\nBest regards,\nGiovanni Boscan\n(832) 970-9338',
    needsApproval: true, approvedAt: null, sentAt: null, receivedAt: null,
  },
  {
    id: 8, threadKey: 'figma-fu-1', direction: 'outbound', classification: 'followup', applicationId: 6,
    subject: 'Following up — Software Engineer, Early Career application',
    summary: 'Follow-up #1 for Figma (quiet 11 days). Reiterates interest, links portfolio.',
    bodyMd: 'Hi Figma Recruiting,\n\nI hope your week is going well. I applied for the Software Engineer, Early Career role on ' + new Date(NOW - 11 * DAY).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) + ' and wanted to reiterate my strong interest.\n\nSince applying, I shipped a new analytics dashboard for Rigaly, the loyalty platform I founded (10+ businesses, 500+ customers). My portfolio is at gii.ooo if helpful.\n\nThank you for your time and consideration.\n\nBest regards,\nGiovanni Boscan',
    needsApproval: true, approvedAt: null, sentAt: null, receivedAt: null,
  },
  {
    id: 9, threadKey: 'twilio-fu-1', direction: 'outbound', classification: 'followup', applicationId: 7,
    subject: 'Following up — Software Engineer 2, Messaging',
    summary: 'Follow-up #1 for Twilio, approved and sent 3 days ago.',
    bodyMd: 'Hi Twilio Recruiting,\n\nI wanted to follow up on my application for Software Engineer 2, Messaging…',
    needsApproval: false, approvedAt: daysAgo(3, 9), sentAt: daysAgo(3, 9), receivedAt: null,
  },
  {
    id: 10, threadKey: 'datadog-1', direction: 'outbound', classification: 'other', applicationId: 10,
    subject: 'Re: Datadog — Technical Interview Invitation',
    summary: 'Reply confirming tomorrow 2:00 PM CT. Approved and sent.',
    bodyMd: 'Hi Sarah,\n\nThank you — tomorrow at 2:00 PM CT works perfectly. Looking forward to meeting the team.\n\nBest,\nGiovanni',
    needsApproval: false, approvedAt: daysAgo(4, 8), sentAt: daysAgo(4, 8), receivedAt: null,
  },
];

// ---------------------------------------------------------------------------
// Schedule + prep
// ---------------------------------------------------------------------------
export const SCHEDULE: ScheduleEvent[] = [
  { id: 1, type: 'interview', applicationId: 10, title: 'Datadog — Technical Interview (Dashboards)', startsAt: inDays(1, 14), endsAt: inDays(1, 15), prepGuidePath: 'documents/applications/datadog/study-guide.md', company: 'Datadog' },
  { id: 2, type: 'interview', applicationId: 11, title: 'Cloudflare — Hiring Manager Round', startsAt: inDays(3, 10, 30), endsAt: inDays(3, 11, 15), prepGuidePath: 'documents/applications/cloudflare/study-guide.md', company: 'Cloudflare' },
  { id: 3, type: 'prep', applicationId: 10, title: 'prep:Datadog — mock dashboard exercise', startsAt: inDays(0, 18), endsAt: inDays(0, 19), prepGuidePath: 'documents/applications/datadog/study-guide.md', company: 'Datadog' },
  { id: 4, type: 'deadline', applicationId: 12, title: 'Notion written offer — respond by', startsAt: inDays(5, 17), endsAt: null, prepGuidePath: null, company: 'Notion' },
  { id: 5, type: 'followup_due', applicationId: 6, title: 'Follow-up #1 due — Figma', startsAt: inDays(1, 9), endsAt: null, prepGuidePath: null, company: 'Figma' },
  { id: 6, type: 'deadline', applicationId: null, title: 'Whatnot New Grad posting closes', startsAt: inDays(6, 23), endsAt: null, prepGuidePath: null, company: 'Whatnot' },
];

export const PREP_TASKS: PrepTask[] = [
  { id: 1, eventId: 1, skillTag: 'react', text: 'Re-read React 18 concurrent rendering + useSyncExternalStore notes', doneAt: daysAgo(1, 20) },
  { id: 2, eventId: 1, skillTag: 'react', text: 'Build a 30-min practice widget: live-updating time-series dashboard card', doneAt: daysAgo(0, 21) },
  { id: 3, eventId: 1, skillTag: 'typescript', text: 'Review advanced generics + discriminated unions (Datadog loves typed events)', doneAt: null },
  { id: 4, eventId: 1, skillTag: 'system_design', text: 'Sketch: metrics ingestion → aggregation → dashboard query path', doneAt: null },
  { id: 5, eventId: 1, skillTag: 'behavioral', text: 'STAR: Rigaly outage story (Stripe webhook retries) — practice out loud', doneAt: daysAgo(0, 22) },
  { id: 6, eventId: 1, skillTag: 'company', text: 'Skim Datadog Q1 earnings + Dashboards product changelog', doneAt: null },
  { id: 7, eventId: 2, skillTag: 'behavioral', text: 'STAR: leading VIBE team-of-6 through Jira sprint crunch', doneAt: daysAgo(0, 20) },
  { id: 8, eventId: 2, skillTag: 'company', text: 'Read Cloudflare Workers + Pages docs; note dashboard platform architecture', doneAt: null },
  { id: 9, eventId: 2, skillTag: 'system_design', text: 'Prepare questions on edge rendering trade-offs', doneAt: null },
  { id: 10, eventId: 2, skillTag: 'career', text: 'Refine "why Cloudflare, why now" 90-second answer', doneAt: daysAgo(1, 18) },
];

export const SKILLS: SkillProgress[] = [
  { skill: 'React & Frontend', totalTasks: 12, doneTasks: 9, evidence: ['Datadog prep: concurrent rendering', 'Practice dashboard widget', 'Upskill report: React Server Components'] },
  { skill: 'System Design', totalTasks: 10, doneTasks: 4, evidence: ['Metrics pipeline sketch', 'Upskill: caching strategies module'] },
  { skill: 'TypeScript Depth', totalTasks: 8, doneTasks: 6, evidence: ['Generics review', 'Discriminated unions drill'] },
  { skill: 'Behavioral (STAR)', totalTasks: 9, doneTasks: 7, evidence: ['Rigaly outage story', 'VIBE team story', 'Why-company drills ×3'] },
  { skill: 'Distributed Systems', totalTasks: 11, doneTasks: 3, evidence: ['Discord rejection retro → learning plan created'] },
  { skill: 'SQL & Data Modeling', totalTasks: 6, doneTasks: 5, evidence: ['Supabase RLS patterns', 'Window functions drill'] },
];

// ---------------------------------------------------------------------------
// Connections, credentials, profile, settings, feedback
// ---------------------------------------------------------------------------
export const CONNECTIONS: Connection[] = [
  { name: 'server', status: 'ok', detail: 'v0.4.2 · localhost:4750', lastOk: new Date(NOW - 5000).toISOString() },
  { name: 'claude_code', status: 'ok', detail: 'Subscription auth · headless runner idle', lastOk: new Date(NOW - 60000).toISOString() },
  { name: 'gmail', status: 'waiting_session', detail: 'Session-only connector — open a Claude session to run 1 queued email task', lastOk: daysAgo(0, 6) },
  { name: 'playwright', status: 'ok', detail: 'Chromium 126 · persistent profile · 2 applies today', lastOk: new Date(NOW - 300000).toISOString() },
  { name: 'chrome', status: 'down', detail: 'Claude in Chrome extension not detected — needed for LinkedIn applies', lastOk: daysAgo(2) },
  { name: 'ats_boards', status: 'ok', detail: 'Greenhouse · Lever · Ashby — 18,240 company slugs indexed', lastOk: new Date(NOW - 1800000).toISOString() },
  { name: 'remoteok', status: 'ok', detail: 'Last fetch 200 OK · 94 new postings', lastOk: new Date(NOW - 40000).toISOString() },
  { name: 'remotive', status: 'degraded', detail: 'Daily budget (2 fetches) exhausted — resumes tomorrow 6:00 AM', lastOk: daysAgo(0, 6) },
  { name: 'weworkremotely', status: 'ok', detail: 'RSS feed healthy', lastOk: daysAgo(0, 8) },
  { name: 'hn_hiring', status: 'ok', detail: 'July thread · 312 comments parsed', lastOk: daysAgo(0, 7) },
  { name: 'freehire', status: 'ok', detail: '3.4M postings · US filter active', lastOk: new Date(NOW - 900000).toISOString() },
  { name: 'linkedin', status: 'degraded', detail: 'jobs-guest rate-limited (429) — backing off until tomorrow', lastOk: daysAgo(1, 9) },
  { name: 'adzuna', status: 'needs_key', detail: 'Free API key unlocks salary-annotated coverage', lastOk: null },
  { name: 'usajobs', status: 'needs_key', detail: 'Free API key unlocks federal roles with structured pay', lastOk: null },
];

export const CREDENTIALS: CredentialMeta[] = [
  { site: 'greenhouse.io', username: 'giovabos11@gmail.com', maskedPassword: '••••••••••••', hasCaptcha: false, notes: 'Auto-registered during Stripe apply', createdAt: daysAgo(13) },
  { site: 'lever.co', username: 'giovabos11@gmail.com', maskedPassword: '••••••••••', hasCaptcha: false, notes: null, createdAt: daysAgo(22) },
  { site: 'myworkday.com', username: 'giovabos11@gmail.com', maskedPassword: '••••••••••••••', hasCaptcha: true, notes: 'Workday CAPTCHA on login — expect a needs-human pause', createdAt: daysAgo(15) },
  { site: 'usajobs.gov', username: 'giovabos11', maskedPassword: '••••••••••', hasCaptcha: false, notes: 'Login.gov 2FA via phone', createdAt: daysAgo(15) },
];

export const PROFILE: UserProfile = {
  fullName: 'Giovanni Enrique Boscan Anez',
  email: 'giovabos11@gmail.com',
  phone: '+1 (832) 970-9338',
  location: 'Dallas, TX 75231',
  links: [
    { label: 'Portfolio', url: 'https://gii.ooo' },
    { label: 'GitHub', url: 'https://github.com/giovabos11' },
    { label: 'LinkedIn', url: 'https://www.linkedin.com/in/giovanni-boscan/' },
    { label: 'Rigaly', url: 'https://www.rigaly.com' },
  ],
  documents: [
    { name: 'resume.pdf', path: 'documents/cv/resume.pdf', modifiedAt: daysAgo(4) },
    { name: 'indeed_resume.pdf', path: 'documents/cv/indeed_resume.pdf', modifiedAt: daysAgo(30) },
    { name: 'career-context.md', path: 'documents/cv/career-context.md', modifiedAt: daysAgo(1) },
    { name: 'linkedin-profile-export.pdf', path: 'documents/linkedin/profile.pdf', modifiedAt: daysAgo(18) },
    { name: 'cover-letter-template.md', path: 'documents/cover-letters/template.md', modifiedAt: daysAgo(9) },
  ],
  country: 'US',
  profileReady: true,
};

export const SETTINGS: Settings = {
  gateMode: 'review',
  hybridThreshold: 80,
  discoveryIntervalMinutes: 360,
  emailScanIntervalMinutes: 120,
  country: 'US',
  applyDriver: 'playwright',
  perSourceGates: { linkedin: 'review' },
  followupAfterDays: 10,
  maxFollowups: 2,
};

export const FEEDBACK: FeedbackEntry[] = [
  {
    id: 1, kind: 'retro',
    inputMd: 'Discord onsite retro: system design round went poorly. I froze on the fan-out chat architecture question and never discussed back-pressure or delivery guarantees.',
    responseMd: '### Retro analysis\n\nThat is a **knowledge gap, not an interview-skills gap** — your behavioral rounds scored well.\n\n**Pattern detected:** 2 of your last 3 technical rejections cite distributed-systems depth.\n\n**Actions taken:**\n1. Added a *Distributed Systems* track to your skill plan (11 tasks)\n2. Future prep guides will always include one back-pressure / delivery-semantics drill\n3. Fit scoring now weights "deep distributed systems" requirements more conservatively (−5 experience) until 6+ tasks complete',
    planChange: { description: 'Add distributed-systems prep track; recalibrate experience weighting for DS-heavy roles', applied: true },
    createdAt: daysAgo(6, 15),
  },
  {
    id: 2, kind: 'idea',
    inputMd: 'Could we prioritize companies that sponsor SHPE or have LATAM engineering hubs? My Spanish is a differentiator.',
    responseMd: '### Great signal to exploit\n\nBilingual Spanish is genuinely scarce in US eng orgs.\n\n**Proposal:** add a +4 behavioral-fit bonus when a posting or company page mentions LATAM operations, Spanish, or SHPE partnership, and add 12 SHPE ProTips partner companies to the ATS sweep list.\n\nApprove to apply this to the scoring config.',
    planChange: { description: 'LATAM/bilingual fit bonus (+4 behavioral) + 12 SHPE partner companies added to ATS sweep', applied: false },
    createdAt: daysAgo(2, 11),
  },
  {
    id: 3, kind: 'concern',
    inputMd: 'The LinkedIn source keeps failing. Are we going to get my account flagged?',
    responseMd: 'Your concern is valid and the system is already conservative here:\n\n- LinkedIn discovery uses the **public jobs-guest endpoint** (no login), so your account is never touched during search\n- Applies on LinkedIn are **always review-gated and human-paced** (D5)\n- The current 429s are IP-level politeness signals; the worker backed off for 24h automatically\n\nNo config change recommended. The failed task will retry tomorrow morning.',
    planChange: null,
    createdAt: daysAgo(1, 10),
  },
];

// ---------------------------------------------------------------------------
// Artifacts (markdown docs served by /api/artifacts in mock mode)
// ---------------------------------------------------------------------------
export const ARTIFACTS: Record<string, string> = {
  'documents/applications/datadog/study-guide.md': `# Datadog — Technical Interview Study Guide

**Interview:** Tomorrow 2:00–3:00 PM CT · Zoom · 2 engineers, Dashboards team
**Format:** Practical React/TypeScript exercise (~35 min) + systems discussion (~20 min)

---

## 1. The likely exercise

Datadog dashboard interviews historically use a **live-updating widget** task: render a stream of metric points, aggregate client-side, keep the UI responsive.

Focus areas:
- \`useSyncExternalStore\` for subscription-driven data (their dashboards use it heavily)
- Windowed rendering — don't re-render 10k points; slice + memo
- Discriminated-union event types (\`{ type: 'point' } | { type: 'reset' }\`)

## 2. Systems discussion prep

Trace the path: **agent → intake → Kafka → aggregation tier → query service → dashboard**.

Be ready for:
- "What happens when a customer sends 100× normal volume?" → back-pressure, sampling, rate limits
- Pre-aggregation vs. query-time rollups (cost trade-off)
- Why p95/p99 matter more than averages on a latency widget

## 3. Your stories (STAR)

| Question | Story |
|---|---|
| Production incident | Rigaly Stripe webhook retry storm — idempotency keys fix |
| Ambiguous requirements | Rigaly POS terminal — scoped v1 with merchant interviews |
| Teamwork | VIBE admin portal, team of 6, Jira sprints |

## 4. Questions to ask them

1. How does the Dashboards team split work between the rendering engine and product features?
2. What does the on-call rotation look like for a frontend-heavy team?
3. Where do new engineers typically ship their first PR?

## 5. Logistics

- Zoom link in calendar invite · join 5 min early
- Have a quiet TypeScript playground ready (they allow your own editor)
`,
  'documents/applications/cloudflare/study-guide.md': `# Cloudflare — Hiring Manager Round Study Guide

**Interview:** Thursday 10:30–11:15 AM CT · Google Meet
**Panel:** Dana Reyes (EM), Tom Iwata (Staff Eng)

---

## 1. What this round is really testing

HM rounds at Cloudflare weight **ownership narrative + team fit** over algorithms.
Dana's public talks emphasize "engineers who run toward ambiguity."

Lead with: founding Rigaly → 5-app ecosystem → owning outcomes end to end.

## 2. Know their platform

- **Workers / Pages / Durable Objects** — be conversational, not expert
- The dashboard is a huge React SPA being incrementally migrated — migration stories land well
- Recent focus: developer platform consolidation

## 3. Likely questions

1. "Walk me through something you built end to end." → Rigaly, 90-second arc, metrics (10+ businesses, 500+ customers, 25% repeat-visit lift)
2. "Tell me about a disagreement in a team." → VIBE code-review standards story
3. "Why Cloudflare?" → edge platform + dashboard-scale frontend + your CDN curiosity from SMU networks course

## 4. Your questions for Dana

- How does the team balance platform migration work vs. new product surface?
- What separates a good first year from a great one on this team?
`,
  'documents/cv/career-context.md': '# Career Context\n\nSee CLAUDE.md — canonical profile for tailoring.',
};

export const RESET_PREVIEW: string[] = [
  'SQLite database: 28 jobs, 16 applications, 10 emails, 9 queue tasks',
  'Generated artifacts: 14 PDFs, 22 screenshots (documents/applications/**)',
  'Search cursors and per-source budget state',
  'Skill progress and prep-task history',
  'Feedback history (3 entries)',
  'KEPT: profile documents, CLAUDE.md, credentials vault (separate scope)',
];
