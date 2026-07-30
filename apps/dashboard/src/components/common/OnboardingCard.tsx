// First-run onboarding (Mission Control): shown while GET /api/profile reports
// profileReady:false — i.e. CLAUDE.md / the candidate-profile skill still hold
// their "[PLACEHOLDER" / "[YOUR_" tokens. Three steps walk the accent→violet
// journey the XP bar uses; steps flip to a done-check as the profile fills in,
// then the card leaves on its own. Dismissable, persisted in localStorage.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link } from 'react-router-dom';
import { CheckCircle2, FolderOpen, Radar, Sparkles, Terminal, X } from 'lucide-react';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { Button } from '@/components/ui/button';

const DISMISS_KEY = 'ajs.onboarding.dismissed';
const POLL_MS = 20_000;
const LINGER_MS = 3200; // long enough to see the checks land before the card leaves

/** One leg of the journey per step: accent → blend → violet (mirrors the XP bar). */
const STEP_TINTS = [
  'var(--accent)',
  'color-mix(in oklab, var(--accent) 45%, var(--violet))',
  'var(--violet)',
];

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[11px] text-ink-2 bg-overlay border border-line rounded px-1 py-px whitespace-nowrap">
      {children}
    </code>
  );
}

export function OnboardingCard() {
  const profile = useStore((s) => s.profile);
  const setProfile = useStore((s) => s.setProfile);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  const ready = profile?.profileReady ?? true; // unknown → don't flash the card
  const hasDocs = (profile?.documents.length ?? 0) > 0;

  // While the card is up, poll the profile so the done-checks flip live once
  // documents land / the /setup merge writes the profile files.
  useEffect(() => {
    if (ready || dismissed) return;
    const t = window.setInterval(() => {
      void api.getProfile().then(setProfile).catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [ready, dismissed, setProfile]);

  // When profileReady flips true while the card is visible, keep it up briefly
  // so the checks are seen, then let it leave for good.
  const [linger, setLinger] = useState(false);
  const sawUnready = useRef(false);
  useEffect(() => {
    if (!ready) {
      sawUnready.current = true;
      return;
    }
    if (sawUnready.current) {
      setLinger(true);
      const t = window.setTimeout(() => setLinger(false), LINGER_MS);
      return () => window.clearTimeout(t);
    }
  }, [ready]);

  const visible = !dismissed && (!ready || linger);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode */
    }
    setDismissed(true);
  };

  const steps = [
    {
      icon: FolderOpen,
      title: 'Add your career documents',
      done: ready || hasDocs,
      body: (
        <>
          Drop your resume and LinkedIn export PDFs into <Code>documents/</Code> in the project
          folder. Homer reads everything in there.
        </>
      ),
    },
    {
      icon: Terminal,
      title: 'Build your profile',
      done: ready,
      body: (
        <>
          Open a terminal in the project folder, run <Code>claude</Code>, then type{' '}
          <Code>/setup</Code>. The guided interview or document scan fills your profile — the file
          watcher keeps it synced from then on.
        </>
      ),
    },
    {
      icon: Radar,
      title: 'Start discovering',
      done: false,
      body: (
        <>
          Connect optional keys in{' '}
          <Link to="/connections" className="text-accent font-medium hover:underline">
            Connections
          </Link>
          , then run a{' '}
          <Link to="/search" className="text-accent font-medium hover:underline">
            Search
          </Link>{' '}
          — or let the discovery worker fill the board on its own.
        </>
      ),
    },
  ];

  return (
    <AnimatePresence>
      {visible && (
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6, transition: { duration: 0.25 } }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          aria-label="First-run setup"
          className="relative overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)] shrink-0"
        >
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-px"
            style={{ background: 'linear-gradient(90deg, var(--accent), var(--violet))' }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'linear-gradient(115deg, color-mix(in oklab, var(--accent) 6%, transparent), transparent 45%, color-mix(in oklab, var(--violet) 6%, transparent))',
            }}
          />
          <div className="relative px-4 pt-3.5 pb-4">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="h-9 w-9 rounded-lg bg-accent/12 border border-accent/25 flex items-center justify-center shrink-0">
                  <Sparkles className="h-4.5 w-4.5 text-accent" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-ink truncate">
                    Welcome to Homer — set up in 3 steps
                  </h2>
                  <p className="text-xs text-ink-3 mt-0.5">
                    The board fills itself once Homer knows who it is applying for.
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss setup guide">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-3 max-[1200px]:grid-cols-1">
              {steps.map((s, i) => {
                const tint = STEP_TINTS[i]!;
                const Icon = s.icon;
                return (
                  <motion.div
                    key={s.title}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 30, delay: 0.08 + i * 0.06 }}
                    className="rounded-lg border border-line bg-raised/50 p-3.5"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <div
                        className="h-8 w-8 rounded-lg border flex items-center justify-center shrink-0"
                        style={{
                          background: `color-mix(in oklab, ${tint} 12%, transparent)`,
                          borderColor: `color-mix(in oklab, ${tint} 30%, transparent)`,
                        }}
                      >
                        <Icon className="h-4 w-4" style={{ color: tint }} />
                      </div>
                      <span
                        className="text-[10px] font-bold uppercase tracking-[0.08em]"
                        style={{ color: tint }}
                      >
                        Step {i + 1}
                      </span>
                      <AnimatePresence>
                        {s.done && (
                          <motion.span
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                            className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-good"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" /> Done
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>
                    <p className="text-[13px] font-semibold text-ink">{s.title}</p>
                    <p className="text-xs text-ink-3 mt-1 leading-relaxed">{s.body}</p>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
