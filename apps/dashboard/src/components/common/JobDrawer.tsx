import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import {
  PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer,
} from 'recharts';
import { DownloadCloud, ExternalLink, Info, Loader2, MapPin, Rocket, ShieldAlert, ShieldCheck, ShieldX, SkipForward, X } from 'lucide-react';
import type { Job } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/components/common/Markdown';
import { FitRing, FitScoreTip } from '@/components/common/rings';
import { LegitBadge, SourceIcon, StatusPill, sourceLabel } from '@/components/common/chips';
import { REMOTE_LABEL, salaryLabel, fmtDate } from '@/lib/format';

interface DrawerState {
  jobId: number | null;
  open: (id: number) => void;
  close: () => void;
}

export const useJobDrawer = create<DrawerState>((set) => ({
  jobId: null,
  open: (id) => set({ jobId: id }),
  close: () => set({ jobId: null }),
}));

function FitRadar({ job }: { job: Job }) {
  const b = job.fitBreakdown;
  if (!b) return null;
  const data = [
    { axis: 'Technical', v: b.technical },
    { axis: 'Experience', v: b.experience },
    { axis: 'Behavioral', v: b.behavioral },
    { axis: 'Career', v: b.career },
  ];
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-semibold text-ink uppercase tracking-wide">Fit breakdown</h3>
        {b.locationVeto && (
          <Badge variant="critical">Location veto</Badge>
        )}
      </div>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} cx="50%" cy="50%" outerRadius="78%">
            <PolarGrid stroke="var(--grid)" />
            <PolarAngleAxis dataKey="axis" tick={{ fill: 'var(--ink-3)', fontSize: 11 }} />
            <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
            <Radar
              dataKey="v"
              stroke="var(--series-1)"
              strokeWidth={2}
              fill="var(--series-1)"
              fillOpacity={0.18}
              isAnimationActive
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-4 gap-1 text-center">
        {data.map((d) => (
          <div key={d.axis}>
            <div className="text-sm font-semibold text-ink tabular">{d.v}</div>
            <div className="text-[10px] text-ink-3">{d.axis}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Suspicious/scam review panel: the reasons the pipeline flagged this job,
 * plus the human escape hatch — structural heuristics never get the last word.
 */
function LegitReviewPanel({ job, onUpdated }: { job: Job; onUpdated: (j: Job) => void }) {
  const close = useJobDrawer((s) => s.close);
  const pushToast = useStore((s) => s.pushToast);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const scam = job.legitVerdict === 'scam';
  const Icon = scam ? ShieldX : ShieldAlert;

  return (
    <div
      className={`rounded-xl border p-3.5 ${
        scam ? 'border-critical/40 bg-critical/8' : 'border-warn-raw/45 bg-warn-raw/10'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={`h-4.5 w-4.5 shrink-0 mt-0.5 ${scam ? 'text-critical' : 'text-warn'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-ink">
            {scam ? 'Quarantined as a possible scam' : 'Flagged suspicious'} — your call
          </p>
          <ul className="mt-1.5 space-y-1">
            {job.legitReasons.map((r, i) => (
              <li key={i} className="text-xs text-ink-2 leading-relaxed flex gap-1.5">
                <span className={scam ? 'text-critical' : 'text-warn'}>•</span>
                {r}
              </li>
            ))}
            {job.legitReasons.length === 0 && (
              <li className="text-xs text-ink-3">No recorded reasons — treat with care.</li>
            )}
          </ul>
          <div className="mt-2.5 space-y-2">
            <Input
              placeholder="Why is it legit? e.g. verified posting on the company careers site"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy || note.trim().length === 0}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await api.overrideLegit(job.id, note.trim());
                    useStore.getState().upsertJob(res.job);
                    onUpdated(res.job);
                    pushToast(
                      'success',
                      res.taskId != null
                        ? `${job.company} marked legit — rescoring now`
                        : `${job.company} marked legit — back in Screened`,
                    );
                  } catch (err) {
                    pushToast('error', `Override failed: ${err instanceof Error ? err.message : 'unknown error'}`);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                Mark as legit & rescore
              </Button>
              {job.status === 'quarantined' && (
                <Button size="sm" variant="ghost" onClick={close}>
                  Keep quarantined
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function JobDrawer() {
  const jobId = useJobDrawer((s) => s.jobId);
  const close = useJobDrawer((s) => s.close);
  const storeJob = useStore((s) => (jobId != null ? s.jobs.find((j) => j.id === jobId) : undefined));
  const [detail, setDetail] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDetail(null);
    if (jobId == null) return;
    let alive = true;
    void api.getJob(jobId).then((j) => alive && setDetail(j)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [jobId]);

  const job = detail ?? storeJob ?? null;
  const salary = job ? salaryLabel(job) : null;
  const canApply = job && ['discovered', 'screened', 'skipped'].includes(job.status) && job.legitVerdict !== 'scam';
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <AnimatePresence>
      {jobId != null && job && (
        <>
          <motion.div
            key="jd-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
            className="fixed inset-0 z-40 bg-black/45"
          />
          <motion.aside
            key="jd-panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 360, damping: 36 }}
            className="fixed right-0 top-0 bottom-0 z-50 w-[560px] max-w-[92vw] bg-surface border-l border-line shadow-[var(--shadow-pop)] flex flex-col"
          >
            <div className="px-5 pt-4 pb-3 border-b border-line flex items-start gap-3">
              <FitScoreTip>
                <FitRing score={job.fitScore} size={46} />
              </FitScoreTip>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-semibold text-ink truncate">{job.title}</h2>
                </div>
                <p className="text-sm text-ink-2 mt-0.5">{job.company}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <StatusPill status={job.status} />
                  <LegitBadge verdict={job.legitVerdict} reasons={job.legitReasons} />
                  {salary && (
                    <Badge variant="accent">
                      {salary}
                      {job.salaryPredicted && <span className="opacity-70">est.</span>}
                    </Badge>
                  )}
                  <Badge>
                    <MapPin className="h-3 w-3" />
                    {job.remoteType === 'remote' ? 'Remote (US)' : `${REMOTE_LABEL[job.remoteType]}${job.location ? ` · ${job.location}` : ''}`}
                  </Badge>
                </div>
              </div>
              <button onClick={close} className="text-ink-3 hover:text-ink rounded-md p-1 hover:bg-overlay cursor-pointer">
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              <div className="flex items-center gap-3 text-xs text-ink-3">
                <SourceIcon source={job.source} withLabel />
                <span>Posted {fmtDate(job.postedAt)}</span>
                <span>Seen {fmtDate(job.firstSeen)}</span>
                {job.managed === 'manual' && <Badge variant="violet">manual — automation hands off</Badge>}
              </div>

              {(job.legitVerdict === 'suspicious' || job.legitVerdict === 'scam') && (
                <LegitReviewPanel job={job} onUpdated={setDetail} />
              )}

              {job.fitBreakdown && <FitRadar job={job} />}

              {job.legitVerdict === 'legit' && job.legitReasons.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-ink uppercase tracking-wide mb-1.5">
                    Legitimacy — {job.legitVerdict}
                  </h3>
                  <ul className="space-y-1">
                    {job.legitReasons.map((r, i) => (
                      <li key={i} className="text-xs text-ink-2 flex gap-1.5">
                        <span className="text-good">•</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {job.fitBreakdown?.note && (
                <div className="rounded-lg border border-warn-raw/40 bg-warn-raw/8 px-3 py-2.5 flex items-start gap-2">
                  <Info className="h-4 w-4 text-warn shrink-0 mt-0.5" />
                  <p className="text-xs text-ink-2 leading-relaxed">{job.fitBreakdown.note}</p>
                </div>
              )}

              <div>
                <h3 className="text-xs font-semibold text-ink uppercase tracking-wide mb-1.5">Job description</h3>
                {job.descriptionMd ? (
                  <Markdown>{job.descriptionMd}</Markdown>
                ) : (
                  <div className="space-y-2.5">
                    <p className="text-xs text-ink-3">
                      No stored description. {sourceLabel(job.source)} record was metadata-only.
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={fetching}
                      onClick={async () => {
                        setFetching(true);
                        try {
                          const res = await api.fetchJobDetails(job.id);
                          setDetail(res.job);
                          useStore.getState().upsertJob(res.job);
                        } finally {
                          setFetching(false);
                        }
                      }}
                    >
                      {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />}
                      {fetching ? 'Fetching from source…' : 'Fetch full description'}
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-3 border-t border-line flex items-center gap-2 bg-raised/40">
              {canApply && (
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.applyJob(job.id);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Rocket className="h-4 w-4" /> Start apply pipeline
                </Button>
              )}
              {job.status !== 'skipped' && ['discovered', 'screened'].includes(job.status) && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const updated = await api.skipJob(job.id);
                      useStore.getState().upsertJob(updated);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <SkipForward className="h-4 w-4" /> Skip
                </Button>
              )}
              {job.canonicalUrl && (
                <a
                  href={job.canonicalUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ml-auto text-xs text-accent hover:underline inline-flex items-center gap-1"
                >
                  Open posting <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
