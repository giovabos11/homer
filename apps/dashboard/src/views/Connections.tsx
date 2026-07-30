import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Bot, CheckCircle2, Chrome, Eye, EyeOff, Globe2, Info, KeyRound, Loader2, Mail,
  MonitorSmartphone, Plug, Plus, RefreshCw, Server, ShieldAlert, Trash2, UserRound, Vault, Zap,
} from 'lucide-react';
import type { Connection, ConnectionName } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { fmtRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/common/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox, Tip } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { CONN_STATUS, ConnDot, sourceLabel } from '@/components/common/chips';

const CONN_LABEL: Partial<Record<ConnectionName, { label: string; icon: typeof Server }>> = {
  server: { label: 'Dashboard–Server link', icon: Server },
  claude_code: { label: 'Claude Code engine', icon: Bot },
  gmail: { label: 'Gmail (session-only)', icon: Mail },
  playwright: { label: 'Playwright browser', icon: MonitorSmartphone },
  chrome: { label: 'Claude in Chrome', icon: Chrome },
};

const COUNTRIES: { code: string; name: string; note?: string }[] = [
  { code: 'US', name: 'United States', note: 'full portal set' },
  { code: 'DK', name: 'Denmark', note: 'upstream portals' },
  { code: 'GB', name: 'United Kingdom', note: 'via /add-portal' },
  { code: 'CA', name: 'Canada', note: 'via /add-portal' },
  { code: 'DE', name: 'Germany', note: 'via /add-portal' },
  { code: 'ES', name: 'Spain', note: 'via /add-portal' },
  { code: 'MX', name: 'Mexico', note: 'via /add-portal' },
];

function CountryFlag({ code, name, width = 20 }: { code: string; name: string; width?: number }) {
  const iso = code.toLowerCase();
  return (
    <img
      src={`https://flagcdn.com/w40/${iso}.png`}
      srcSet={`https://flagcdn.com/w80/${iso}.png 2x`}
      width={width}
      alt={name}
      loading="lazy"
      className="rounded-[3px] shrink-0 border border-line/60"
      style={{ height: 'auto' }}
    />
  );
}

