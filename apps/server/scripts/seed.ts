// npm run db:seed — demo data for dashboard development. Idempotent-ish:
// running twice adds nothing new thanks to dedupe keys / fixed thread keys.
import path from 'node:path';
import { createContext } from '../src/context';
import { upsertJob } from '../src/sources/dedupe';
import { applications, emails, followups, jobs, prepTasks, scheduleEvents, skillsProgress } from '../src/db/schema';
import { writePlaceholderPdf } from '../src/workers/helpers';
import { eq } from 'drizzle-orm';

const ctx = createContext({ probes: { claudeVersion: async () => null, playwrightResolvable: async () => false } });
const now = new Date();
const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86400000).toISOString();
const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();

const seedJobs = [
  { source: 'freehire', company: 'Nimbus Labs', title: 'Full-Stack Engineer (TypeScript)', location: null, remoteType: 'remote' as const, salaryMin: 120000, salaryMax: 150000, fit: 88, status: 'ready_for_review' },
  { source: 'linkedin', company: 'Vector Systems', title: 'Software Engineer II', location: 'Dallas, TX', remoteType: 'hybrid' as const, salaryMin: 105000, salaryMax: 130000, fit: 82, status: 'applied' },
  { source: 'freehire', company: 'Bluegrid', title: 'React Native Developer', location: null, remoteType: 'remote' as const, salaryMin: 95000, salaryMax: 125000, fit: 91, status: 'interview' },
  { source: 'linkedin', company: 'Parallel Works', title: 'Backend Engineer (Node.js)', location: 'Austin, TX', remoteType: 'onsite' as const, salaryMin: 110000, salaryMax: 140000, fit: 74, status: 'screened' },
  { source: 'freehire', company: 'Hexa Cloud', title: 'Platform Engineer', location: null, remoteType: 'remote' as const, salaryMin: 130000, salaryMax: 165000, fit: 68, status: 'discovered' },
  { source: 'linkedin', company: 'Signalpath', title: 'Junior Software Engineer', location: 'Plano, TX', remoteType: 'hybrid' as const, salaryMin: 85000, salaryMax: 100000, fit: 79, status: 'skipped' },
];

let jobIds: number[] = [];
for (const [i, spec] of seedJobs.entries()) {
  const { job } = upsertJob(ctx.db, {
    source: spec.source,
    externalId: `seed-${i}`,
    canonicalUrl: `https://example.com/${spec.source}/jobs/seed-${i}`,
    company: spec.company,
    title: spec.title,
    location: spec.location,
    remoteType: spec.remoteType,
    salaryMin: spec.salaryMin,
    salaryMax: spec.salaryMax,
    salaryCurrency: 'USD',
    descriptionMd: `## ${spec.title}\n\n${spec.company} — seeded demo posting for dashboard development.\n\n- TypeScript, React, Node.js\n- Salary $${spec.salaryMin / 1000}k–$${spec.salaryMax / 1000}k`,
    postedAt: iso(i + 1),
    raw: { seed: true },
  }, new Date(now.getTime() - (i + 1) * 86400000));
  ctx.db.update(jobs)
    .set({
      status: spec.status,
      fitScore: spec.fit,
      fitBreakdownJson: JSON.stringify({ technical: spec.fit + 3, experience: spec.fit - 6, behavioral: spec.fit, career: spec.fit + 1, locationVeto: false }),
      legitVerdict: 'legit',
      legitReasonsJson: JSON.stringify(['seed: structural checks passed']),
    })
    .where(eq(jobs.id, job.id))
    .run();
  jobIds.push(job.id);
}

