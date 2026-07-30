import { cn } from '@/lib/utils';
import { scoreTone } from '@/lib/format';

const TONE_COLOR: Record<string, string> = {
  good: 'var(--good)',
  mid: 'var(--warn-raw)',
  low: 'var(--serious)',
  none: 'var(--line-strong)',
};

/** Generic percent ring (0..1). */
export function ProgressRing({
  value,
  size = 36,
  stroke = 3.5,
  color = 'var(--accent)',
  label,
  className,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  label?: string;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, value));
  return (
    <div className={cn('relative inline-flex items-center justify-center shrink-0', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--overlay)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.3,0.8,0.3,1)' }}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-semibold text-ink tabular"
        style={{ fontSize: size / 3.4 }}
      >
        {label ?? `${Math.round(v * 100)}`}
      </span>
    </div>
  );
}

/** Fit-score ring: 0–100 with band color (green ≥75, amber ≥55, orange below). */
export function FitRing({ score, size = 36, className }: { score: number | null; size?: number; className?: string }) {
  const tone = scoreTone(score);
  return (
    <ProgressRing
      value={(score ?? 0) / 100}
      size={size}
      color={TONE_COLOR[tone]}
      label={score == null ? '·' : String(score)}
      className={className}
    />
  );
}
