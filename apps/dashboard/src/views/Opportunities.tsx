import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ChevronDown, Gem, Info, RefreshCw } from 'lucide-react';
import type { Job } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { cn } from '@/lib/utils';
import { fmtMoney, salaryLabel } from '@/lib/format';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/common/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/controls';
import { FitRing } from '@/components/common/rings';
import { LegitBadge, SourceIcon, StatusPill } from '@/components/common/chips';
import { useJobDrawer } from '@/components/common/JobDrawer';

type RankMode = 'opportunity' | 'salary';

const EV_EXPLAINER =
  'Salary weighted by your realistic chance — fit^1.5 — so reachable jobs beat trophy listings. Predicted salaries count 15% less.';

interface ChartRow {
  id: number;
  name: string;
  range: [number, number];
  ev: number | null;
  fit: number | null;
  predicted: boolean;
}

function chartRow(j: Job): ChartRow {
  return {
    id: j.id,
    name: j.company,
    range: [j.salaryMin ?? (j.salaryMax ?? 0) * 0.85, j.salaryMax ?? j.salaryMin ?? 0],
    ev: j.opportunityScore ?? null,
    fit: j.fitScore,
    predicted: j.salaryPredicted,
  };
}

function OppTooltip({ active, payload, mode }: { active?: boolean; payload?: { payload: ChartRow }[]; mode: RankMode }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-2 shadow-[var(--shadow-pop)] text-xs">
      <p className="font-semibold text-ink">{row.name}</p>
      {mode === 'opportunity' && row.ev != null && (
        <p className="text-ink-2 mt-0.5 tabular">Opportunity value {fmtMoney(row.ev)}</p>
      )}
      <p className="text-ink-2 mt-0.5 tabular">
        {fmtMoney(row.range[0])} – {fmtMoney(row.range[1])}
        {row.predicted && <span className="text-ink-3"> (est.)</span>}
      </p>
      {row.fit != null && <p className="text-ink-3 mt-0.5">Fit score {row.fit}</p>}
    </div>
  );
}

/** Thin proportional bar under each row — the at-a-glance EV channel. */
function EvBar({ value, max }: { value: number | null; max: number }) {
  if (value == null || max <= 0) return null;
  return (
    <div className="h-1 w-24 rounded-full bg-overlay overflow-hidden" aria-hidden>
      <div
        className="h-full rounded-full bg-accent/70"
        style={{ width: `${Math.max(4, Math.round((value / max) * 100))}%` }}
      />
    </div>
  );
}

function RankedRow({
  job, index, mode, maxEv, onOpen,
}: {
  job: Job;
  index: number | null;
  mode: RankMode;
  maxEv: number;
  onOpen: (id: number) => void;
}) {
  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 32, delay: Math.min((index ?? 0) * 0.035, 0.4) }}
      onClick={() => onOpen(job.id)}
      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-overlay/60 transition-colors text-left cursor-pointer"
    >
      <span className="w-6 text-center text-sm font-semibold text-ink-3 tabular shrink-0">
        {index != null ? index + 1 : '·'}
      </span>
      <FitRing score={job.fitScore} size={34} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink truncate">
          {job.title} <span className="text-ink-3 font-normal">· {job.company}</span>
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <SourceIcon source={job.source} />
          <StatusPill status={job.status} />
          <LegitBadge verdict={job.legitVerdict} reasons={job.legitReasons} compact />
        </div>
      </div>
      <div className="text-right shrink-0 flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          {job.salaryPredicted && (
            <Tip label="Predicted from market data, not posted by the employer">
              <Badge variant="warn">est.</Badge>
            </Tip>
          )}
          <Badge variant="accent" className="tabular">{salaryLabel(job) ?? '—'}</Badge>
        </div>
        {mode === 'opportunity' && job.opportunityScore != null && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-ink-3 tabular">{fmtMoney(job.opportunityScore)} EV</span>
            <EvBar value={job.opportunityScore} max={maxEv} />
          </div>
        )}
      </div>
    </motion.button>
  );
}

