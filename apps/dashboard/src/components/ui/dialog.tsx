import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  wide,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { wide?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
      {/*
        Centering happens on this static layer, never on the animated element.
        Previously the content centered itself with `-translate-x/y-1/2` (which
        Tailwind v4 emits as the `translate` property) while the open keyframe
        also animated `transform: translate(-50%,-50%)` — the two stacked, so
        the first painted frame landed a full panel up-and-left of centre and
        the modal visibly jumped into place when the animation ended. The inner
        panel now animates opacity + scale only.
      */}
      <div className="fixed inset-0 z-50 grid place-items-center p-4 pointer-events-none">
        <DialogPrimitive.Content
          className={cn(
            'dialog-content pointer-events-auto relative w-full rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow-pop)] focus:outline-none max-h-[85vh] overflow-y-auto',
            wide ? 'max-w-3xl' : 'max-w-md',
            className,
          )}
          {...props}
        >
          {children}
          <DialogPrimitive.Close className="absolute right-3.5 top-3.5 rounded-md p-1 text-ink-3 hover:bg-overlay hover:text-ink cursor-pointer">
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-base font-semibold text-ink', className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('mt-1 text-sm text-ink-2', className)} {...props} />;
}
