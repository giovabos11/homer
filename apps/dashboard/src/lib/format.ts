import type { Job, JobStatus, RemoteType } from '@shared';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 });

export function fmtMoney(n: number, currency = 'USD'): string {
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : `${currency} `;
  return `${sym}${compact.format(n)}`;
}

export function salaryLabel(job: Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency'>): string | null {
  const cur = job.salaryCurrency ?? 'USD';
  if (job.salaryMin != null && job.salaryMax != null) {
    if (job.salaryMin === job.salaryMax) return fmtMoney(job.salaryMax, cur);
    return `${fmtMoney(job.salaryMin, cur)}–${fmtMoney(job.salaryMax, cur)}`;
  }
  if (job.salaryMax != null) return fmtMoney(job.salaryMax, cur);
  if (job.salaryMin != null) return `${fmtMoney(job.salaryMin, cur)}+`;
  return null;
}

export function fmtDate(iso: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', opts ?? { month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const future = ms < 0;
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  const hr = Math.round(abs / 3600000);
  const day = Math.round(abs / 86400000);
  let label: string;
  if (min < 1) label = 'now';
  else if (min < 60) label = `${min}m`;
  else if (hr < 24) label = `${hr}h`;
  else label = `${day}d`;
  if (label === 'now') return label;
  return future ? `in ${label}` : `${label} ago`;
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  discovered: 'Discovered',
  screened: 'Screened',
  tailoring: 'Tailoring',
  ready_for_review: 'Ready for review',
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Rejected',
  no_response: 'No response',
  withdrawn: 'Withdrawn',
  quarantined: 'Quarantined',
  skipped: 'Skipped',
};

export const REMOTE_LABEL: Record<RemoteType, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
  unknown: '—',
};

export function scoreTone(score: number | null): 'good' | 'mid' | 'low' | 'none' {
  if (score == null) return 'none';
  if (score >= 75) return 'good';
  if (score >= 55) return 'mid';
  return 'low';
}

export function titleCase(s: string): string {
  return s.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
