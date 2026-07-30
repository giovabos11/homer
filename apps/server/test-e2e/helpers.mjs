// Shared helpers for the QA E2E scripts (run with: node test-e2e/<script>.mjs from apps/server).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = 'http://localhost:5173';
export const API = 'http://127.0.0.1:4750';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const SHOTS_DIR = path.join(REPO_ROOT, 'qa-screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

export const results = [];
export function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

export function summarize(label) {
  const fails = results.filter((r) => !r.ok);
  console.log(`\n=== ${label}: ${results.length - fails.length}/${results.length} passed ===`);
  for (const f of fails) console.log(`  FAIL ${f.name} — ${f.detail}`);
  return fails.length === 0;
}

/** Console/network audit wiring for a page. Returns collectors. */
export function auditPage(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const badResponses = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 400));
  });
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 400)));
  page.on('requestfailed', (req) => {
    // Aborted requests (navigation, HMR teardown) are not failures.
    const failure = req.failure()?.errorText ?? '';
    if (failure.includes('ERR_ABORTED')) return;
    failedRequests.push(`${req.method()} ${req.url()} — ${failure}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  return { consoleErrors, pageErrors, failedRequests, badResponses };
}

/** Node-side SSE recorder against the server. */
export async function startSse(url = `${API}/api/events`) {
  const controller = new AbortController();
  const events = [];
  const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let type = null;
          let data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (type) {
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            } catch {
              /* keep raw */
            }
            events.push({ type, data: parsed ?? data, at: Date.now() });
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    events,
    has: (type, pred = () => true) => events.some((e) => e.type === type && pred(e.data)),
    stop: () => {
      controller.abort();
      return pump.catch(() => undefined);
    },
  };
}

export async function waitFor(fn, { timeout = 15000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function apiJson(pathname, init) {
  const res = await fetch(`${API}${pathname}`, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

export async function gotoView(page, hash, readySelector) {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(readySelector, { timeout: 20000 });
  // let animations/data settle
  await page.waitForTimeout(1200);
}

export async function shoot(page, name) {
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