// Applications for the in-flight jobs.
const mkApp = (jobId: number, status: string, submittedDaysAgo: number | null) => {
  const existing = ctx.db.select().from(applications).where(eq(applications.jobId, jobId)).get();
  if (existing) return existing;
  const dir = path.join(ctx.artifactsDir, 'applications', String(jobId));
  const resume = writePlaceholderPdf(path.join(dir, 'resume.pdf'), `Resume seed job ${jobId}`);
  const cover = writePlaceholderPdf(path.join(dir, 'cover-letter.pdf'), `Cover letter seed job ${jobId}`);
  return ctx.db.insert(applications).values({
    jobId,
    status,
    gate: 'review',
    approvedAt: submittedDaysAgo != null ? iso(submittedDaysAgo) : null,
    submittedAt: submittedDaysAgo != null ? iso(submittedDaysAgo) : null,
    resumePath: resume,
    coverLetterPath: cover,
    answersJson: JSON.stringify({ 'Work authorization': 'Yes', 'Willing to relocate': 'Yes' }),
    auditJson: JSON.stringify([{ at: iso(submittedDaysAgo ?? 1), action: 'seed.created' }]),
    notesJson: JSON.stringify([{ date: iso(1), text: 'Seeded demo application' }]),
    createdAt: iso(submittedDaysAgo ?? 2),
    updatedAt: iso(0),
  }).returning().get();
};

const appReady = mkApp(jobIds[0]!, 'ready_for_review', null);
const appApplied = mkApp(jobIds[1]!, 'applied', 12);
const appInterview = mkApp(jobIds[2]!, 'interview', 8);

// Emails: one inbound invite, one outbox follow-up draft.
if (!ctx.db.select().from(emails).where(eq(emails.threadKey, 'seed-invite')).get()) {
  ctx.db.insert(emails).values({
    threadKey: 'seed-invite',
    direction: 'inbound',
    classification: 'interview_invite',
    applicationId: appInterview.id,
    subject: 'Interview — React Native Developer at Bluegrid',
    summary: 'Recruiter proposes a technical interview.',
    bodyMd: 'Hi Giovanni, we would love to schedule a technical interview next week.',
    receivedAt: iso(2),
  }).run();
}
if (!ctx.db.select().from(emails).where(eq(emails.threadKey, 'followup-app-' + appApplied.id)).get()) {
  ctx.db.insert(emails).values({
    threadKey: `followup-app-${appApplied.id}`,
    direction: 'outbound',
    classification: 'followup',
    applicationId: appApplied.id,
    subject: 'Following up: Software Engineer II application',
    summary: 'Follow-up draft awaiting your approval',
    bodyMd: 'Hi Vector Systems team,\n\nI applied for the Software Engineer II position and wanted to follow up.',
    needsApproval: 1,
  }).run();
  ctx.db.insert(followups).values({ applicationId: appApplied.id, dueAt: iso(0), draftMd: 'seed follow-up', status: 'drafted' }).run();
}

// Schedule: interview event + prep tasks; a deadline.
if (ctx.db.select().from(scheduleEvents).all().length === 0) {
  const event = ctx.db.insert(scheduleEvents).values({
    type: 'interview',
    applicationId: appInterview.id,
    title: 'Technical interview — Bluegrid',
    startsAt: future(4),
    company: 'Bluegrid',
  }).returning().get();
  const tasks = [
    { skillTag: 'react', text: 'Review React Native bridging and performance profiling' },
    { skillTag: 'typescript', text: 'Refresh advanced TypeScript generics' },
    { skillTag: 'system-design', text: 'Practice a mobile-first system design question' },
    { skillTag: 'behavioral', text: 'Rehearse STAR: shipping Rigaly 5-app ecosystem' },
  ];
  for (const [i, t] of tasks.entries()) {
    ctx.db.insert(prepTasks).values({ eventId: event.id, skillTag: t.skillTag, text: t.text, doneAt: i < 2 ? iso(1) : null }).run();
  }
  ctx.db.insert(scheduleEvents).values({
    type: 'deadline',
    title: 'Hexa Cloud posting closes',
    startsAt: future(6),
    company: 'Hexa Cloud',
  }).run();
}

// Skill evidence for the meters.
for (const skill of ['react', 'typescript', 'system-design']) {
  const existing = ctx.db.select().from(skillsProgress).where(eq(skillsProgress.skill, skill)).get();
  if (!existing) {
    ctx.db.insert(skillsProgress).values({ skill, level: 2, evidenceJson: JSON.stringify(['seed: upskill report']) }).run();
  }
}

void appReady;
console.log(`[db:seed] seeded ${jobIds.length} jobs, 3 applications, 2 emails, schedule + prep tasks`);
ctx.close();
