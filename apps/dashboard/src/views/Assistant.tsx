import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Check, CircleHelp, Eraser, FolderSearch, GitBranch, Lightbulb, Loader2, MessageSquare,
  MessageSquareWarning, Mic2, MessagesSquare, RefreshCcw, RotateCcw, Send, Sparkles, Trash2, User, UserRoundPen,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Markdown } from '@/components/common/Markdown';

const KINDS: { kind: FeedbackKind; label: string; icon: typeof Lightbulb; hint: string }[] = [
  { kind: 'idea', label: 'Idea', icon: Lightbulb, hint: 'Suggest a strategy or config improvement' },
  { kind: 'concern', label: 'Concern', icon: MessageSquareWarning, hint: 'Something worries you — the agent investigates' },
  { kind: 'comment', label: 'Comment', icon: MessageSquare, hint: 'A note for the record' },
  { kind: 'update', label: 'Update', icon: RefreshCcw, hint: 'Life/profile changes to fold into documents' },
  { kind: 'retro', label: 'Interview retro', icon: Mic2, hint: 'What happened in an interview — feeds recalibration' },
];

/* ------------------------------ Shared chat bits ------------------------------ */
function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-xl rounded-br-sm bg-accent/12 border border-accent/20 px-3.5 py-2.5">
        <p className="text-[13px] text-ink whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}

function AssistantBubble({ response, done, tint = 'violet' }: { response: string; done: boolean; tint?: 'violet' | 'accent' }) {
  return (
    <div className="flex gap-2.5">
      <div
        className={cn(
          'h-7 w-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border',
          tint === 'violet' ? 'bg-violet/15 border-violet/30' : 'bg-accent/12 border-accent/25',
        )}
      >
        <Sparkles className={cn('h-3.5 w-3.5', tint === 'violet' ? 'text-violet' : 'text-accent')} />
      </div>
      <div className="flex-1 min-w-0 rounded-xl rounded-tl-sm bg-raised border border-line px-3.5 py-2.5">
        {response ? (
          <div className={cn(!done && 'stream-caret')}>
            <Markdown>{response}</Markdown>
          </div>
        ) : (
          <p className="text-xs text-ink-3 inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> thinking…
          </p>
        )}
      </div>
    </div>
  );
}

function ChatInput({
  placeholder,
  disabled,
  onSend,
}: {
  placeholder: string;
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const t = value.trim();
    if (!t || busy || disabled) return;
    setBusy(true);
    try {
      await onSend(t);
      setValue('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-line px-3 py-3">
      <div className="flex gap-2 items-end">
        <Textarea
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          className="min-h-11 max-h-40"
          rows={1}
        />
        <Button onClick={() => void submit()} disabled={!value.trim() || busy || disabled} size="icon" aria-label="Send">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/* ----------------------------------- Ask tab ----------------------------------- */
function AskBody() {
  const asks = useStore((s) => s.asks);
  const beginAsk = useStore((s) => s.beginAsk);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [asks]);

  return (
    <>
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
              <UserBubble text={a.prompt} />
              <AssistantBubble response={a.response} done={a.done} />
            </div>
          ))
        )}
      </div>
      <ChatInput
        placeholder="Ask, or paste a message to answer…  (Enter to send, Shift+Enter for newline)"
        onSend={async (text) => {
          const { requestId } = await api.ask(text);
          beginAsk(requestId, text);
        }}
      />
    </>
  );
}

/* ------------------------------- Profile Setup tab ------------------------------- */
const SETUP_CHOICES = [
  {
    mode: 'documents' as const,
    icon: FolderSearch,
    title: 'Scan my documents',
    body: 'Reads everything in the documents/ folder (resume, LinkedIn export, diplomas), cross-references it, and builds the profile from real source material. Conflicts are surfaced for you to resolve.',
  },
  {
    mode: 'interview' as const,
    icon: MessagesSquare,
    title: 'Interview me',
    body: 'A guided Q&A, one section at a time: identity, education, experience, skills, goals. Best when starting from scratch — answer in your own words, the assistant structures everything.',
  },
];

