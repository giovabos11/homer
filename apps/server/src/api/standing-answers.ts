// Standing answers (contract §Standing answers — FR-9).
// The "answer once, reuse forever" values only the candidate can supply.
// Nothing here is ever agent-written: the API is the only writer.
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context';
import { parseBody } from './util';

const text = (max = 400) => z.string().max(max);

export const standingAnswersPatchSchema = z
  .object({
    salaryExpectation: text(),
    salaryMinAcceptable: z.number().min(0).max(100_000_000).nullable(),
    earliestStartDate: text(200),
    noticePeriod: text(200),
    citizenshipStatus: text(),
    requiresSponsorship: z.enum(['', 'yes', 'no']),
    securityClearance: text(200),
    eeoRace: text(200),
    eeoGender: text(200),
    eeoVeteran: text(200),
    eeoDisability: text(200),
    willingToRelocate: text(),
    preferredPronouns: text(80),
    referencesAvailable: text(),
  })
  .partial()
  .strict();

export function standingAnswerRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/standing-answers', (_req, res) => {
    res.json({ answers: ctx.standing.get(), missingCritical: ctx.standing.missingCritical() });
  });

  router.put('/standing-answers', (req, res) => {
    const patch = parseBody(standingAnswersPatchSchema, req);
    const answers = ctx.standing.patch(patch);
    res.json({ answers, missingCritical: ctx.standing.missingCritical() });
  });

  return router;
}
