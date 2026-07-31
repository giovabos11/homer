// Standing answers (contract §Standing answers — FR-9).
// The "answer once, reuse forever" values only the candidate can supply.
// Nothing here is ever agent-written: the API is the only writer.
//
// Validation is case-insensitive and value-normalizing. The dashboard sends
// canonical option values from dropdowns, but a hand-typed "No" must be as
// valid as "no": casing is not a mistake the user should have to fix.
import { Router } from 'express';
import { z } from 'zod';
import type { StandingAnswerKey } from '@shared/types';
import { canonicalizeStandingValue, normalizeYesNo } from '../docs/standing';
import type { AppContext } from '../context';
import { parseBody } from './util';

/** Free text, trimmed, snapped to a canonical option when it matches one. */
const answer = (key: StandingAnswerKey, max = 400) =>
  z
    .string()
    .max(max)
    .transform((v) => canonicalizeStandingValue(key, v));

/** '' | yes | no, in any casing or phrasing ("Yes", "NO", "None"). */
const yesNoAnswer = z
  .string()
  .max(120)
  .refine((v) => normalizeYesNo(v) !== null, {
    message: "expected '', 'yes', or 'no' (any casing)",
  })
  .transform((v) => normalizeYesNo(v)!);

export const standingAnswersPatchSchema = z
  .object({
    salaryExpectation: answer('salaryExpectation'),
    salaryMinAcceptable: z.number().min(0).max(100_000_000).nullable(),
    earliestStartDate: answer('earliestStartDate', 200),
    noticePeriod: answer('noticePeriod', 200),
    citizenshipStatus: answer('citizenshipStatus'),
    requiresSponsorship: yesNoAnswer,
    securityClearance: answer('securityClearance', 200),
    eeoRace: answer('eeoRace', 200),
    eeoGender: answer('eeoGender', 200),
    eeoVeteran: answer('eeoVeteran', 200),
    eeoDisability: answer('eeoDisability', 200),
    willingToRelocate: answer('willingToRelocate'),
    preferredPronouns: answer('preferredPronouns', 80),
    referencesAvailable: answer('referencesAvailable'),
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
