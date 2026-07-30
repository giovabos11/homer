import type { ConnectionStatus, JobStatus, LegitVerdict } from '@shared';
import {
  Banknote, Building2, Flame, Globe, KeyRound, Landmark, Link2, Linkedin, ListChecks,
  MessageSquare, Newspaper, PenLine, Rss, Shield, ShieldAlert, ShieldCheck, ShieldX, Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tip } from '@/components/ui/controls';
import { STATUS_LABEL } from '@/lib/format';
import { cn } from '@/lib/utils';

/* ------------------------------ LegitBadge ------------------------------ */
export function LegitBadge({ verdict, reasons, compact }: { verdict: LegitVerdict; reasons?: string[]; compact?: boolean }) {
  const cfg = {
    legit: { icon: ShieldCheck, variant: 'good' as const, label: 'Legit' },
    suspicious: { icon: ShieldAlert, variant: 'warn' as const, label: 'Suspicious' },
    scam: { icon: ShieldX, variant: 'critical' as const, label: 'Scam' },
    unchecked: { icon: Shield, variant: 'outline' as const, label: 'Unchecked' },
  }[verdict];
  const Icon = cfg.icon;
  const badge = (
    <Badge variant={cfg.variant} className="cursor-default">
      <Icon className="h-3 w-3" />
      {!compact && cfg.label}
    </Badge>
  );
  if (!reasons?.length) return badge;
  return (
    <Tip
      label={
        <ul className="list-disc pl-4 space-y-0.5">
          {reasons.slice(0, 5).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      }
    >
      {badge}
    </Tip>
  );
}

/* ------------------------------ SourceIcon ------------------------------ */
const SOURCE_META: Record<string, { icon: typeof Globe; label: string }> = {
  greenhouse: { icon: Building2, label: 'Greenhouse' },
  lever: { icon: Building2, label: 'Lever' },
  ashby: { icon: Building2, label: 'Ashby' },
  ats_boards: { icon: Building2, label: 'ATS boards' },
  remoteok: { icon: Globe, label: 'RemoteOK' },
  remotive: { icon: Globe, label: 'Remotive' },
  weworkremotely: { icon: Rss, label: 'WeWorkRemotely' },
  hn_hiring: { icon: Newspaper, label: 'HN Who is hiring' },
  freehire: { icon: Sparkles, label: 'freehire.me' },
  linkedin: { icon: Linkedin, label: 'LinkedIn' },
  adzuna: { icon: Banknote, label: 'Adzuna' },
  usajobs: { icon: Landmark, label: 'USAJobs' },
  manual: { icon: PenLine, label: 'Manual entry' },
  url: { icon: Link2, label: 'Pasted URL' },
  email: { icon: MessageSquare, label: 'Email opportunity' },
};

export function SourceIcon({ source, withLabel, className }: { source: string; withLabel?: boolean; className?: string }) {
  const meta = SOURCE_META[source] ?? { icon: Globe, label: source };
  const Icon = meta.icon;
  const node = (
    <span className={cn('inline-flex items-center gap-1 text-ink-3', className)}>
      <Icon className="h-3.5 w-3.5" />
      {withLabel && <span className="text-xs">{meta.label}</span>}
    </span>
  );
  return withLabel ? node : <Tip label={meta.label}>{node}</Tip>;
}

export function sourceLabel(source: string): string {
  return SOURCE_META[source]?.label ?? source;
}

/* ------------------------------ StatusPill ------------------------------ */
const STATUS_DOT: Record<JobStatus, string> = {
  discovered: 'var(--ink-3)',
  screened: 'var(--series-7)',
  tailoring: 'var(--series-4)',
  ready_for_review: 'var(--warn-raw)',
  applied: 'var(--accent)',
  interview: 'var(--series-3)',
  offer: 'var(--good)',
  hired: 'var(--good)',
  rejected: 'var(--critical)',
  no_response: 'var(--ink-3)',
  withdrawn: 'var(--ink-3)',
  quarantined: 'var(--critical)',
  skipped: 'var(--ink-3)',
};

export function StatusPill({ status, className }: { status: JobStatus; className?: string }) {
  return (
    <Badge className={cn('cursor-default', className)}>
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: STATUS_DOT[status] }} />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/* --------------------------- Connection status --------------------------- */
export const CONN_STATUS: Record<
  ConnectionStatus,
  { label: string; color: string; pulse: boolean }
> = {
  ok: { label: 'Connected', color: 'var(--good)', pulse: true },
  degraded: { label: 'Degraded', color: 'var(--warn-raw)', pulse: true },
  down: { label: 'Down', color: 'var(--critical)', pulse: false },
  waiting_session: { label: 'Waiting for session', color: 'var(--series-7)', pulse: true },
  needs_key: { label: 'Needs API key', color: 'var(--ink-3)', pulse: false },
  disabled: { label: 'Disabled', color: 'var(--line-strong)', pulse: false },
};

export function ConnDot({ status, size = 8 }: { status: ConnectionStatus; size?: number }) {
  const cfg = CONN_STATUS[status];
  return (
    <span
      className={cn('inline-block rounded-full shrink-0', cfg.pulse && 'status-pulse')}
      style={{ width: size, height: size, background: cfg.color, ['--pulse-color' as string]: cfg.color }}
    />
  );
}

/* ------------------------------ Misc icons ------------------------------ */
export { Flame, KeyRound, ListChecks };
