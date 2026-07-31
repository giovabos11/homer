import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertOctagon, Bot, CheckCircle2, Chrome, Cpu, Eye, FastForward, Gauge, Globe2, Loader2,
  Minus, MonitorSmartphone, Plus, RotateCcw, ShieldCheck, SlidersHorizontal, Trash2, X, Zap,
} from 'lucide-react';
import type { GateMode, ModelChoice, Settings } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { cn } from '@/lib/utils';
import { Card, CardHeader, PageHeader } from '@/components/common/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox, Slider, Switch } from '@/components/ui/controls';
import { sourceLabel } from '@/components/common/chips';

const GATE_OPTIONS: { value: GateMode; label: string; icon: typeof Eye; desc: string }[] = [
  { value: 'review', label: 'Review', icon: Eye, desc: 'Every application waits in “Ready for review” — one click submits. The safe default.' },
  { value: 'hybrid', label: 'Hybrid', icon: SlidersHorizontal, desc: 'Auto-submit when the fit score clears your threshold; everything else waits for review.' },
  { value: 'auto', label: 'Auto', icon: Zap, desc: 'Submit as soon as checks pass. Full audit trail, no waiting.' },
];

const OVERRIDE_SOURCES = ['linkedin', 'ats_boards', 'remoteok', 'usajobs'];

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

/* --------------------------------- Job market --------------------------------- */
function JobMarketCard() {
  const profile = useStore((s) => s.profile);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const country = settings?.country ?? profile?.country ?? 'US';
  const active = COUNTRIES.find((c) => c.code === country);

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
                  {active ? <CountryFlag code={active.code} name={active.name} /> : <Globe2 className="h-4 w-4 text-ink-3" />}
                  <span>{active?.name ?? country}</span>
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
        <p className="text-[11px] text-ink-3 leading-relaxed">
          Switching markets swaps the portal set discovery runs against and the locations it searches. The United States
          ships with the full portal set; other countries fall back to the upstream portals or whatever you register with{' '}
          <code className="font-mono text-[10px] bg-overlay border border-line rounded px-1">/add-portal</code>.
        </p>
      </div>
    </Card>
  );
}