export default function Opportunities() {
  const [mode, setMode] = useState<RankMode>('opportunity');
  const [top, setTop] = useState<Job[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showUnscored, setShowUnscored] = useState(false);
  const openDrawer = useJobDrawer((s) => s.open);
  const jobCount = useStore((s) => s.jobs.length);

  const load = useCallback(async (by: RankMode) => {
    setLoading(true);
    try {
      setTop(await api.getTopJobs(by, 20));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(mode);
  }, [mode, load]);

  const all = top ?? [];
  const scored = all.filter((j) => j.fitScore != null);
  const unscored = all.filter((j) => j.fitScore == null);
  // In EV mode unscored jobs collapse into their own section; raw-salary mode
  // ranks everything in one list (salary needs no fit score).
  const ranked = mode === 'opportunity' ? scored : all;
  const maxEv = Math.max(0, ...scored.map((j) => j.opportunityScore ?? 0));

  const chartRows: ChartRow[] = (mode === 'opportunity' ? scored : all)
    .filter((j) => j.salaryMax != null || j.salaryMin != null)
    .slice(0, 10)
    .map(chartRow);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Opportunities"
        subtitle={
          mode === 'opportunity'
            ? 'Ranked by expected value — salary × your realistic chance'
            : 'Ranked by raw posted salary — click any row for the full posting'
        }
      >
        <div className="flex rounded-lg border border-line overflow-hidden" role="tablist" aria-label="Ranking mode">
          {(
            [
              { v: 'opportunity', label: 'Best opportunities' },
              { v: 'salary', label: 'Raw salary' },
            ] as { v: RankMode; label: string }[]
          ).map((t) => (
            <button
              key={t.v}
              role="tab"
              aria-selected={mode === t.v}
              onClick={() => setMode(t.v)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer',
                mode === t.v ? 'bg-accent/10 text-accent' : 'text-ink-3 hover:text-ink hover:bg-overlay/60',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" onClick={() => void load(mode)} aria-label="Refresh">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </PageHeader>

      {top && top.length === 0 ? (
        <Card>
          <EmptyState
            icon={Gem}
            title="No salary-annotated opportunities yet"
            hint={
              jobCount === 0
                ? 'Once discovery runs, openings with posted or predicted pay show up here, ranked so the best-paying fits float to the top.'
                : 'None of the tracked jobs have salary data yet. Adding a free Adzuna or USAJobs key in Connections unlocks salary-annotated coverage.'
            }
          />
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-1.5">
                  {mode === 'opportunity' ? 'Opportunity value — top 10' : 'Salary ranges — top 10'}
                  {mode === 'opportunity' && (
                    <Tip label={EV_EXPLAINER}>
                      <Info className="h-3.5 w-3.5 text-ink-3" aria-label="How opportunity value is computed" />
                    </Tip>
                  )}
                </span>
              }
              hint={mode === 'opportunity' ? 'salaryMid × (fit/100)^1.5 · predicted pay ×0.85' : 'Bars span posted min → max'}
            />
            <div className="px-4 pb-4" style={{ height: Math.max(220, chartRows.length * 34 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartRows}
                  layout="vertical"
                  margin={{ left: 8, right: 56, top: 4, bottom: 0 }}
                  barCategoryGap={6}
                >
                  <CartesianGrid horizontal={false} stroke="var(--grid)" strokeWidth={1} />
                  <XAxis
                    type="number"
                    domain={mode === 'opportunity' ? [0, 'dataMax + 10000'] : [100000, 'dataMax + 10000']}
                    tickFormatter={(v: number) => fmtMoney(v)}
                    tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
                    axisLine={{ stroke: 'var(--line-strong)' }}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={130}
                    tick={{ fill: 'var(--ink-2)', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    content={<OppTooltip mode={mode} />}
                    cursor={{ fill: 'color-mix(in oklab, var(--ink) 5%, transparent)' }}
                  />
                  <Bar
                    dataKey={mode === 'opportunity' ? 'ev' : 'range'}
                    radius={mode === 'opportunity' ? [0, 4, 4, 0] : [4, 4, 4, 4]}
                    barSize={14}
                    isAnimationActive
                    onClick={(data) => {
                      const row = data as unknown as ChartRow;
                      if (row?.id) openDrawer(row.id);
                    }}
                    className="cursor-pointer"
                  >
                    {chartRows.map((r) => (
                      <Cell key={r.id} fill="var(--series-1)" fillOpacity={r.predicted ? 0.55 : 0.9} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="px-4 pb-3 -mt-1 text-[11px] text-ink-3">
              {mode === 'opportunity'
                ? 'Solid bars use posted pay; lighter bars use predicted pay (already discounted ×0.85).'
                : 'Solid bars are posted ranges; lighter bars are predicted salaries. Bars span min → max.'}
            </p>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-1.5">
                  Ranked list
                  {mode === 'opportunity' && (
                    <Tip label={EV_EXPLAINER}>
                      <Info className="h-3.5 w-3.5 text-ink-3" aria-label="How opportunity value is computed" />
                    </Tip>
                  )}
                </span>
              }
              hint={
                mode === 'opportunity'
                  ? 'Scored, salary-annotated openings by expected value'
                  : 'Every salary-annotated opening in the pipeline'
              }
            />
            <div className="divide-y divide-line">
              {ranked.map((j, i) => (
                <RankedRow key={j.id} job={j} index={i} mode={mode} maxEv={maxEv} onOpen={openDrawer} />
              ))}
              {ranked.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-ink-3">
                  Nothing scored yet — jobs appear here as soon as the score queue catches up.
                </p>
              )}
            </div>

            {mode === 'opportunity' && unscored.length > 0 && (
              <div className="border-t border-line">
                <button
                  onClick={() => setShowUnscored((v) => !v)}
                  aria-expanded={showUnscored}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-ink-3 hover:text-ink hover:bg-overlay/40 transition-colors cursor-pointer"
                >
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showUnscored && 'rotate-180')} />
                  Not scored yet ({unscored.length}) — ranked by salary until scoring catches up
                </button>
                <AnimatePresence initial={false}>
                  {showUnscored && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden divide-y divide-line"
                    >
                      {unscored.map((j) => (
                        <RankedRow key={j.id} job={j} index={null} mode={mode} maxEv={maxEv} onOpen={openDrawer} />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