/* ------------------------------ Key entry modal ------------------------------ */
function KeyModal({ conn, open, onOpenChange }: { conn: Connection; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [key, setKey] = useState('');
  const [appId, setAppId] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdzuna = conn.name === 'adzuna';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-accent" /> Connect {isAdzuna ? 'Adzuna' : 'USAJobs'}
        </DialogTitle>
        <DialogDescription>
          {isAdzuna
            ? 'A free key from developer.adzuna.com unlocks salary-annotated listings with predicted-salary flags. Stored in the Windows Credential Manager, never in files.'
            : 'A free key from developer.usajobs.gov unlocks federal roles with structured pay tables. Stored in the Windows Credential Manager, never in files.'}
        </DialogDescription>
        <form
          className="mt-4 space-y-2.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!key.trim() || busy) return;
            setBusy(true);
            try {
              await api.setConnectionKey(conn.name, key.trim(), isAdzuna ? appId.trim() || undefined : undefined);
              onOpenChange(false);
              setKey('');
              setAppId('');
            } finally {
              setBusy(false);
            }
          }}
        >
          {isAdzuna && <Input placeholder="Application ID" value={appId} onChange={(e) => setAppId(e.target.value)} />}
          <Input placeholder={isAdzuna ? 'Application key' : 'API key'} value={key} onChange={(e) => setKey(e.target.value)} />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!key.trim() || busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save & verify
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- Guided connect extras --------------------------- */
function GmailGuide() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ available: boolean; detail: string } | null>(null);
  return (
    <div className="rounded-lg border border-line bg-raised/50 p-2.5 space-y-2">
      <p className="text-[11px] text-ink-3 leading-relaxed">
        Gmail is <span className="font-medium text-ink-2">session-only by design</span>: the server never holds mail
        credentials. Email tasks park as "waiting for session"; run{' '}
        <code className="font-mono text-[10px] bg-overlay border border-line rounded px-1">/email-bridge</code> in an
        interactive Claude session (with the claude.ai Gmail connector on) to process them.
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setResult(null);
            try {
              const r = await api.probeGmail();
              setResult({ available: r.available, detail: r.detail });
            } catch (e) {
              setResult({ available: false, detail: e instanceof Error ? e.message : String(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          {busy ? 'Probing…' : 'Test connection'}
        </Button>
        {result && (
          <span className={cn('text-[11px] inline-flex items-center gap-1', result.available ? 'text-good-text' : 'text-ink-3')}>
            {result.available ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Info className="h-3.5 w-3.5" />}
            <span className="line-clamp-2">{result.detail}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function ChromeGuide() {
  return (
    <div className="rounded-lg border border-line bg-raised/50 p-2.5">
      <p className="text-[11px] text-ink-3 leading-relaxed mb-1.5">
        Used for automation-hostile sites when you pick the Chrome apply driver. Connect it once:
      </p>
      <ol className="text-[11px] text-ink-3 space-y-1 list-decimal list-inside">
        <li>Install the <span className="text-ink-2 font-medium">Claude in Chrome</span> extension</li>
        <li>Sign in with your claude.ai account</li>
        <li>Grant per-site permissions in the extension popup when a task asks</li>
      </ol>
      <p className="text-[10px] text-ink-3/80 mt-1.5">The server cannot probe your browser — this card stays manual.</p>
    </div>
  );
}

/* ------------------------------ Connection card ------------------------------ */
function ConnCard({ conn, index }: { conn: Connection; index: number }) {
  const [keyOpen, setKeyOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const meta = CONN_LABEL[conn.name];
  const Icon = meta?.icon ?? Plug;
  // Chrome is manual by design — never present it as a failure.
  const status =
    conn.name === 'chrome' && conn.status === 'disabled'
      ? { label: 'Manual — interactive sessions', color: 'var(--series-7)', pulse: false }
      : CONN_STATUS[conn.status];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30, delay: Math.min(index * 0.04, 0.4) }}
      className="rounded-xl border border-line bg-surface p-3.5 flex flex-col gap-2"
    >
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-lg bg-overlay border border-line flex items-center justify-center shrink-0">
          <Icon className="h-4 w-4 text-ink-2" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-ink truncate">{meta?.label ?? sourceLabel(conn.name)}</p>
          <p className="text-[11px] flex items-center gap-1.5" style={{ color: status.color }}>
            <ConnDot status={conn.status} size={7} /> {status.label}
          </p>
        </div>
        <Tip label="Re-check health">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={async () => {
              setChecking(true);
              try {
                await api.checkConnection(conn.name);
              } finally {
                setChecking(false);
              }
            }}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
          </Button>
        </Tip>
      </div>
      {conn.detail && <p className="text-[11px] text-ink-3 leading-relaxed line-clamp-2">{conn.detail}</p>}
      {conn.name === 'gmail' && <GmailGuide />}
      {conn.name === 'chrome' && <ChromeGuide />}
      <div className="flex items-center justify-between mt-auto">
        <span className="text-[10px] text-ink-3">{conn.lastOk ? `last ok ${fmtRelative(conn.lastOk)}` : 'never connected'}</span>
        {conn.status === 'needs_key' && (
          <Button size="sm" onClick={() => setKeyOpen(true)}>
            <KeyRound className="h-3.5 w-3.5" /> Add free key
          </Button>
        )}
      </div>
      {conn.status === 'needs_key' && <KeyModal conn={conn} open={keyOpen} onOpenChange={setKeyOpen} />}
    </motion.div>
  );
}

/* -------------------------------- Job market card -------------------------------- */
function JobMarketCard() {
  const profile = useStore((s) => s.profile);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const country = settings?.country ?? profile?.country ?? 'US';

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Globe2 className="h-4 w-4 text-accent" /> Job market
          </span>
        }
        hint="Which country's portal set discovery targets"
        right={
          <Select
            value={country}
            onValueChange={async (v) => {
              const s = await api.patchSettings({ country: v });
              setSettings(s);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue>
                <span className="inline-flex items-center gap-1.5">
                  {COUNTRIES.some((c) => c.code === country) ? (
                    <CountryFlag code={country} name={COUNTRIES.find((c) => c.code === country)!.name} />
                  ) : (
                    <Globe2 className="h-4 w-4 text-ink-3" />
                  )}
                  <span>{COUNTRIES.find((c) => c.code === country)?.name ?? country}</span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {COUNTRIES.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  <span className="inline-flex items-center gap-2">
                    <CountryFlag code={c.code} name={c.name} /> {c.name}
                    {c.note && <span className="text-[10px] text-ink-3">({c.note})</span>}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="px-4 pb-4">
        <p className="text-[11px] text-ink-3 flex items-start gap-1.5 leading-relaxed">
          <UserRound className="h-3.5 w-3.5 shrink-0 mt-px" />
          Identity, documents, and profile files moved — click your name at the bottom of the sidebar to view and edit
          them.
        </p>
      </div>
    </Card>
  );
}

/* -------------------------------- Credentials vault -------------------------------- */
function VaultCard() {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.getCredentials>> | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ site: '', username: '', password: '', hasCaptcha: false, notes: '' });
  const [busy, setBusy] = useState(false);

  const load = async () => setList(await api.getCredentials());
  useEffect(() => {
    void load();
  }, []);

  const reveal = async (site: string) => {
    if (revealed[site]) {
      setRevealed((r) => {
        const { [site]: _drop, ...rest } = r;
        return rest;
      });
      return;
    }
    const { password } = await api.revealCredential(site);
    setRevealed((r) => ({ ...r, [site]: password }));
    setTimeout(() => setRevealed((r) => {
      const { [site]: _drop, ...rest } = r;
      return rest;
    }), 12000);
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Vault className="h-4 w-4 text-violet" /> Credentials vault
          </span>
        }
        hint="Secrets live in the Windows Credential Manager — the database only stores references"
        right={
          <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        }
      />
      {!list || list.length === 0 ? (
        <EmptyState
          icon={Vault}
          title="Vault is empty"
          hint="When the apply driver auto-registers an ATS account, its generated credentials appear here. You can also add logins manually."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-y border-line bg-overlay/40">
                <th className="px-4 py-2 font-medium">Site</th>
                <th className="px-3 py-2 font-medium">Username</th>
                <th className="px-3 py-2 font-medium">Password</th>
                <th className="px-3 py-2 font-medium">Notes</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {list.map((c) => (
                <tr key={c.site} className="hover:bg-overlay/40">
                  <td className="px-4 py-2 font-medium text-ink whitespace-nowrap">
                    {c.site}
                    {c.hasCaptcha && (
                      <Tip label="This site shows captchas — expect a needs-human pause during applies">
                        <Badge variant="warn" className="ml-1.5"><ShieldAlert className="h-3 w-3" /> captcha</Badge>
                      </Tip>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-2 whitespace-nowrap">{c.username}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                      <span className={revealed[c.site] ? 'text-ink' : 'text-ink-3'}>
                        {revealed[c.site] ?? c.maskedPassword}
                      </span>
                      <button className="text-ink-3 hover:text-ink cursor-pointer" onClick={() => void reveal(c.site)} aria-label="Reveal password">
                        {revealed[c.site] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-3 max-w-52 truncate">{c.notes ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <Tip label="Remove from vault">
                      <button
                        className="text-ink-3 hover:text-critical cursor-pointer p-1"
                        onClick={async () => {
                          await api.deleteCredential(c.site);
                          void load();
                        }}
                        aria-label="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogTitle>Add site credentials</DialogTitle>
          <DialogDescription>Stored in the Windows Credential Manager via the local vault.</DialogDescription>
          <form
            className="mt-4 space-y-2.5"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!form.site || !form.username || !form.password || busy) return;
              setBusy(true);
              try {
                await api.addCredential({
                  site: form.site,
                  username: form.username,
                  password: form.password,
                  hasCaptcha: form.hasCaptcha,
                  notes: form.notes || undefined,
                });
                setAddOpen(false);
                setForm({ site: '', username: '', password: '', hasCaptcha: false, notes: '' });
                void load();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Input placeholder="Site (e.g. myworkday.com) *" value={form.site} onChange={(e) => setForm((f) => ({ ...f, site: e.target.value }))} />
            <Input placeholder="Username / email *" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
            <Input placeholder="Password *" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            <Input placeholder="Notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            <label className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer">
              <Checkbox checked={form.hasCaptcha} onCheckedChange={(v) => setForm((f) => ({ ...f, hasCaptcha: v === true }))} />
              This site uses captchas
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!form.site || !form.username || !form.password || busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Store securely
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* ------------------------------------- View ------------------------------------- */
export default function Connections() {
  const connections = useStore((s) => s.connections);
  const core = connections.filter((c) => CONN_LABEL[c.name]);
  const portals = connections.filter((c) => !CONN_LABEL[c.name]);

  return (
    <div className="space-y-4">
      <PageHeader title="Connections" subtitle="Every integration at a glance — sessions, browsers, portals, and optional free keys" />
      <div className="grid grid-cols-[1.5fr_1fr] gap-4 max-[1420px]:grid-cols-1 items-start">
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-2 px-1">Core services</p>
            <div className="grid grid-cols-3 gap-3 max-[1500px]:grid-cols-2">
              {core.map((c, i) => (
                <ConnCard key={c.name} conn={c} index={i} />
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-2 px-1">Job sources</p>
            <div className="grid grid-cols-3 gap-3 max-[1500px]:grid-cols-2">
              {portals.map((c, i) => (
                <ConnCard key={c.name} conn={c} index={i + core.length} />
              ))}
            </div>
          </div>
          <VaultCard />
        </div>
        <JobMarketCard />
      </div>
    </div>
  );
}
