import { forwardRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, XCircle, X } from 'lucide-react';
import { useStore, type Toast } from '@/store/useStore';
import { celebrate } from '@/lib/celebrate';

const ICONS = {
  info: { icon: Info, color: 'var(--accent)' },
  success: { icon: CheckCircle2, color: 'var(--good)' },
  warning: { icon: AlertTriangle, color: 'var(--warn-raw)' },
  error: { icon: XCircle, color: 'var(--critical)' },
} as const;

// forwardRef: AnimatePresence mode="popLayout" measures exiting children via a
// ref on the direct child component.
const ToastItem = forwardRef<HTMLDivElement, { toast: Toast }>(function ToastItem({ toast }, ref) {
  const dismiss = useStore((s) => s.dismissToast);
  const { icon: Icon, color } = ICONS[toast.level];

  useEffect(() => {
    if (toast.celebrate) celebrate({ x: 0.85, y: 0.85 });
    const t = setTimeout(() => dismiss(toast.id), toast.level === 'warning' ? 9000 : 5200);
    return () => clearTimeout(t);
  }, [toast, dismiss]);

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, x: 60, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-raised px-3.5 py-3 shadow-[var(--shadow-pop)] w-80"
    >
      <Icon className="h-4.5 w-4.5 shrink-0 mt-px" style={{ color }} />
      <p className="text-[13px] text-ink-2 leading-snug flex-1">{toast.message}</p>
      <button
        onClick={() => dismiss(toast.id)}
        className="text-ink-3 hover:text-ink rounded p-0.5 cursor-pointer shrink-0"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
});

export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
