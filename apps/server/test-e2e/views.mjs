// Phase A — load all 8 views, audit console/network, assert meaningful content,
// full-page screenshot of each (dark default + light for two views).
// NOTE: content matching is case-insensitive because innerText reflects the
// CSS text-transform: uppercase used on section headers.
import { chromium } from 'playwright';
import { auditPage, gotoView, record, shoot, summarize } from './helpers.mjs';

const VIEWS = [
  { hash: '/', name: '01-mission-control', ready: 'h1:has-text("Mission Control")', expect: ['Nimbus Labs', 'Ready for review', 'Applied', 'Level'] },
  { hash: '/opportunities', name: '02-opportunities', ready: 'h1:has-text("Opportunities")', expect: ['Salary ranges', 'Ranked list'] },
  { hash: '/search', name: '03-search', ready: 'h1:has-text("Search")', expect: ['Discovery queue', 'All applications & tracked jobs', 'Source budgets'] },
  { hash: '/inbox', name: '04-inbox', ready: 'h1:has-text("Inbox")', expect: ['Replies', 'Follow-ups'] },
  { hash: '/schedule', name: '05-schedule', ready: 'h1:has-text("Schedule")', expect: ['Week', 'Agenda', 'Skill progress', 'Bluegrid'] },
  { hash: '/connections', name: '06-connections', ready: 'h1:has-text("Connections")', expect: ['Gmail', 'Dashboard'] },
  { hash: '/assistant', name: '07-assistant', ready: 'h1:has-text("Assistant")', expect: ['Ask anything', 'Feedback & course corrections'] },
  { hash: '/settings', name: '08-settings', ready: 'h1:has-text("Settings")', expect: ['Submission gate', 'Danger zone', 'Automation cadence', 'Hybrid'] },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const audit = auditPage(page);

for (const v of VIEWS) {
  try {
    await gotoView(page, v.hash, v.ready);
    const text = await page.evaluate(() => document.body.innerText);
    const lower = text.toLowerCase();
    const missing = v.expect.filter((s) => !lower.includes(s.toLowerCase()));
    record(`view ${v.hash} content`, missing.length === 0 && text.length > 400, missing.length ? `missing: ${missing.join(', ')}` : `${text.length} chars`);
    await shoot(page, v.name);
  } catch (err) {
    record(`view ${v.hash}`, false, String(err).slice(0, 300));
    try {
      await shoot(page, `${v.name}-FAILED`);
    } catch {
      /* ignore */
    }
  }
}

// Light-theme spot checks (toggle theme, re-shoot two views).
await page.evaluate(() => localStorage.setItem('ajs.theme', 'light'));
await gotoView(page, '/', 'h1:has-text("Mission Control")');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1:has-text("Mission Control")');
await page.waitForTimeout(1200);
await shoot(page, '01-mission-control-light');
await gotoView(page, '/settings', 'h1:has-text("Settings")');
await shoot(page, '08-settings-light');
await page.evaluate(() => localStorage.setItem('ajs.theme', 'dark'));

record('no console errors across views', audit.consoleErrors.length === 0, audit.consoleErrors.slice(0, 5).join(' | '));
record('no page (uncaught) errors', audit.pageErrors.length === 0, audit.pageErrors.slice(0, 5).join(' | '));
record('no failed network requests', audit.failedRequests.length === 0, audit.failedRequests.slice(0, 5).join(' | '));
record('no 4xx/5xx responses', audit.badResponses.length === 0, audit.badResponses.slice(0, 8).join(' | '));

await browser.close();
process.exit(summarize('views') ? 0 : 1);
