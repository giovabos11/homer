import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Check, CircleHelp, GitBranch, Lightbulb, Loader2, MessageSquare, MessageSquareWarning,
  Mic2, RefreshCcw, Send, Sparkles, User,
} from 'lucide-react';
import type { FeedbackKind } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { fmtRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/common/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Markdown } from '@/components/common/Markdown';

const KINDS: { kind: FeedbackKind; label: string; icon: typeof Lightbulb; hint: string }[] = [
  { kind: 'idea', label: 'Idea', icon: Lightbulb, hint: 'Suggest a strategy or config improvement' },
  { kind: 'concern', label: 'Concern', icon: MessageSquareWarning, hint: 'Something worries you — the agent investigates' },
  { kind: 'comment', label: 'Comment', icon: MessageSquare, hint: 'A note for the record' },
  { kind: 'update', label: 'Update', icon: RefreshCcw, hint: 'Life/profile changes to fold into documents' },
  { kind: 'retro', label: 'Interview retro', icon: Mic2, hint: 'What happened in an interview — feeds recalibration' },
];

/* ----------------------------------- Ask panel ----------------------------------- */
function AskPanel() {
  const asks = useStore((s) => s.asks);
  const beginAsk = useStore((s) => s.beginAsk);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [asks]);

  const submit = async () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    try {
      const { requestId } = await api.ask(p);
      beginAsk(requestId, p);
      setPrompt('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col min-h-[540px] max-h-[calc(100vh-180px)]">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-violet" /> Ask anything
          </span>
        }
        hint="Runs with your profile, portfolio, and pipeline as context — ghostwriting follows your voice rules"
      />
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-3 space-y-4">
        {asks.length === 0 ? (
          <EmptyState
            icon={CircleHelp}
            title="Ask about anything in your search"
            hint={'Try: "Which application should I prioritize today?" · "Draft a reply to this recruiter message: …" · "Summarize my pipeline for the week"'}
          />
        ) : (
          asks.map((a) => (
            <div key={a.requestId} className="space-y-2.5">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-xl rounded-br-sm bg-accent/12 border border-accent/20 px-3.5 py-2.5">
                  <p className="text-[13px] text-ink whitespace-pre-wrap">{a.prompt}</p>
                </div>
              </div>
              <div className="flex gap-2.5">
                <div className="h-7 w-7 rounded-lg bg-violet/15 border border-violet/30 flex items-center justify-center shrink-0 mt-0.5">
                  <Sparkles className="h-3.5 w-3.5 text-violet" />
                </div>
                <div className="flex-1 min-w-0 rounded-xl rounded-tl-sm bg-raised border border-line px-3.5 py-2.5">
                  {a.response ? (
                    <div className={cn(!a.done && 'stream-caret')}>
                      <Markdown>{a.response}</Markdown>
                    </div>
                  ) : (
                    <p className="text-xs text-ink-3 inline-flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" /> thinking…
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="border-t border-line px-3 py-3">
        <div className="flex gap-2 items-end">
          <Textarea
            placeholder="Ask, or paste a message to answer…  (Enter to send, Shift+Enter for newline)"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            className="min-h-11 max-h-40"
            rows={1}
          />
          <Button onClick={() => void submit()} disabled={!prompt.trim() || busy} size="icon" aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------- Feedback panel --------------------------------- */
function FeedbackPanel() {
  const feedback = useStore((s) => s.feedback);
  const refreshFeedback = useStore((s) => s.refreshFeedback);
  const [kind, setKind] = useState<FeedbackKind>('idea');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState<number | null>(null);
  const active = KINDS.find((k) => k.kind === kind)!;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Feedback & course corrections"
          hint="The agent analyzes what you write and proposes plan changes — applied only with your approval"
        />
        <div className="px-4 pb-4 space-y-2.5">
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map((k) => {
              const Icon = k.icon;
              return (
                <button
                  key={k.kind}
                  onClick={() => setKind(k.kind)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer',
                    kind === k.kind
                      ? 'border-accent/40 bg-accent/12 text-accent'
                      : 'border-line text-ink-3 hover:text-ink-2 hover:border-line-strong',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" /> {k.label}
                </button>
              );
            })}
          </div>
          <Textarea
            placeholder={
              kind === 'retro'
                ? 'How did the interview go? What questions came up, what felt strong, where did you struggle?'
                : active.hint + '…'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-24"
          />
          <div className="flex justify-end">
            <Button
              disabled={!text.trim() || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.postFeedback(kind, text.trim());
                  setText('');
                  await refreshFeedback();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send to agent
            </Button>
          </div>
        </div>
      </Card>

      <div className="space-y-3">
        <AnimatePresence initial={false}>
          {feedback.map((f) => {
            const meta = KINDS.find((k) => k.kind === f.kind);
            const Icon = meta?.icon ?? MessageSquare;
            return (
              <motion.div
                key={f.id}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-xl border border-line bg-surface overflow-hidden"
              >
                <div className="px-4 py-2.5 flex items-center gap-2 border-b border-line/70 bg-overlay/40">
                  <Icon className="h-3.5 w-3.5 text-ink-3" />
                  <span className="text-xs font-semibold text-ink-2">{meta?.label ?? f.kind}</span>
                  <span className="text-[11px] text-ink-3 ml-auto">{fmtRelative(f.createdAt)}</span>
                </div>
                <div className="px-4 py-3 space-y-3">
                  <div className="flex gap-2">
                    <User className="h-3.5 w-3.5 text-ink-3 shrink-0 mt-0.5" />
                    <p className="text-[13px] text-ink-2 leading-relaxed">{f.inputMd}</p>
                  </div>
                  {f.responseMd ? (
                    <div className="rounded-lg bg-raised border border-line px-3.5 py-2.5">
                      <Markdown>{f.responseMd}</Markdown>
                    </div>
                  ) : (
                    <p className="text-xs text-ink-3 inline-flex items-center gap-1.5 pl-6">
                      <Loader2 className="h-3 w-3 animate-spin" /> The agent is analyzing…
                    </p>
                  )}
                  {f.planChange && (
                    <div
                      className={cn(
                        'rounded-lg border px-3.5 py-2.5 flex items-center gap-3',
                        f.planChange.applied ? 'border-good/30 bg-good/8' : 'border-accent/30 bg-accent/8',
                      )}
                    >
                      <GitBranch className={cn('h-4 w-4 shrink-0', f.planChange.applied ? 'text-good-text' : 'text-accent')} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-ink">Proposed plan change</p>
                        <p className="text-xs text-ink-2 mt-0.5">{f.planChange.description}</p>
                      </div>
                      {f.planChange.applied ? (
                        <Badge variant="good"><Check className="h-3 w-3" /> Applied</Badge>
                      ) : (
                        <Button
                          size="sm"
                          disabled={applying === f.id}
                          onClick={async () => {
                            setApplying(f.id);
                            try {
                              await api.applyPlanChange(f.id);
                              await refreshFeedback();
                            } finally {
                              setApplying(null);
                            }
                          }}
                        >
                          {applying === f.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Apply plan change
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {feedback.length === 0 && (
          <Card>
            <EmptyState
              icon={MessageSquare}
              title="No feedback yet"
              hint="Ideas, concerns, updates, and interview retros all live here — each one gets an analyzed response, and real changes ship as approvable plan diffs."
            />
          </Card>
        )}
      </div>
    </div>
  );
}

export default function Assistant() {
  return (
    <div className="space-y-4">
      <PageHeader title="Assistant" subtitle="Ask anything, leave feedback, or run a post-interview retro" />
      <div className="grid grid-cols-[1.25fr_1fr] gap-4 max-[1420px]:grid-cols-1 items-start">
        <AskPanel />
        <FeedbackPanel />
      </div>
    </div>
  );
}
