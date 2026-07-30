import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Gem, RefreshCw } from 'lucide-react';
import type { Job } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { fmtMoney, salaryLabel } from '@/lib/format';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/common/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch, Tip } from '@/components/ui/controls';
import { FitRing } from '@/components/common/rings';
import { LegitBadge, SourceIcon, StatusPill } from '@/components/common/chips';
import { useJobDrawer } from '@/components/common/JobDrawer';

interface ChartRow {
  id: number;
  name: string;
  range: [number, number];
  max: number;
  fit: number | null;
  predicted: boolean;
}

function SalaryTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartRow }[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-2 shadow-[var(--shadow-pop)] text-xs">
      <p className="font-semibold text-ink">{row.name}</p>
      <p className="text-ink-2 mt-0.5 tabular">
        {fmtMoney(row.range[0])} – {fmtMoney(row.range[1])}
        {row.predicted && <span className="text-ink-3"> (est.)</span>}
      </p>
      {row.fit != null && <p className="text-ink-3 mt-0.5">Fit score {row.fit}</p>}
    </div>
  );
}

export default function Opportunities() {
  const [fitWeighted, setFitWeighted] = useState(true);
  const [top, setTop] = useState<Job[] | null>(null);
  const [loading, setLoading] = useState(false);
  const openDrawer = useJobDrawer((s) => s.open);
  const jobCount = useStore((s) => s.jobs.length);

  const load = useCallback(async (weighted: boolean) => {
    setLoading(true);
    try {
      setTop(await api.getTopJobs(weighted, 12));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(fitWeighted);
  }, [fitWeighted, load]);

  const rows: ChartRow[] = (top ?? [])
    .filter((j) => j.salaryMax != null)
    .slice(0, 10)
    .map((j) => ({
      id: j.id,
      name: j.company,
      range: [j.salaryMin ?? j.salaryMax! * 0.85, j.salaryMax!],
      max: j.salaryMax!,
      fit: j.fitScore,
      predicted: j.salaryPredicted,
    }));

  return (
    <div className="space-y-4">
      <PageHeader title="Opportunities" subtitle="Top openings ranked by salary — click any row for the full posting">
        <label className="flex items-center gap-2 text-xs text-ink-2 cursor-pointer select-none">
          <Switch checked={fitWeighted} onCheckedChange={setFitWeighted} />
          Fit-weighted ranking
        </label>
        <Button variant="ghost" size="icon" onClick={() => void load(fitWeighted)} aria-label="Refresh">
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
              title="Salary ranges — top 10"
              hint={fitWeighted ? 'Ordered by posted maximum × fit score' : 'Ordered by posted maximum'}
            />
            <div className="px-4 pb-4" style={{ height: Math.max(220, rows.length * 34 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 56, top: 4, bottom: 0 }} barCategoryGap={6}>
                  <CartesianGrid horizontal={false} stroke="var(--grid)" strokeWidth={1} />
                  <XAxis
                    type="number"
                    domain={[100000, 'dataMax + 10000']}
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
                  <Tooltip content={<SalaryTooltip />} cursor={{ fill: 'color-mix(in oklab, var(--ink) 5%, transparent)' }} />
                  <Bar
                    dataKey="range"
                    radius={[4, 4, 4, 4]}
                    barSize={14}
                    isAnimationActive
                    onClick={(data) => {
                      const row = data as unknown as ChartRow;
                      if (row?.id) openDrawer(row.id);
                    }}
                    className="cursor-pointer"
                  >
                    {rows.map((r) => (
                      <Cell key={r.id} fill="var(--series-1)" fillOpacity={r.predicted ? 0.55 : 0.9} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="px-4 pb-3 -mt-1 text-[11px] text-ink-3">
              Solid bars are posted ranges; lighter bars are predicted salaries. Bars span min → max.
            </p>
          </Card>

          <Card>
            <CardHeader title="Ranked list" hint="Every salary-annotated opening in the pipeline" />
            <div className="divide-y divide-line">
              {(top ?? []).map((j, i) => (
                <motion.button
                  key={j.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 32, delay: Math.min(i * 0.035, 0.4) }}
                  onClick={() => openDrawer(j.id)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-overlay/60 transition-colors text-left cursor-pointer"
                >
                  <span className="w-6 text-center text-sm font-semibold text-ink-3 tabular shrink-0">{i + 1}</span>
                  <FitRing score={j.fitScore} size={34} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink truncate">
                      {j.title} <span className="text-ink-3 font-normal">· {j.company}</span>
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <SourceIcon source={j.source} />
                      <StatusPill status={j.status} />
                      <LegitBadge verdict={j.legitVerdict} reasons={j.legitReasons} compact />
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-ink tabular">{salaryLabel(j)}</p>
                    {j.salaryPredicted && (
                      <Tip label="Predicted from market data, not posted by the employer">
                        <Badge variant="warn" className="mt-0.5">predicted</Badge>
                      </Tip>
                    )}
                  </div>
                </motion.button>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
