import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-45 active:scale-[0.98] cursor-pointer select-none',
  {
    variants: {
      variant: {
        default: 'bg-accent text-white hover:brightness-110 shadow-sm',
        secondary: 'bg-overlay text-ink hover:bg-line border border-line',
        outline: 'border border-line-strong text-ink-2 hover:bg-overlay hover:text-ink',
        ghost: 'text-ink-2 hover:bg-overlay hover:text-ink',
        good: 'bg-good text-white hover:brightness-110 shadow-sm',
        destructive: 'bg-critical text-white hover:brightness-110 shadow-sm',
        'destructive-outline': 'border border-critical/40 text-critical hover:bg-critical/10',
      },
      size: {
        default: 'h-9 px-3.5 text-sm',
        sm: 'h-7.5 px-2.5 text-xs',
        lg: 'h-10 px-5 text-sm',
        icon: 'h-9 w-9',
        'icon-sm': 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button ref={ref} type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
