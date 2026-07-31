import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ----------------------------- Slider ----------------------------- */
export function Slider({ className, ...props }: React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn('relative flex w-full touch-none select-none items-center h-5 cursor-pointer', className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-overlay border border-line">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border-2 border-accent bg-surface shadow transition-transform hover:scale-110 focus-visible:outline-none" />
    </SliderPrimitive.Root>
  );
}

/* ----------------------------- Switch ----------------------------- */
export function Switch({ className, ...props }: React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5.5 w-9.5 shrink-0 items-center rounded-full border border-line bg-overlay transition-colors data-[state=checked]:bg-accent data-[state=checked]:border-accent cursor-pointer disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

/* ----------------------------- Checkbox ---------------------------- */
export function Checkbox({ className, ...props }: React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'h-4.5 w-4.5 shrink-0 rounded border border-line-strong bg-surface transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent cursor-pointer flex items-center justify-center',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Check className="h-3 w-3 text-white" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/* ------------------------------ Tabs ------------------------------- */
export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex items-center gap-0.5 rounded-lg bg-overlay border border-line p-0.5', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-ink-3 transition-colors hover:text-ink data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm cursor-pointer',
        className,
      )}
      {...props}
    />
  );
}

/* ----------------------------- Tooltip ----------------------------- */
export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * Note for callers: the trigger uses Radix `asChild`, which merges props onto
 * the child. A child whose `className` is a *function* (react-router `NavLink`)
 * gets that function stringified into the class attribute and loses all its
 * styling — pass a plain string className instead.
 */
export function Tip({
  label,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 6,
}: {
  label: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}) {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          className="tip-content z-50 max-w-72 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-ink-2 shadow-[var(--shadow-pop)]"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ---------------------------- Progress ------------------------------ */
export function Progress({
  value,
  className,
  barClassName,
}: {
  value: number; // 0..1
  className?: string;
  barClassName?: string;
}) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-overlay border border-line', className)}>
      <div
        className={cn('h-full rounded-full bg-accent transition-[width] duration-500 ease-out', barClassName)}
        style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
      />
    </div>
  );
}
