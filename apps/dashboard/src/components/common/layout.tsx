import * as React from 'react';
import { motion } from 'motion/react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-lg font-semibold text-ink tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-ink-3 mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  hint,
  right,
  className,
}: {
  title: React.ReactNode;
  hint?: string;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink truncate">{title}</h2>
        {hint && <p className="text-xs text-ink-3 mt-0.5">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn('flex flex-col items-center justify-center text-center py-12 px-6', className)}
    >
      <div className="h-11 w-11 rounded-xl bg-overlay border border-line flex items-center justify-center mb-3">
        <Icon className="h-5 w-5 text-ink-3" />
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="text-xs text-ink-3 mt-1 max-w-sm leading-relaxed">{hint}</p>}
      {action && <div className="mt-3.5">{action}</div>}
    </motion.div>
  );
}

export function StatTile({
  label,
  value,
  icon: Icon,
  accent = 'var(--accent)',
  sub,
  index = 0,
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  accent?: string;
  sub?: string;
  index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30, delay: index * 0.05 }}
      className="rounded-xl border border-line bg-surface px-3.5 py-3 flex items-center gap-3 min-w-0"
    >
      <div
        className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: `color-mix(in oklab, ${accent} 12%, transparent)` }}
      >
        <Icon className="h-4.5 w-4.5" style={{ color: accent }} />
      </div>
      <div className="min-w-0">
        <div className="text-lg font-semibold text-ink leading-6 tabular truncate">{value}</div>
        <div className="text-[11px] text-ink-3 leading-3.5 truncate">
          {label}
          {sub && <span className="text-ink-3/70"> · {sub}</span>}
        </div>
      </div>
    </motion.div>
  );
}