function GateCard() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [threshold, setThreshold] = useState<number | null>(null);
  if (!settings) return null;

  const patch = async (body: Partial<Settings>) => setSettings(await api.patchSettings(body));
  const t = threshold ?? settings.hybridThreshold;

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-accent" /> Submission gate
          </span>
        }
        hint="Who gets the final click — you, the automation, or a score-based mix"
      />
      <div className="px-4 pb-4 space-y-3">
        <div className="grid grid-cols-3 gap-2 max-[1350px]:grid-cols-1">
          {GATE_OPTIONS.map((g) => {
            const Icon = g.icon;
            const active = settings.gateMode === g.value;
            return (
              <button
                key={g.value}
                onClick={() => void patch({ gateMode: g.value })}
                className={cn(
                  'rounded-xl border p-3 text-left transition-all cursor-pointer',
                  active ? 'border-accent/50 bg-accent/8 shadow-sm' : 'border-line hover:border-line-strong',
                )}
              >
                <p className={cn('text-sm font-semibold inline-flex items-center gap-1.5', active ? 'text-accent' : 'text-ink')}>
                  <Icon className="h-4 w-4" /> {g.label}
                </p>
                <p className="text-[11px] text-ink-3 mt-1 leading-relaxed">{g.desc}</p>
              </button>
            );
          })}
        </div>

        <AnimatePresence>
          {settings.gateMode === 'hybrid' && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="rounded-lg border border-line bg-raised/50 p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-ink-2">Auto-submit when fit score ≥</span>
                  <Badge variant="accent" className="tabular">{t}</Badge>
                </div>
                <Slider
                  min={50}
                  max={95}
                  step={1}
                  value={[t]}
                  onValueChange={([v]) => setThreshold(v ?? t)}
                  onValueCommit={async ([v]) => {
                    if (v != null) await patch({ hybridThreshold: v });
                    setThreshold(null);
                  }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="rounded-lg border border-line bg-raised/50 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-ink">Submit on its own when nothing is unknown</p>
              <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed max-w-xl">
                Applications submit on their own only when every question resolved from your profile and standing
                answers; anything unknown still waits for you. LinkedIn always waits.
              </p>
            </div>
            <Switch
              checked={settings.autoSubmitWhenResolved}
              onCheckedChange={(v) => void patch({ autoSubmitWhenResolved: v })}
              aria-label="Submit automatically when every answer is resolved"
            />
          </div>
          {settings.autoSubmitWhenResolved && (
            <p className="text-[11px] text-ink-3 mt-2 pt-2 border-t border-line/70">
              Fill your standing answers in <span className="text-ink-2">Profile → Application answers</span> so more
              applications can clear this bar.
            </p>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-2">Per-source overrides</p>
          <div className="space-y-1.5">
            {OVERRIDE_SOURCES.map((src) => (
              <div key={src} className="flex items-center gap-2">
                <span className="text-[13px] text-ink-2 flex-1">
                  {sourceLabel(src)}
                  {src === 'linkedin' && (
                    <span className="text-[10px] text-warn ml-1.5">always review-gated + human-paced (ToS)</span>
                  )}
                </span>
                <Select
                  value={settings.perSourceGates[src] ?? 'inherit'}
                  onValueChange={async (v) => {
                    const next = { ...settings.perSourceGates };
                    if (v === 'inherit') delete next[src];
                    else next[src] = v as GateMode;
                    await patch({ perSourceGates: next });
                  }}
                  disabled={src === 'linkedin'}
                >
                  <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">Inherit</SelectItem>
                    <SelectItem value="review">Review</SelectItem>
                    <SelectItem value="hybrid">Hybrid</SelectItem>
                    <SelectItem value="auto">Auto</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

function AutomationCard() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [disc, setDisc] = useState<number | null>(null);
  const [mail, setMail] = useState<number | null>(null);
  if (!settings) return null;
  const patch = async (body: Partial<Settings>) => setSettings(await api.patchSettings(body));

  const discV = disc ?? settings.discoveryIntervalMinutes;
  const mailV = mail ?? settings.emailScanIntervalMinutes;
  const fmtIv = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : 'daily');

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Gauge className="h-4 w-4 text-accent" /> Automation cadence & driver
          </span>
        }
      />
      <div className="px-4 pb-4 space-y-4">
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-xs text-ink-2">Discovery interval</span>
            <span className="text-xs font-medium text-ink tabular">every {fmtIv(discV)}</span>
          </div>
          <Slider
            min={15} max={1440} step={15} value={[discV]}
            onValueChange={([v]) => setDisc(v ?? discV)}
            onValueCommit={async ([v]) => {
              if (v != null) await patch({ discoveryIntervalMinutes: v });
              setDisc(null);
            }}
          />
        </div>
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-xs text-ink-2">Email scan interval (needs an active Claude session)</span>
            <span className="text-xs font-medium text-ink tabular">every {fmtIv(mailV)}</span>
          </div>
          <Slider
            min={30} max={1440} step={30} value={[mailV]}
            onValueChange={([v]) => setMail(v ?? mailV)}
            onValueCommit={async ([v]) => {
              if (v != null) await patch({ emailScanIntervalMinutes: v });
              setMail(null);
            }}
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-ink uppercase tracking-wide">Parallel agents</p>
              <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed max-w-md">
                More parallelism drains the queue faster but consumes your usage window faster.
                Apply and discovery always run alone.
              </p>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-raised/50 p-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Fewer parallel agents"
                disabled={settings.queueConcurrency <= 1}
                onClick={() => void patch({ queueConcurrency: Math.max(1, settings.queueConcurrency - 1) })}
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <span className="w-6 text-center text-sm font-semibold text-ink tabular" aria-live="polite">
                {settings.queueConcurrency}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More parallel agents"
                disabled={settings.queueConcurrency >= 4}
                onClick={() => void patch({ queueConcurrency: Math.min(4, settings.queueConcurrency + 1) })}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-2">Apply driver</p>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { v: 'playwright', label: 'Playwright', icon: MonitorSmartphone, desc: 'Headed Chromium with a persistent logged-in profile. Default.' },
                { v: 'chrome', label: 'Claude in Chrome', icon: Chrome, desc: 'Drives your real Chrome session — for automation-hostile sites.' },
              ] as const
            ).map((d) => {
              const Icon = d.icon;
              const active = settings.applyDriver === d.v;
              return (
                <button
                  key={d.v}
                  onClick={() => void patch({ applyDriver: d.v })}
                  className={cn(
                    'rounded-xl border p-3 text-left transition-all cursor-pointer',
                    active ? 'border-accent/50 bg-accent/8' : 'border-line hover:border-line-strong',
                  )}
                >
                  <p className={cn('text-sm font-semibold inline-flex items-center gap-1.5', active ? 'text-accent' : 'text-ink')}>
                    <Icon className="h-4 w-4" /> {d.label}
                  </p>
                  <p className="text-[11px] text-ink-3 mt-1 leading-relaxed">{d.desc}</p>
                </button>
              );
            })}
          </div>
        </div>
        <div className="rounded-lg border border-line bg-raised/50 px-3 py-2.5 flex items-center gap-2.5 text-xs text-ink-3">
          <Bot className="h-4 w-4 shrink-0" />
          Follow-ups draft after {settings.followupAfterDays} quiet days, max {settings.maxFollowups} per application. Both configurable in config/user.
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------- Auto-advance card ------------------------------- */
const ADVANCE_OPTIONS: { value: Settings['autoAdvance']; label: string; desc: string }[] = [
  { value: 'off', label: 'Off', desc: 'Screened jobs wait until you click Apply — nothing tailors on its own.' },
  { value: 'threshold', label: 'Score threshold', desc: 'Legit jobs at or above your fit threshold flow into tailoring automatically.' },
  { value: 'all', label: 'All screened', desc: 'Every legit, non-vetoed job enters tailoring. Highest throughput, highest usage.' },
];

function AutoAdvanceCard() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [threshold, setThreshold] = useState<number | null>(null);
  if (!settings) return null;
  const patch = async (body: Partial<Settings>) => setSettings(await api.patchSettings(body));
  const t = threshold ?? settings.autoAdvanceThreshold;

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <FastForward className="h-4 w-4 text-accent" /> Pipeline auto-advance
          </span>
        }
        hint="What happens after scoring — the submit gate above still controls actual submission"
      />
      <div className="px-4 pb-4 space-y-3">
        <div className="grid grid-cols-3 gap-2 max-[1350px]:grid-cols-1">
          {ADVANCE_OPTIONS.map((o) => {
            const active = settings.autoAdvance === o.value;
            return (
              <button
                key={o.value}
                onClick={() => void patch({ autoAdvance: o.value })}
                className={cn(
                  'rounded-xl border p-3 text-left transition-all cursor-pointer',
                  active ? 'border-accent/50 bg-accent/8 shadow-sm' : 'border-line hover:border-line-strong',
                )}
              >
                <p className={cn('text-sm font-semibold', active ? 'text-accent' : 'text-ink')}>{o.label}</p>
                <p className="text-[11px] text-ink-3 mt-1 leading-relaxed">{o.desc}</p>
              </button>
            );
          })}
        </div>
        <AnimatePresence>
          {settings.autoAdvance === 'threshold' && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="rounded-lg border border-line bg-raised/50 p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-ink-2">Advance into tailoring when fit score ≥</span>
                  <Badge variant="accent" className="tabular">{t}</Badge>
                </div>
                <Slider
                  min={40}
                  max={95}
                  step={1}
                  value={[t]}
                  onValueChange={([v]) => setThreshold(v ?? t)}
                  onValueCommit={async ([v]) => {
                    if (v != null) await patch({ autoAdvanceThreshold: v });
                    setThreshold(null);
                  }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <p className="text-[11px] text-ink-3">
          Suspicious or location-vetoed jobs never auto-advance; manual records are never touched.
        </p>
      </div>
    </Card>
  );
}

/* ---------------------------------- Models card ---------------------------------- */
const MODEL_OPTIONS: { value: ModelChoice; label: string }[] = [
  { value: 'haiku', label: 'Haiku (fastest + cheapest)' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'default', label: 'Default (your Claude Code model)' },
];

type ModelKey =
  | 'modelScore' | 'modelEmail' | 'modelScraper' | 'modelAsk'
  | 'modelTailor' | 'modelPrep' | 'modelFollowup' | 'modelFeedback' | 'modelSetup';

/** Recommended per-task defaults (mirrors config/default.json). */
const RECOMMENDED: Record<ModelKey, ModelChoice> = {
  modelScore: 'haiku',
  modelEmail: 'haiku',
  modelScraper: 'haiku',
  modelAsk: 'haiku',
  modelTailor: 'sonnet',
  modelPrep: 'sonnet',
  modelFollowup: 'sonnet',
  modelFeedback: 'sonnet',
  modelSetup: 'sonnet',
};

const MODEL_GROUPS: {
  group: string;
  hint: string;
  rows: { key: ModelKey; label: string; desc: string }[];
}[] = [
  {
    group: 'Triage & volume',
    hint: 'Runs on every discovered job or email — cost adds up fastest here',
    rows: [
      { key: 'modelScore', label: 'Score', desc: 'Fit scoring + legitimacy verification per job' },
      { key: 'modelEmail', label: 'Email', desc: 'Inbox scanning and approved-send drafting' },
      { key: 'modelScraper', label: 'Scraper', desc: 'Search-query regeneration from your profile' },
      { key: 'modelAsk', label: 'Ask chat', desc: 'Quick Q&A over your pipeline' },
    ],
  },
  {
    group: 'Quality',
    hint: 'Writing the employer (or you) actually reads — worth a stronger model',
    rows: [
      { key: 'modelTailor', label: 'Tailor', desc: 'Resume + cover letter drafter and reviewer' },
      { key: 'modelPrep', label: 'Prep guides', desc: 'Interview study guides per scheduled event' },
      { key: 'modelFollowup', label: 'Follow-ups', desc: 'Polite nudge emails after quiet applications' },
      { key: 'modelFeedback', label: 'Feedback', desc: 'Retro analysis and plan-change proposals' },
      { key: 'modelSetup', label: 'Profile setup', desc: 'Interview & document-scan onboarding sessions' },
    ],
  },
];

function ModelsCard() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  if (!settings) return null;
  const patch = async (body: Partial<Settings>) => setSettings(await api.patchSettings(body));
  const allRecommended = (Object.keys(RECOMMENDED) as ModelKey[]).every(
    (k) => settings[k] === RECOMMENDED[k],
  );

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="h-4 w-4 text-accent" /> Models
          </span>
        }
        hint="Which Claude model each task runs on — all on your subscription login"
      />
      <div className="px-4 pb-4 space-y-4">
        {MODEL_GROUPS.map((g) => (
          <div key={g.group}>
            <div className="flex items-baseline gap-2 mb-2">
              <p className="text-xs font-semibold text-ink uppercase tracking-wide">{g.group}</p>
              <p className="text-[11px] text-ink-3">{g.hint}</p>
            </div>
            <div className="rounded-xl border border-line divide-y divide-line overflow-hidden">
              {g.rows.map((row) => {
                const recommended = settings[row.key] === RECOMMENDED[row.key];
                return (
                  <div key={row.key} className="flex items-center gap-3 px-3 py-2 bg-raised/40">
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-ink inline-flex items-center gap-1.5">
                        {row.label}
                        {recommended && (
                          <Badge variant="good" className="text-[10px]">Recommended</Badge>
                        )}
                      </p>
                      <p className="text-[11px] text-ink-3">{row.desc}</p>
                    </div>
                    <Select
                      value={settings[row.key]}
                      onValueChange={(v) => void patch({ [row.key]: v as ModelChoice })}
                    >
                      <SelectTrigger className="w-56 h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {MODEL_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex items-start gap-3">
          <div className="flex-1 rounded-lg border border-line bg-raised/50 px-3 py-2.5 text-xs text-ink-3 leading-relaxed">
            Haiku keeps high-volume triage cheap; Sonnet is worth it where writing quality shows.
            Default runs on your own Claude Code model — which may be your most expensive one.
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={allRecommended}
            onClick={() => void patch({ ...RECOMMENDED })}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to recommended
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------- Danger zone --------------------------------- */
type Scope = 'db' | 'artifacts' | 'profile';

function DangerZone() {
  const pushToast = useStore((s) => s.pushToast);
  const loadAll = useStore((s) => s.loadAll);
  const [scopes, setScopes] = useState<Scope[]>(['db', 'artifacts']);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  // Persistent outcome of the last reset attempt — a failed reset must stay
  // visible in the card (a transient toast is not enough for a data-loss action).
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggle = (s: Scope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <Card className="border-critical/35">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5 text-critical">
            <AlertOctagon className="h-4 w-4" /> Danger zone — reset
          </span>
        }
        hint="Mirrors the upstream /reset semantics. Preview first; nothing is deleted until you type RESET."
      />
      <div className="px-4 pb-4 space-y-3">
        <div className="flex flex-wrap gap-4">
          {(
            [
              { v: 'db', label: 'Database & queue', desc: 'jobs, applications, emails, tasks' },
              { v: 'artifacts', label: 'Generated artifacts', desc: 'PDFs, screenshots, archives' },
              { v: 'profile', label: 'Profile', desc: 'merged profile skill files' },
            ] as { v: Scope; label: string; desc: string }[]
          ).map((s) => (
            <label key={s.v} className="flex items-start gap-2 cursor-pointer">
              <Checkbox checked={scopes.includes(s.v)} onCheckedChange={() => toggle(s.v)} className="mt-0.5" />
              <span>
                <span className="text-[13px] text-ink font-medium block">{s.label}</span>
                <span className="text-[11px] text-ink-3">{s.desc}</span>
              </span>
            </label>
          ))}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-critical/40 bg-critical/8 p-3 flex items-start gap-2.5"
          >
            <AlertOctagon className="h-4 w-4 text-critical shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-critical break-words">Reset failed — {error}</p>
              <p className="text-xs text-ink-2 mt-0.5">
                Nothing was deleted. Your jobs, applications, and artifacts are intact — fix the
                issue above and try again.
              </p>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => setError(null)} aria-label="Dismiss error">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {done && (
          <div
            role="status"
            className="rounded-lg border border-good/40 bg-good/8 p-3 flex items-start gap-2.5"
          >
            <CheckCircle2 className="h-4 w-4 text-good shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-good-text">{done}</p>
              <p className="text-xs text-ink-2 mt-0.5">The board and queue reloaded with the fresh state.</p>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => setDone(null)} aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {preview == null ? (
          <Button
            variant="destructive-outline"
            disabled={scopes.length === 0 || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setDone(null);
              try {
                const res = await api.resetPreview(scopes);
                setPreview(res.preview);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Preview what will be deleted
          </Button>
        ) : (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            <div className="rounded-lg border border-critical/30 bg-critical/6 p-3">
              <p className="text-xs font-semibold text-critical mb-1.5">This reset will remove:</p>
              <ul className="space-y-1">
                {preview.map((p, i) => (
                  <li key={i} className="text-xs text-ink-2 flex gap-1.5">
                    <Trash2 className="h-3 w-3 text-critical/70 shrink-0 mt-0.5" /> {p}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder='Type "RESET" to confirm'
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-56 font-mono"
              />
              <Button
                variant="destructive"
                disabled={confirm !== 'RESET' || busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  setDone(null);
                  try {
                    await api.reset(scopes);
                    setPreview(null);
                    setConfirm('');
                    setDone(`Reset complete — wiped: ${scopes.join(', ')}.`);
                    pushToast('warning', 'Reset executed — starting fresh');
                    // Refresh the whole store so the kanban visibly empties
                    // without a manual reload (SSE has no reset event).
                    await loadAll();
                  } catch (err) {
                    // Non-2xx → keep the preview open and surface the server's
                    // detail loudly; the DELETEs run in one transaction, so a
                    // failure means nothing was removed.
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Reset permanently
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPreview(null);
                  setConfirm('');
                }}
              >
                Cancel
              </Button>
            </div>
          </motion.div>
        )}
      </div>
    </Card>
  );
}

export default function SettingsView() {
  return (
    <div className="space-y-4 max-w-4xl">
      <PageHeader title="Settings" subtitle="Market, gates, cadence, models — and the big red button" />
      <JobMarketCard />
      <GateCard />
      <AutoAdvanceCard />
      <AutomationCard />
      <ModelsCard />
      <DangerZone />
    </div>
  );
}
