import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CalendarPlus, Check, ChevronDown, Clock, Inbox as InboxIcon, Mail, MailQuestion,
  RefreshCw, Send, Sparkles, ThumbsDown, ThumbsUp, X,
} from 'lucide-react';
import type { EmailRecord } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { fmtRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/common/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Markdown } from '@/components/common/Markdown';

type ReplyTab = 'all' | 'accepted' | 'rejected' | 'neutral';

const CLASS_META: Record<string, { label: string; variant: 'good' | 'critical' | 'accent' | 'violet' | 'default' }> = {
  reply_accepted: { label: 'Accepted', variant: 'good' },
  interview_invite: { label: 'Interview invite', variant: 'good' },
  reply_rejected: { label: 'Rejected', variant: 'critical' },
  opportunity: { label: 'Opportunity', variant: 'violet' },
  followup: { label: 'Follow-up', variant: 'accent' },
  other: { label: 'Update', variant: 'default' },
};

function tabOf(e: EmailRecord): ReplyTab {
  if (e.classification === 'reply_accepted' || e.classification === 'interview_invite') return 'accepted';
  if (e.classification === 'reply_rejected') return 'rejected';
  return 'neutral';
}

function ReplyRow({ email, jobName }: { email: EmailRecord; jobName: string | null }) {
  const [open, setOpen] = useState(false);
  const meta = CLASS_META[email.classification] ?? CLASS_META.other!;
  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="border-b border-line/70 last:border-0">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-overlay/50 transition-colors cursor-pointer">
        <div
          className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
          style={{ background: 'color-mix(in oklab, var(--accent) 10%, transparent)' }}
        >
          <Mail className="h-4 w-4 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-ink truncate">{email.subject}</p>
            <Badge variant={meta.variant} className="shrink-0">{meta.label}</Badge>
          </div>
          <p className="text-xs text-ink-3 mt-0.5 line-clamp-2 leading-relaxed">{email.summary}</p>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-ink-3">
            <span>{fmtRelative(email.receivedAt)}</span>
            {jobName && <span className="text-ink-3/80">· {jobName}</span>}
          </div>
        </div>
        <ChevronDown className={cn('h-4 w-4 text-ink-3 mt-1 transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && email.bodyMd && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mx-4 mb-3 rounded-lg border border-line bg-raised/50 px-4 py-3">
              <Markdown>{email.bodyMd}</Markdown>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function OutboxCard({ email }: { email: EmailRecord }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="rounded-xl border border-warn-raw/35 bg-surface overflow-hidden"
    >
      <div className="px-4 py-3 flex items-start gap-2.5 bg-warn-raw/8">
        <MailQuestion className="h-4.5 w-4.5 text-warn shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink truncate">{email.subject}</p>
          <p className="text-xs text-ink-3 mt-0.5">{email.summary}</p>
        </div>
        <Badge variant="warn">Awaiting approval</Badge>
      </div>
      {/* diff-style draft preview */}
      <div className="px-4 py-3">
        <div className="rounded-lg border border-line overflow-hidden font-mono text-[12px] leading-relaxed">
          <div className="px-3 py-1.5 bg-overlay text-ink-3 border-b border-line flex items-center justify-between">
            <span>draft → outbox</span>
            <button className="text-accent hover:underline cursor-pointer font-sans" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Collapse' : 'Show full draft'}
            </button>
          </div>
          <div className={cn('bg-good/6', !expanded && 'max-h-40 overflow-hidden relative')}>
            {(email.bodyMd ?? '').split('\n').map((line, i) => (
              <div key={i} className="flex">
                <span className="w-7 shrink-0 text-center text-good-text/70 select-none bg-good/10">+</span>
                <span className="px-2 text-ink-2 whitespace-pre-wrap flex-1">{line || ' '}</span>
              </div>
            ))}
            {!expanded && (
              <div className="absolute bottom-0 inset-x-0 h-10 bg-gradient-to-t from-[var(--surface)] to-transparent pointer-events-none" />
            )}
          </div>
        </div>
        <div className="flex items-center justify-between mt-3">
          <p className="text-[11px] text-ink-3">Sends via the Gmail connector in the next Claude session. Never without your approval.</p>
          <div className="flex gap-2 shrink-0">
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.rejectOutbox(email.id);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ThumbsDown className="h-3.5 w-3.5" /> Reject
            </Button>
            <Button
              size="sm"
              variant="good"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.approveOutbox(email.id);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ThumbsUp className="h-3.5 w-3.5" /> Approve & queue send
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function FollowupsTimeline() {
  const emails = useStore((s) => s.emails);
  const schedule = useStore((s) => s.schedule);
  const items = useMemo(() => {
    const sent = emails
      .filter((e) => e.direction === 'outbound' && e.classification === 'followup')
      .map((e) => ({
        key: `e${e.id}`,
        title: e.subject,
        at: e.sentAt ?? e.approvedAt ?? e.receivedAt,
        state: e.sentAt ? ('sent' as const) : e.approvedAt ? ('queued' as const) : e.needsApproval ? ('draft' as const) : ('rejected' as const),
      }));
    const due = schedule
      .filter((ev) => ev.type === 'followup_due' && new Date(ev.startsAt).getTime() > Date.now())
      .map((ev) => ({ key: `s${ev.id}`, title: ev.title, at: ev.startsAt, state: 'due' as const }));
    return [...due, ...sent].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  }, [emails, schedule]);

  const STATE = {
    sent: { icon: Check, color: 'var(--good)', label: 'Sent' },
    queued: { icon: Send, color: 'var(--accent)', label: 'Approved — queued' },
    draft: { icon: Clock, color: 'var(--warn-raw)', label: 'Draft awaiting approval' },
    rejected: { icon: X, color: 'var(--ink-3)', label: 'Rejected' },
    due: { icon: CalendarPlus, color: 'var(--series-7)', label: 'Coming up' },
  } as const;

  return (
    <Card>
      <CardHeader title="Follow-ups" hint="Quiet ≥ 10 days → drafted automatically, max 2 per application" />
      {items.length === 0 ? (
        <EmptyState icon={Clock} title="No follow-ups yet" hint="When an application goes quiet for 10 days, a follow-up draft will appear here for your approval." />
      ) : (
        <div className="px-5 pb-4">
          <div className="relative border-l border-line-strong/60 ml-1.5 space-y-4 pt-1">
            {items.map((it) => {
              const cfg = STATE[it.state];
              const Icon = cfg.icon;
              return (
                <div key={it.key} className="relative pl-5">
                  <span
                    className="absolute -left-[7px] top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--surface)] flex items-center justify-center"
                    style={{ background: cfg.color }}
                  />
                  <p className="text-xs font-medium text-ink leading-snug">{it.title}</p>
                  <p className="text-[11px] text-ink-3 mt-0.5 flex items-center gap-1">
                    <Icon className="h-3 w-3" style={{ color: cfg.color }} /> {cfg.label}
                    {it.at ? ` · ${fmtRelative(it.at)}` : ''}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function Inbox() {
  const emails = useStore((s) => s.emails);
  const jobs = useStore((s) => s.jobs);
  const applications = useStore((s) => s.applications);
  const connections = useStore((s) => s.connections);
  const [tab, setTab] = useState<ReplyTab>('all');
  const [scanBusy, setScanBusy] = useState(false);

  const gmail = connections.find((c) => c.name === 'gmail');
  const inbound = emails
    .filter((e) => e.direction === 'inbound')
    .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
  const visible = tab === 'all' ? inbound : inbound.filter((e) => tabOf(e) === tab);
  const outbox = emails.filter((e) => e.direction === 'outbound' && e.needsApproval);

  const jobNameFor = (e: EmailRecord): string | null => {
    if (e.applicationId == null) return null;
    const a = applications.find((x) => x.id === e.applicationId);
    const j = a && jobs.find((x) => x.id === a.jobId);
    return j ? `${j.company} — ${j.title}` : null;
  };

  const counts = {
    all: inbound.length,
    accepted: inbound.filter((e) => tabOf(e) === 'accepted').length,
    rejected: inbound.filter((e) => tabOf(e) === 'rejected').length,
    neutral: inbound.filter((e) => tabOf(e) === 'neutral').length,
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inbox"
        subtitle={
          gmail?.status === 'waiting_session'
            ? 'Gmail is session-only — scans run whenever a Claude session is active'
            : 'Replies classified automatically; every outbound email waits for your approval'
        }
      >
        <Button
          variant="secondary"
          disabled={scanBusy}
          onClick={async () => {
            setScanBusy(true);
            try {
              await api.triggerEmailScan();
            } finally {
              setScanBusy(false);
            }
          }}
        >
          <RefreshCw className={cn('h-4 w-4', scanBusy && 'animate-spin')} /> Scan now
        </Button>
      </PageHeader>

      <div className="grid grid-cols-[1.4fr_1fr] gap-4 max-[1420px]:grid-cols-1 items-start">
        <Card>
          <CardHeader
            title="Replies"
            right={
              <Tabs value={tab} onValueChange={(v) => setTab(v as ReplyTab)}>
                <TabsList>
                  <TabsTrigger value="all">All {counts.all > 0 && <span className="tabular">{counts.all}</span>}</TabsTrigger>
                  <TabsTrigger value="accepted">Accepted {counts.accepted > 0 && <span className="tabular">{counts.accepted}</span>}</TabsTrigger>
                  <TabsTrigger value="rejected">Rejected {counts.rejected > 0 && <span className="tabular">{counts.rejected}</span>}</TabsTrigger>
                  <TabsTrigger value="neutral">Neutral {counts.neutral > 0 && <span className="tabular">{counts.neutral}</span>}</TabsTrigger>
                </TabsList>
              </Tabs>
            }
          />
          {visible.length === 0 ? (
            <EmptyState
              icon={InboxIcon}
              title={tab === 'all' ? 'No replies yet' : `No ${tab} replies`}
              hint="When employers reply, the email scan classifies them and links them to the right application automatically."
            />
          ) : (
            <div>
              {visible.map((e) => (
                <ReplyRow key={e.id} email={e} jobName={jobNameFor(e)} />
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2 px-1">
              <Sparkles className="h-4 w-4 text-warn" />
              <h2 className="text-sm font-semibold text-ink">Outbox — needs your approval</h2>
              {outbox.length > 0 && <Badge variant="warn">{outbox.length}</Badge>}
            </div>
            {outbox.length === 0 ? (
              <Card>
                <EmptyState
                  icon={Send}
                  title="Outbox is clear"
                  hint="Drafted replies and follow-ups land here first. Nothing sends without a recorded approval."
                />
              </Card>
            ) : (
              <div className="space-y-3">
                <AnimatePresence>
                  {outbox.map((e) => (
                    <OutboxCard key={e.id} email={e} />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>
          <FollowupsTimeline />
        </div>
      </div>
    </div>
  );
}
