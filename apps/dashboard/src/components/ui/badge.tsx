import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-overlay text-ink-2 border border-line',
        accent: 'bg-accent/12 text-accent border border-accent/25',
        good: 'bg-good/12 text-good-text border border-good/25',
        warn: 'bg-warn-raw/12 text-warn border border-warn-raw/30',
        serious: 'bg-serious/12 text-serious border border-serious/30',
        critical: 'bg-critical/12 text-critical border border-critical/30',
        violet: 'bg-violet/12 text-violet border border-violet/25',
        outline: 'border border-line-strong text-ink-3',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

// forwardRef: Badge is used as an asChild target (e.g. inside Tip's
// Tooltip.Trigger) which must attach a ref to its child element.
export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant, ...props },
  ref,
) {
  return <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />;
});
