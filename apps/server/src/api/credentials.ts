// Credentials vault routes (contract §Credentials — FR-30, PRD D8, §8).
// Secrets go to the vault (Windows Credential Manager / encrypted file);
// SQLite stores references only. Reveal is localhost-only by server bind and
// every reveal is appended to data/audit.log.
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { credentialsMeta } from '../db/schema';
import { toCredentialMeta } from '../db/serialize';
import type { AppContext } from '../context';
import { ApiError, parseBody } from './util';

function auditLog(ctx: AppContext, line: string): void {
  const file = path.join(ctx.dataDir, 'audit.log');
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

export function credentialRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/credentials', (_req, res) => {
    const rows = ctx.db.select().from(credentialsMeta).orderBy(asc(credentialsMeta.site)).all();
    res.json(rows.map(toCredentialMeta));
  });

  router.post('/credentials', async (req, res) => {
    const body = parseBody(
      z.object({
        site: z.string().min(1),
        username: z.string().min(1),
        password: z.string().min(1),
        hasCaptcha: z.boolean().optional(),
        notes: z.string().nullish(),
      }),
      req,
    );
    const vaultRef = `cred:${body.site}`;
    await ctx.vault.set(vaultRef, body.password);
    const now = new Date().toISOString();
    const row = ctx.db
      .insert(credentialsMeta)
      .values({
        site: body.site,
        username: body.username,
        vaultRef,
        hasCaptcha: body.hasCaptcha ? 1 : 0,
        notes: body.notes ?? null,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: credentialsMeta.site,
        set: {
          username: body.username,
          vaultRef,
          hasCaptcha: body.hasCaptcha ? 1 : 0,
          notes: body.notes ?? null,
        },
      })
      .returning()
      .get();
    auditLog(ctx, `credential.stored site=${body.site} user=${body.username} backend=${ctx.vault.backend}`);
    res.status(201).json(toCredentialMeta(row));
  });

  // Reveal-on-click (masked in all list views). Access is logged (PRD FR-30).
  router.post('/credentials/:site/reveal', async (req, res) => {
    const site = req.params.site ?? '';
    const row = ctx.db.select().from(credentialsMeta).where(eq(credentialsMeta.site, site)).get();
    if (!row) throw new ApiError(404, 'not_found', `No credential for ${site}`);
    const password = await ctx.vault.get(row.vaultRef);
    if (password == null) throw new ApiError(404, 'not_found', `Vault has no secret for ${site} (ref ${row.vaultRef})`);
    auditLog(ctx, `credential.revealed site=${site} ip=${req.ip ?? 'local'}`);
    console.warn(`[vault] credential revealed for site=${site}`);
    res.json({ password });
  });

  router.delete('/credentials/:site', async (req, res) => {
    const site = req.params.site ?? '';
    const row = ctx.db.select().from(credentialsMeta).where(eq(credentialsMeta.site, site)).get();
    if (!row) throw new ApiError(404, 'not_found', `No credential for ${site}`);
    await ctx.vault.delete(row.vaultRef);
    ctx.db.delete(credentialsMeta).where(eq(credentialsMeta.site, site)).run();
    auditLog(ctx, `credential.deleted site=${site}`);
    res.json({ ok: true });
  });

  return router;
}