function SetupBody() {
  const setup = useStore((s) => s.setup);
  const beginSetup = useStore((s) => s.beginSetup);
  const setSetupSession = useStore((s) => s.setSetupSession);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [starting, setStarting] = useState<'interview' | 'documents' | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [setup.turns]);

  // A stored server-side session survives reloads and restarts — resume it.
  useEffect(() => {
    void api
      .setupStatus()
      .then((st) => {
        if (st.active) setSetupSession(true, st.mode);
      })
      .catch(() => undefined);
  }, [setSetupSession]);

  const lastTurn = setup.turns[setup.turns.length - 1];
  const streaming = !!lastTurn && !lastTurn.done;

  if (!setup.active) {
    return (
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <p className="text-[13px] text-ink-2 leading-relaxed mt-1 mb-3">
          This is the same onboarding the terminal{' '}
          <code className="font-mono text-xs bg-overlay border border-line rounded px-1">/setup</code> command runs, as a
          chat. It fills <span className="font-medium text-ink">CLAUDE.md</span> and the profile skill files that every
          evaluation, resume, and cover letter is grounded in. Pick how to start:
        </p>
        <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
          {SETUP_CHOICES.map((c) => {
            const Icon = c.icon;
            return (
              <button
                key={c.mode}
                disabled={starting !== null}
                onClick={async () => {
                  setStarting(c.mode);
                  try {
                    const { requestId } = await api.setupStart(c.mode);
                    beginSetup(requestId, '', c.mode);
                  } finally {
                    setStarting(null);
                  }
                }}
                className="rounded-xl border border-line bg-raised/50 p-4 text-left transition-all cursor-pointer hover:border-accent/50 hover:bg-accent/6 disabled:opacity-60"
              >
                <div className="h-9 w-9 rounded-lg bg-accent/12 border border-accent/25 flex items-center justify-center mb-2.5">
                  {starting === c.mode ? (
                    <Loader2 className="h-4.5 w-4.5 text-accent animate-spin" />
                  ) : (
                    <Icon className="h-4.5 w-4.5 text-accent" />
                  )}
                </div>
                <p className="text-sm font-semibold text-ink">{c.title}</p>
                <p className="text-xs text-ink-3 mt-1 leading-relaxed">{c.body}</p>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-ink-3 mt-3">
          The assistant only edits the profile files — nothing else in the workspace. Safe to re-run any time.
        </p>
      </div>
    );
  }

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-3 space-y-4">
        {setup.turns.length === 0 && (
          <EmptyState
            icon={UserRoundPen}
            title="Setup session resumed"
            hint="A previous setup conversation is stored server-side. Send a message to continue where you left off, or use Start over for a clean slate."
          />
        )}
        {setup.turns.map((t) => (
          <div key={t.requestId} className="space-y-2.5">
            {t.prompt && <UserBubble text={t.prompt} />}
            <AssistantBubble response={t.response} done={t.done} tint="accent" />
          </div>
        ))}
      </div>
      <ChatInput
        placeholder={streaming ? 'Wait for the assistant to finish…' : 'Answer here…  (Enter to send)'}
        disabled={streaming}
        onSend={async (text) => {
          const { requestId } = await api.setupMessage(text);
          beginSetup(requestId, text);
        }}
      />
    </>
  );
}

/* ------------------------- Tabbed chat card (Ask + Setup) ------------------------- */
function AssistantChatCard() {
  const [tab, setTab] = useState<'ask' | 'setup'>('ask');
  const asks = useStore((s) => s.asks);
  const setup = useStore((s) => s.setup);
  const clearAsks = useStore((s) => s.clearAsks);
  const clearSetup = useStore((s) => s.clearSetup);
  const profile = useStore((s) => s.profile);
  const pushToast = useStore((s) => s.pushToast);

  return (
    <Card className="flex flex-col min-h-[540px] max-h-[calc(100vh-180px)]">
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'ask' | 'setup')}>
          <TabsList>
            <TabsTrigger value="ask">
              <Sparkles className="h-3.5 w-3.5 text-violet" /> Ask
            </TabsTrigger>
            <TabsTrigger value="setup">
              <UserRoundPen className="h-3.5 w-3.5 text-accent" /> Profile Setup
              {profile && !profile.profileReady && (
                <span className="h-1.5 w-1.5 rounded-full bg-warn-raw" aria-label="Profile incomplete" />
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === 'ask' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={asks.length === 0}
            onClick={async () => {
              clearAsks();
              try {
                await api.askClear();
              } catch {
                /* local clear already done; server session will fall out of scope */
              }
            }}
          >
            <Eraser className="h-3.5 w-3.5" /> Clear chat
          </Button>
        ) : (
          setup.active && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (!window.confirm('Start over? The current setup conversation is dropped (profile files already written are kept).')) return;
                await api.setupClear();
                clearSetup();
                pushToast('info', 'Setup session cleared — pick a mode to start fresh');
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Start over
            </Button>
          )
        )}
      </div>
      <p className="px-4 pb-2 text-xs text-ink-3">
        {tab === 'ask'
          ? 'Runs with your profile, portfolio, and pipeline as context — ghostwriting follows your voice rules'
          : 'Build or update the profile Homer applies with — the same flow as the terminal /setup command'}
      </p>
      {tab === 'ask' ? <AskBody /> : <SetupBody />}
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
  const [clearing, setClearing] = useState(false);
  const [applying, setApplying] = useState<number | null>(null);
  const active = KINDS.find((k) => k.kind === kind)!;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Feedback & course corrections"
          hint="The agent analyzes what you write and proposes plan changes — applied only with your approval"
          right={
            feedback.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={clearing}
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Deletes ${feedback.length} feedback ${feedback.length === 1 ? 'entry' : 'entries'} and their responses. Applied plan changes stay in effect.`,
                    )
                  ) {
                    return;
                  }
                  setClearing(true);
                  try {
                    await api.clearFeedback();
                    await refreshFeedback();
                  } finally {
                    setClearing(false);
                  }
                }}
              >
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Clear history
              </Button>
            ) : undefined
          }
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
                <div className="group px-4 py-2.5 flex items-center gap-2 border-b border-line/70 bg-overlay/40">
                  <Icon className="h-3.5 w-3.5 text-ink-3" />
                  <span className="text-xs font-semibold text-ink-2">{meta?.label ?? f.kind}</span>
                  <span className="text-[11px] text-ink-3 ml-auto">{fmtRelative(f.createdAt)}</span>
                  <button
                    aria-label="Delete this entry"
                    className="text-ink-3 hover:text-critical opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
                    onClick={async () => {
                      try {
                        await api.deleteFeedback(f.id);
                      } finally {
                        await refreshFeedback();
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
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
      <PageHeader title="Assistant" subtitle="Ask anything, build your profile, leave feedback, or run a post-interview retro" />
      <div className="grid grid-cols-[1.25fr_1fr] gap-4 max-[1420px]:grid-cols-1 items-start">
        <AssistantChatCard />
        <FeedbackPanel />
      </div>
    </div>
  );
}
