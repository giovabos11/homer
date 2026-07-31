import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Ban, ChevronDown, ChevronLeft, ChevronRight, Download, Gauge, HandHelping,
  Link2, Loader2, Pause, PenLine, Play, Radar, RotateCcw, Search as SearchIcon, Table2,
  Wand2, XCircle,
} from 'lucide-react';
import type { Job, JobStatus, ParkReason, QueueTask, RemoteType, SourceBudget } from '@shared';
import { PARK_REASON_LABELS } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { downloadCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';
import { humanizeTask } from '@/lib/tasks';
import { fmtRelative, REMOTE_LABEL, salaryLabel, STATUS_LABEL, titleCase } from '@/lib/format';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/common/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox, Progress, Slider, Switch, Tip } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { FitRing } from '@/components/common/rings';
import { LegitBadge, SourceIcon, StatusPill, sourceLabel } from '@/components/common/chips';
import { useJobDrawer } from '@/components/common/JobDrawer';

const SEARCH_SOURCES = ['ats_boards', 'remoteok', 'remotive', 'weworkremotely', 'hn_hiring', 'freehire', 'linkedin'];

/* ------------------------------- Manual search ------------------------------- */
function SearchForm() {
  const [keywords, setKeywords] = useState('');
  const [experience, setExperience] = useState('entry');
  const [remote, setRemote] = useState<RemoteType>('remote');
  const [location, setLocation] = useState('Dallas, TX');
  const [sources, setSources] = useState<string[]>(['ats_boards', 'remoteok', 'freehire']);
  const [busy, setBusy] = useState(false);
  const beginSearch = useStore((s) => s.beginSearch);

  const toggleSource = (s: string) =>
    setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <Card>
      <CardHeader title="Manual search" hint="Fan out to portal skills live — results stream in below" />
      <form
        className="px-4 pb-4 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!keywords.trim() || busy) return;
          setBusy(true);
          try {
            const { searchId } = await api.search({
              keywords: keywords.trim(),
              experience,
              remote,
              ...(remote !== 'remote' ? { location } : {}),
              sources,
            });
            beginSearch(searchId);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input
          placeholder='Keywords — e.g. "react typescript full stack"'
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-2">
          <Select value={experience} onValueChange={setExperience}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="intern">Internship</SelectItem>
              <SelectItem value="entry">Entry / New grad</SelectItem>
              <SelectItem value="mid">Mid-level</SelectItem>
              <SelectItem value="senior">Senior</SelectItem>
            </SelectContent>
          </Select>
          <Select value={remote} onValueChange={(v) => setRemote(v as RemoteType)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="remote">Remote</SelectItem>
              <SelectItem value="hybrid">Hybrid</SelectItem>
              <SelectItem value="onsite">On-site</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <AnimatePresence>
          {remote !== 'remote' && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <Input placeholder="Location (city, state)" value={location} onChange={(e) => setLocation(e.target.value)} />
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex flex-wrap gap-1.5">
          {SEARCH_SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => toggleSource(s)}
              className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                sources.includes(s)
                  ? 'border-accent/40 bg-accent/12 text-accent'
                  : 'border-line text-ink-3 hover:border-line-strong hover:text-ink-2'
              }`}
            >
              {sourceLabel(s)}
            </button>
          ))}
        </div>
        <Button type="submit" disabled={!keywords.trim() || sources.length === 0 || busy} className="w-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SearchIcon className="h-4 w-4" />}
          Search {sources.length} source{sources.length === 1 ? '' : 's'}
        </Button>
      </form>
    </Card>
  );
}

const LIVE_RESULTS_WINDOW = 25;

function LiveResults() {
  const session = useStore((s) => s.searchSession);
  const jobs = useStore((s) => s.jobs);
  const endSearch = useStore((s) => s.endSearch);
  const openDrawer = useJobDrawer((s) => s.open);
  if (!session) return null;
  const results = session.jobIds
    .map((id) => jobs.find((j) => j.id === id))
    .filter((j): j is NonNullable<typeof j> => !!j);
  // Keep the stream light: render only the newest window; the table below has everything.
  const visible = results.slice(-LIVE_RESULTS_WINDOW);
  const hidden = results.length - visible.length;

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            Live results
            <span className="inline-flex h-2 w-2 rounded-full bg-good status-pulse" style={{ ['--pulse-color' as string]: 'var(--good)' }} />
          </span>
        }
        hint={
          hidden > 0
            ? `${results.length} matches streamed — showing the latest ${visible.length} (all are in the table below)`
            : `${results.length} match${results.length === 1 ? '' : 'es'} streamed so far`
        }
        right={
          <Button variant="ghost" size="sm" onClick={endSearch}>
            Clear
          </Button>
        }
      />
      <div className="px-2 pb-2">
        <AnimatePresence mode="popLayout">
          {visible.map((j) => (
            <motion.button
              key={j.id}
              layout
              initial={{ opacity: 0, x: -16, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              onClick={() => openDrawer(j.id)}
              className="w-full flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-overlay/60 text-left cursor-pointer"
            >
              <SourceIcon source={j.source} />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-ink truncate">{j.title}</p>
                <p className="text-xs text-ink-3 truncate">{j.company}</p>
              </div>
              {salaryLabel(j) && <Badge variant="accent" className="tabular">{salaryLabel(j)}</Badge>}
            </motion.button>
          ))}
        </AnimatePresence>
        {results.length === 0 && (
          <p className="text-xs text-ink-3 px-2 py-4 text-center">
            Waiting for the first results to stream in…
          </p>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------ URL + manual add ------------------------------ */
function UrlApply() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  return (
    <Card>
      <CardHeader title="Paste a URL, get an application" hint="Any posting URL — parsed, scored, then tailored under your gate" />
      <form
        className="px-4 pb-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!/^https?:\/\//i.test(url) || busy) return;
          setBusy(true);
          try {
            const res = await api.applyFromUrl(url.trim());
            const n = res.queuePosition ?? 0;
            pushToast(
              'info',
              n > 0
                ? `Queued — starts after ${n} running/queued task${n === 1 ? '' : 's'}`
                : 'Queued — starting now',
            );
            setUrl('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input placeholder="https://boards.greenhouse.io/…" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button type="submit" disabled={!/^https?:\/\//i.test(url) || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Apply
        </Button>
      </form>
    </Card>
  );
}

function ManualAdd() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    company: '', title: '', status: 'applied' as JobStatus, salaryMin: '', salaryMax: '',
    location: '', remoteType: 'remote' as RemoteType, descriptionMd: '', canonicalUrl: '',
  });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card>
      <CardHeader
        title="Track an existing application"
        hint="Manual records are tracked but never touched by the automation"
        right={
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <PenLine className="h-3.5 w-3.5" /> Add record
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Add a job / application record</DialogTitle>
          <DialogDescription>Marked managed: manual — the automation will track it but never act on it.</DialogDescription>
          <form
            className="mt-4 space-y-2.5"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!form.company || !form.title || busy) return;
              setBusy(true);
              try {
                await api.createJob({
                  company: form.company,
                  title: form.title,
                  status: form.status,
                  location: form.location || null,
                  remoteType: form.remoteType,
                  canonicalUrl: form.canonicalUrl,
                  salaryMin: form.salaryMin ? Number(form.salaryMin) : null,
                  salaryMax: form.salaryMax ? Number(form.salaryMax) : null,
                  descriptionMd: form.descriptionMd || null,
                });
                setOpen(false);
                setForm({ company: '', title: '', status: 'applied', salaryMin: '', salaryMax: '', location: '', remoteType: 'remote', descriptionMd: '', canonicalUrl: '' });
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Company *" value={form.company} onChange={(e) => set('company')(e.target.value)} />
              <Input placeholder="Role title *" value={form.title} onChange={(e) => set('title')(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select value={form.status} onValueChange={(v) => set('status')(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['discovered', 'applied', 'interview', 'offer', 'rejected', 'no_response'] as JobStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={form.remoteType} onValueChange={(v) => set('remoteType')(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="remote">Remote</SelectItem>
                  <SelectItem value="hybrid">Hybrid</SelectItem>
                  <SelectItem value="onsite">On-site</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Input placeholder="Location" value={form.location} onChange={(e) => set('location')(e.target.value)} />
              <Input placeholder="Salary min" inputMode="numeric" value={form.salaryMin} onChange={(e) => set('salaryMin')(e.target.value.replace(/\D/g, ''))} />
              <Input placeholder="Salary max" inputMode="numeric" value={form.salaryMax} onChange={(e) => set('salaryMax')(e.target.value.replace(/\D/g, ''))} />
            </div>
            <Input placeholder="Posting URL" value={form.canonicalUrl} onChange={(e) => set('canonicalUrl')(e.target.value)} />
            <Textarea placeholder="Notes / description (markdown ok)" value={form.descriptionMd} onChange={(e) => set('descriptionMd')(e.target.value)} />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!form.company || !form.title || busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save record
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* --------------------------------- Queue panel --------------------------------- */
const GROUP_PAGE = 20;

/** Collapsible task group with load-more past GROUP_PAGE rows. */
function TaskGroup({
  label,
  tone,
  tasks,
  defaultOpen = true,
  right,
  renderRow,
}: {
  label: string;
  tone: string;
  tasks: QueueTask[];
  defaultOpen?: boolean;
  right?: React.ReactNode;
  renderRow: (t: QueueTask) => React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [limit, setLimit] = useState(GROUP_PAGE);
  if (tasks.length === 0) return null;
  const visible = tasks.slice(0, limit);
  return (
    <div>
      <div className="flex items-center gap-2 py-0.5">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2 hover:text-ink transition-colors cursor-pointer"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
          {label}
          <span className="text-ink-3 tabular">({tasks.length})</span>
        </button>
        <span className="ml-auto">{right}</span>
      </div>
      {open && (
        <div className="space-y-1 mt-1">
          {visible.map(renderRow)}
          {tasks.length > limit && (
            <button
              onClick={() => setLimit((l) => l + GROUP_PAGE)}
              className="w-full rounded-md border border-dashed border-line-strong/70 px-2 py-1.5 text-[11px] font-medium text-ink-3 hover:text-ink hover:bg-overlay/60 transition-colors cursor-pointer"
            >
              Show {Math.min(GROUP_PAGE, tasks.length - limit)} more ({tasks.length - limit} hidden)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PlainTaskRow({ t }: { t: QueueTask }) {
  const jobs = useStore((s) => s.jobs);
  const applications = useStore((s) => s.applications);
  return (
    <div className="flex items-center gap-2 text-xs rounded-md px-2 py-1.5 bg-overlay/50 border border-line/60">
      <span
        className={`h-1.5 w-1.5 rounded-full shrink-0 ${t.state === 'running' ? 'status-pulse' : ''}`}
        style={{
          background:
            t.state === 'running' ? 'var(--good)'
              : t.state === 'waiting_session' ? 'var(--series-7)'
                : t.state === 'paused' ? 'var(--warn-raw)' : 'var(--ink-3)',
          ['--pulse-color' as string]: 'var(--good)',
        }}
      />
      <span className="text-ink-2 truncate flex-1">{humanizeTask(t, jobs, applications)}</span>
      {t.attempts > 0 && (
        <Tip label={t.lastError ?? `${t.attempts} attempt${t.attempts === 1 ? '' : 's'} so far`}>
          <span className="text-[10px] text-warn tabular cursor-default">×{t.attempts}</span>
        </Tip>
      )}
      <Badge variant={t.state === 'waiting_session' ? 'violet' : 'default'}>{titleCase(t.state)}</Badge>
      {(t.state === 'pending' || t.state === 'running') && (
        <Tip label={t.state === 'running' ? 'Stop this task (kills its Claude process)' : 'Cancel'}>
          <button className="text-ink-3 hover:text-critical cursor-pointer" onClick={() => void api.cancelTask(t.id)}>
            <XCircle className="h-3.5 w-3.5" />
          </button>
        </Tip>
      )}
    </div>
  );
}

/* --------------------------- Needs-attention card --------------------------- */
interface TaskChoice {
  question: string;
  options: { value: string; label: string }[];
  answer?: string;
}

/**
 * A parked task. When the apply driver could not map an answer onto a field's
 * real options, those options ride along on the task payload — render them as
 * buttons so one click both answers the question and resumes the task.
 */
function NeedsHumanCard({ t, label }: { t: QueueTask; label: string }) {
  const pushToast = useStore((s) => s.pushToast);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const choices = (t.payload?.choices as TaskChoice[] | undefined) ?? [];
  const answered = choices.every((c) => picked[c.question]);
  const rawReason = t.payload?.parkReason;
  const parkReason =
    typeof rawReason === 'string' && rawReason in PARK_REASON_LABELS ? (rawReason as ParkReason) : null;

  const resolve = async () => {
    setBusy(true);
    try {
      await api.resolveHuman(t.id, Object.keys(picked).length > 0 ? picked : undefined);
    } catch (e) {
      pushToast('error', `Could not resume: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      className="rounded-lg border border-warn-raw/45 bg-warn-raw/10 p-3"
    >
      <div className="flex items-start gap-2.5">
        <HandHelping className="h-4.5 w-4.5 text-warn shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-semibold text-ink">Your turn: {label}</p>
            {/* The worker records WHY it stopped. Naming the blocker beats
                leaving the reader to infer it from a paragraph of prompt — a
                dead posting once read as a captcha for exactly that reason. */}
            {parkReason && <Badge variant="warn">{PARK_REASON_LABELS[parkReason]}</Badge>}
          </div>
          <p className="text-xs text-ink-2 mt-0.5 leading-relaxed whitespace-pre-wrap">{t.humanPrompt}</p>

          {choices.length > 0 && (
            <div className="mt-2.5 space-y-2">
              {choices.map((c) => (
                <div key={c.question} className="rounded-md border border-line bg-surface/70 px-2.5 py-2">
                  <p className="text-[11px] text-ink-2">{c.question}</p>
                  {c.answer && (
                    <p className="text-[10px] text-ink-3 mt-0.5">Your answer, unmatched: “{c.answer}”</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {c.options.map((o) => {
                      const active = picked[c.question] === o.value;
                      return (
                        <button
                          key={o.value + o.label}
                          onClick={() => setPicked((p) => ({ ...p, [c.question]: o.value }))}
                          className={cn(
                            'rounded-md border px-2 py-1 text-[11px] transition-colors cursor-pointer',
                            active
                              ? 'border-accent/60 bg-accent/15 text-accent font-medium'
                              : 'border-line text-ink-2 hover:border-line-strong hover:text-ink',
                          )}
                        >
                          {o.label || o.value}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy || (choices.length > 0 && !answered)} onClick={() => void resolve()}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {choices.length > 0 ? 'Use these answers — resume' : 'I did it — resume'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void api.cancelTask(t.id)}>
              Cancel task
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/* --------------------------- Discovery source toggles --------------------------- */
function SourceRow({ b }: { b: SourceBudget }) {
  const pushToast = useStore((s) => s.pushToast);
  const refreshQueue = useStore((s) => s.refreshQueue);
  const [busy, setBusy] = useState(false);
  const cap = Math.max(1, b.refillPerHour * 8, b.remainingTokens);
  const blocked = !!b.blockedReason;
  const off = !b.enabled;

  return (
    <div className={cn('flex items-center gap-2.5', (off || blocked) && 'opacity-55')}>
      <span
        className="h-2 w-2 rounded-full shrink-0"
        style={{
          background: off || blocked
            ? 'var(--line-strong)'
            : b.health === 'ok' ? 'var(--good)' : b.health === 'degraded' ? 'var(--warn-raw)' : 'var(--critical)',
        }}
      />
      <span className="text-xs text-ink-2 w-32 truncate shrink-0">{sourceLabel(b.source)}</span>
      {blocked ? (
        <span className="flex-1 text-[11px] text-ink-3">
          {b.blockedReason}
          {b.keyGated && (
            <Link to="/connections" className="text-accent hover:underline ml-1">
              Add a key
            </Link>
          )}
        </span>
      ) : off ? (
        <span className="flex-1 text-[11px] text-ink-3">excluded from scheduled discovery</span>
      ) : (
        <Progress
          value={b.remainingTokens / cap}
          className="flex-1"
          barClassName={b.health === 'down' ? 'bg-critical' : b.health === 'degraded' ? 'bg-warn-raw' : undefined}
        />
      )}
      <span className="text-[11px] text-ink-3 tabular w-24 text-right shrink-0">
        {blocked || off ? '' : b.health === 'down' ? 'backing off' : b.nextRun ? `next ${fmtRelative(b.nextRun)}` : 'ready'}
      </span>
      <Switch
        checked={b.enabled && !blocked}
        disabled={busy || blocked}
        aria-label={`${b.enabled ? 'Disable' : 'Enable'} ${sourceLabel(b.source)} for scheduled discovery`}
        onCheckedChange={async (v) => {
          setBusy(true);
          try {
            await api.setSourceEnabled(b.source, v);
            await refreshQueue();
          } catch (e) {
            pushToast('error', `Could not update ${b.source}: ${e instanceof Error ? e.message : e}`);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function QueuePanel() {
  const tasks = useStore((s) => s.tasks);
  const budgets = useStore((s) => s.budgets);
  const paused = useStore((s) => s.queuePaused);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const pushToast = useStore((s) => s.pushToast);
  const jobs = useStore((s) => s.jobs);
  const applications = useStore((s) => s.applications);
  const [rate, setRate] = useState<number | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const interval = rate ?? settings?.discoveryIntervalMinutes ?? 360;

  const runningDiscover = tasks.find((t) => t.state === 'running' && t.type === 'discover');
  // The button's "Discovering…" state mirrors the actual discover task: a
  // queued-but-paused task must not wedge it (pause blocks all claiming).
  const discoverActive =
    tasks.some((t) => t.type === 'discover' && t.state === 'running') ||
    (!paused && tasks.some((t) => t.type === 'discover' && t.state === 'pending'));

  const running = tasks.filter((t) => t.state === 'running');
  const needsHuman = tasks.filter((t) => t.state === 'needs_human');
  const pendingTasks = tasks.filter((t) => ['pending', 'paused', 'waiting_session'].includes(t.state));
  const failed = tasks.filter((t) => t.state === 'failed' && t.lastError !== 'Cancelled by user');
  const cancelled = tasks.filter((t) => t.state === 'failed' && t.lastError === 'Cancelled by user');

  const rateLabel = interval < 60 ? `${interval} min` : interval < 1440 ? `${Math.round(interval / 60)} h` : 'daily';
  const activeCount = budgets.filter((b) => b.enabled && !b.blockedReason).length;

  return (
    <Card>
      <CardHeader
        title="Discovery queue"
        hint={
          paused
            ? 'Paused — cursors saved, nothing will run'
            : runningDiscover
              ? `Working ${sourceLabel(String((runningDiscover.cursor as { source?: string } | null)?.source ?? '…'))} · page ${(runningDiscover.cursor as { page?: number } | null)?.page ?? '–'}`
              : 'Idle — next run on schedule'
        }
        right={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              disabled={runBusy || discoverActive || paused}
              onClick={async () => {
                setRunBusy(true);
                try {
                  await api.runDiscovery();
                } finally {
                  setRunBusy(false);
                }
              }}
            >
              {runBusy || discoverActive ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
              {discoverActive ? 'Discovering…' : 'Run discovery now'}
            </Button>
            {paused ? (
              <Button size="sm" variant="good" onClick={() => void api.resumeQueue()}>
                <Play className="h-3.5 w-3.5" /> Resume
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void api.pauseQueue()}>
                <Pause className="h-3.5 w-3.5" /> Pause
              </Button>
            )}
          </div>
        }
      />
      <div className="px-4 pb-4 space-y-4">
        {/* grouped task list — scrollable, load-more per group */}
        {(running.length > 0 || needsHuman.length > 0 || pendingTasks.length > 0 || failed.length > 0 || cancelled.length > 0) && (
          <div className="max-h-[400px] overflow-y-auto space-y-3 pr-1">
            <TaskGroup
              label="Running"
              tone="var(--good)"
              tasks={running}
              renderRow={(t) => <PlainTaskRow key={t.id} t={t} />}
            />
            <TaskGroup
              label="Needs attention"
              tone="var(--warn-raw)"
              tasks={needsHuman}
              renderRow={(t) => <NeedsHumanCard key={t.id} t={t} label={humanizeTask(t, jobs, applications)} />}
            />
            <TaskGroup
              label="Pending"
              tone="var(--ink-3)"
              tasks={pendingTasks}
              renderRow={(t) => <PlainTaskRow key={t.id} t={t} />}
            />
            <TaskGroup
              label="Failed"
              tone="var(--critical)"
              tasks={failed}
              defaultOpen={failed.length <= 5}
              right={
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={retryBusy}
                  onClick={async () => {
                    setRetryBusy(true);
                    try {
                      const { requeued } = await api.retryFailed();
                      pushToast('success', `${requeued} failed task${requeued === 1 ? '' : 's'} requeued`);
                    } catch (err) {
                      pushToast('error', `Retry failed: ${err instanceof Error ? err.message : 'unknown error'}`);
                    } finally {
                      setRetryBusy(false);
                    }
                  }}
                >
                  {retryBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  Retry all failed
                </Button>
              }
              renderRow={(t) => (
                <div key={t.id} className="rounded-lg border border-critical/35 bg-critical/8 p-3 flex items-start gap-2.5">
                  <AlertTriangle className="h-4 w-4 text-critical shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-ink">
                      {humanizeTask(t, jobs, applications)} — failed ({t.attempts} attempts)
                    </p>
                    <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed break-words">{t.lastError}</p>
                  </div>
                  <Tip label="Retry now">
                    <Button size="icon-sm" variant="ghost" onClick={() => void api.retryTask(t.id)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </Tip>
                </div>
              )}
            />
            <TaskGroup
              label="Cancelled"
              tone="var(--ink-3)"
              tasks={cancelled}
              defaultOpen={false}
              renderRow={(t) => (
                <div key={t.id} className="rounded-lg border border-line bg-overlay/40 p-3 flex items-center gap-2.5">
                  <Ban className="h-4 w-4 text-ink-3 shrink-0" />
                  <p className="text-xs text-ink-2 flex-1 min-w-0 truncate">
                    {humanizeTask(t, jobs, applications)} — stopped by you
                  </p>
                  <Tip label="Run it again">
                    <Button size="icon-sm" variant="ghost" onClick={() => void api.retryTask(t.id)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </Tip>
                </div>
              )}
            />
          </div>
        )}

        {/* rate slider */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-ink-2 inline-flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 text-ink-3" /> Discovery rate
            </span>
            <span className="text-xs font-medium text-ink tabular">every {rateLabel}</span>
          </div>
          <Slider
            min={15}
            max={1440}
            step={15}
            value={[interval]}
            onValueChange={([v]) => setRate(v ?? interval)}
            onValueCommit={async ([v]) => {
              if (v == null) return;
              const s = await api.setQueueRate(v);
              setSettings(s);
              setRate(null);
            }}
          />
        </div>

        {/* budgets */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-ink uppercase tracking-wide">Source budgets & health</p>
            <Button
              size="sm"
              variant="secondary"
              disabled={regenBusy}
              onClick={async () => {
                setRegenBusy(true);
                try {
                  await api.regenerateQueries();
                  pushToast('info', 'Rewriting search queries from your profile — a toast confirms when done');
                } finally {
                  setRegenBusy(false);
                }
              }}
            >
              {regenBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              Regenerate search queries
            </Button>
          </div>
          <p className="text-[11px] text-ink-3 mb-2 -mt-1">
            Queries drive what the scraper looks for — regenerate after profile changes. Toggles choose which sources
            the scheduled sweep uses; manual searches above always use what you pick there.
          </p>
          <p className="text-[11px] text-ink-2 mb-2 tabular">
            {activeCount} of {budgets.length} sources active
          </p>
          <div className="space-y-2">
            {budgets.map((b) => (
              <SourceRow key={b.source} b={b} />
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------ Applications table ------------------------------ */
const PAGE_SIZES = [25, 50, 100] as const;

function ApplicationsTable() {
  const storeJobs = useStore((s) => s.jobs);
  const applications = useStore((s) => s.applications);
  const openDrawer = useJobDrawer((s) => s.open);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('all');
  const [remote, setRemote] = useState('all');
  const [minScore, setMinScore] = useState('0');
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState(0); // zero-based
  const [rows, setRows] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Debounce free-text search before hitting the server.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [debouncedQ, status, source, remote, minScore, pageSize]);

  const query = useMemo(
    () => ({
      q: debouncedQ || undefined,
      status: status !== 'all' ? (status as JobStatus) : undefined,
      source: source !== 'all' ? source : undefined,
      remote: remote !== 'all' ? (remote as RemoteType) : undefined,
      minScore: minScore !== '0' ? Number(minScore) : undefined,
      sort: 'date' as const,
      order: 'desc' as const,
    }),
    [debouncedQ, status, source, remote, minScore],
  );

  // Server-side pagination — refetch on filters/page (and after board updates).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getJobs({ ...query, limit: pageSize, offset: page * pageSize })
      .then((res) => {
        if (cancelled) return;
        setRows(res.jobs);
        setTotal(res.total);
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query, page, pageSize]);

  const appByJob = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of applications) if (a.submittedAt) m.set(a.jobId, a.submittedAt);
    return m;
  }, [applications]);

  const sources = useMemo(() => [...new Set(storeJobs.map((j) => j.source))].sort(), [storeJobs]);

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, page * pageSize + rows.length);
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  const exportCsv = async () => {
    // Export the full filtered set (server cap 500), not just this page.
    const res = await api.getJobs({ ...query, limit: 500, offset: 0 });
    downloadCsv(
      `applications-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Company', 'Title', 'Status', 'Source', 'Remote', 'Location', 'Fit score', 'Legit', 'Salary min', 'Salary max', 'First seen', 'Applied at', 'URL'],
      res.jobs.map((j) => [
        j.company, j.title, STATUS_LABEL[j.status], j.source, j.remoteType, j.location,
        j.fitScore, j.legitVerdict, j.salaryMin, j.salaryMax,
        j.firstSeen.slice(0, 10), appByJob.get(j.id)?.slice(0, 10) ?? '', j.canonicalUrl,
      ]),
    );
  };

  return (
    <Card>
      <CardHeader
        title="All applications & tracked jobs"
        hint={total === 0 ? 'No records' : `${from}–${to} of ${total} records`}
        right={
          <div className="flex items-center gap-1.5">
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-3" />}
            <Button variant="secondary" size="sm" onClick={() => void exportCsv()}>
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
          </div>
        }
      />
      <div className="px-4 pb-3 flex flex-wrap gap-2">
        <Input placeholder="Search company, title, location…" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {sources.map((s) => (
              <SelectItem key={s} value={s}>{sourceLabel(s)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={remote} onValueChange={setRemote}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any type</SelectItem>
            <SelectItem value="remote">Remote</SelectItem>
            <SelectItem value="hybrid">Hybrid</SelectItem>
            <SelectItem value="onsite">On-site</SelectItem>
          </SelectContent>
        </Select>
        <Select value={minScore} onValueChange={setMinScore}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="0">Any score</SelectItem>
            <SelectItem value="60">Fit ≥ 60</SelectItem>
            <SelectItem value="75">Fit ≥ 75</SelectItem>
            <SelectItem value="85">Fit ≥ 85</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={Table2}
          title="No records match these filters"
          hint="Loosen a filter, or run a search above to bring in fresh openings."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-y border-line bg-overlay/40">
                <th className="px-4 py-2 font-medium">Company / Role</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium text-right">Fit</th>
                <th className="px-3 py-2 font-medium text-right">Salary</th>
                <th className="px-3 py-2 font-medium text-right">Seen</th>
                <th className="px-3 py-2 font-medium text-right">Applied</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {rows.map((j) => (
                <tr key={j.id} onClick={() => openDrawer(j.id)} className="hover:bg-overlay/50 cursor-pointer transition-colors">
                  <td className="px-4 py-2">
                    <p className="font-medium text-ink truncate max-w-72">{j.title}</p>
                    <p className="text-xs text-ink-3 flex items-center gap-1.5">
                      {j.company}
                      <LegitBadge verdict={j.legitVerdict} reasons={j.legitReasons} compact />
                    </p>
                  </td>
                  <td className="px-3 py-2"><StatusPill status={j.status} /></td>
                  <td className="px-3 py-2"><SourceIcon source={j.source} withLabel /></td>
                  <td className="px-3 py-2 text-xs text-ink-2">{REMOTE_LABEL[j.remoteType]}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex justify-end"><FitRing score={j.fitScore} size={28} /></span>
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-ink-2 tabular whitespace-nowrap">{salaryLabel(j) ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-xs text-ink-3 whitespace-nowrap">{fmtRelative(j.firstSeen)}</td>
                  <td className="px-3 py-2 text-right text-xs text-ink-3 whitespace-nowrap">{appByJob.has(j.id) ? fmtRelative(appByJob.get(j.id)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-line">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-ink-3">Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="w-20 h-7.5 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-2 tabular">{from}–{to} of {total}</span>
            <Button
              variant="secondary"
              size="icon-sm"
              disabled={page === 0 || loading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="secondary"
              size="icon-sm"
              disabled={page >= lastPage || loading}
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------- View ----------------------------------- */
export default function SearchView() {
  return (
    <div className="space-y-4">
      <PageHeader title="Search" subtitle="Manual searches, one-click URL applies, and full control of the discovery queue" />
      <div className="grid grid-cols-[1.1fr_1.3fr] gap-4 max-[1420px]:grid-cols-1">
        <div className="space-y-4">
          <SearchForm />
          <LiveResults />
          <UrlApply />
          <ManualAdd />
        </div>
        <QueuePanel />
      </div>
      <ApplicationsTable />
    </div>
  );
}
