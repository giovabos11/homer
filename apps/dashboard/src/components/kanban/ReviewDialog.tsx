import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileText, Loader2, Lock, PencilLine, Save, Sparkles, XCircle } from 'lucide-react';
import type { Application, Job, ScreeningAnswerValue } from '@shared';
import { isNeedsUserAnswer } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import type { ApplicationArtifacts } from '@/api/types';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Checkbox } from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

/** Long prose gets a textarea; short facts get a single-line input. */
function isLongAnswer(question: string, value: string): boolean {
  return value.length > 90 || /describe|why|tell us|explain|cover letter|about you/i.test(question);
}

interface Row {
  question: string;
  value: string;
  needsUser: boolean;
  hint?: string;
  suggestion?: string;
  standingKey?: string;
}

function toRows(answers: Record<string, ScreeningAnswerValue> | null): Row[] {
  if (!answers) return [];
  // What needs the user comes first — that is the whole job of this tab.
  const entries = Object.entries(answers).sort(
    (a, b) => Number(isNeedsUserAnswer(b[1])) - Number(isNeedsUserAnswer(a[1])),
  );
  return entries.map(([question, value]) => {
    if (isNeedsUserAnswer(value)) {
      return {
        question,
        value: '',
        needsUser: true,
        hint: value.hint,
        suggestion: value.suggestion,
        standingKey: value.standingKey,
      };
    }
    return { question, value, needsUser: false };
  });
}

function AnswerField({
  row,
  draft,
  standing,
  onChange,
  onStandingChange,
}: {
  row: Row;
  draft: string;
  standing: boolean;
  onChange: (v: string) => void;
  onStandingChange: (v: boolean) => void;
}) {
  const long = isLongAnswer(row.question, draft || row.value);
  const stillNeeded = row.needsUser && draft.trim() === '';
  const canBeStanding = !!row.standingKey;

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5',
        stillNeeded ? 'border-warn-raw/50 bg-warn-raw/8' : 'border-line bg-raised/50',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className={cn('text-xs leading-relaxed', stillNeeded ? 'text-warn font-medium' : 'text-ink-3')}>
          {row.question}
        </p>
        {stillNeeded ? (
          <Badge variant="warn" className="shrink-0">Needs your answer</Badge>
        ) : row.needsUser ? (
          <Badge variant="good" className="shrink-0">Answered</Badge>
        ) : null}
      </div>

      {long ? (
        <Textarea
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          placeholder={row.needsUser ? 'Type your answer…' : ''}
          className="mt-1.5 min-h-20 text-[13px]"
        />
      ) : (
        <Input
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          placeholder={row.needsUser ? 'Type your answer…' : ''}
          className="mt-1.5 text-[13px]"
        />
      )}

      {row.hint && stillNeeded && <p className="text-[11px] text-ink-3 mt-1.5 leading-relaxed">{row.hint}</p>}
      {row.suggestion && stillNeeded && (
        <button
          type="button"
          onClick={() => onChange(row.suggestion!)}
          className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-accent hover:underline cursor-pointer"
        >
          <Sparkles className="h-3 w-3" /> Use “{row.suggestion}”
        </button>
      )}

      {canBeStanding && (
        <label className="mt-2 flex items-center gap-2 cursor-pointer">
          <Checkbox checked={standing} onCheckedChange={(v) => onStandingChange(v === true)} />
          <span className="text-[11px] text-ink-3">Save as a standing answer — reused on every future application</span>
        </label>
      )}
    </div>
  );
}

export function ReviewDialog({
  app,
  job,
  open,
  onOpenChange,
}: {
  app: Application;
  job: Job;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const upsertApplication = useStore((s) => s.upsertApplication);
  const [artifacts, setArtifacts] = useState<ApplicationArtifacts | null>(null);
  const [loading, setLoading] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [standing, setStanding] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setArtifacts(null);
    let alive = true;
    api
      .getApplicationArtifacts(app.id)
      .then((a) => alive && setArtifacts(a))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, app.id]);

  const answers = artifacts?.answers ?? app.answers;
  const rows = useMemo(() => toRows(answers), [answers]);

  // Reset the editing buffer whenever a new answer set arrives. Standing-answer
  // saving defaults ON for the questions that have a standing key.
  useEffect(() => {
    setDrafts(Object.fromEntries(rows.map((r) => [r.question, r.value])));
    setStanding(Object.fromEntries(rows.filter((r) => r.standingKey).map((r) => [r.question, true])));
  }, [rows]);

  const dirty = rows.some((r) => (drafts[r.question] ?? '') !== r.value);
  const unresolved = rows.filter((r) => r.needsUser && (drafts[r.question] ?? '').trim() === '');
  const unsavedAnswers = rows.filter((r) => r.needsUser && (drafts[r.question] ?? '').trim() !== '');
  const blocked = unresolved.length > 0 || unsavedAnswers.length > 0;

  const saveAnswers = async () => {
    const changed: Record<string, string> = {};
    for (const r of rows) {
      const next = (drafts[r.question] ?? '').trim();
      if (next && next !== r.value) changed[r.question] = next;
    }
    if (Object.keys(changed).length === 0) return;
    setSaving(true);
    try {
      const res = await api.patchApplicationAnswers(app.id, {
        answers: changed,
        saveStanding: Object.keys(changed).filter((q) => standing[q]),
      });
      upsertApplication(res.application);
      setArtifacts((a) => (a ? { ...a, answers: res.application.answers } : a));
      pushToast(
        'success',
        res.savedAsStanding.length > 0
          ? `Answers saved — ${res.savedAsStanding.length} kept as standing answers`
          : 'Answers saved',
      );
    } catch (e) {
      pushToast('error', `Could not save answers: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="max-w-4xl">
        <DialogTitle className="pr-8">
          Review application — {job.company}
        </DialogTitle>
        <DialogDescription>
          {job.title} · 1-page PDFs verified against the ATS text layer. Approving hands off to the{' '}
          apply driver under the <Badge variant="accent">{app.gate}</Badge> gate.
        </DialogDescription>

        <div className="mt-4">
          {loading ? (
            <div className="h-80 flex items-center justify-center text-ink-3 text-sm gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading artifacts…
            </div>
          ) : (
            <Tabs defaultValue={unresolved.length > 0 ? 'answers' : 'resume'}>
              <TabsList>
                <TabsTrigger value="resume">
                  <FileText className="h-3.5 w-3.5" /> Resume
                </TabsTrigger>
                <TabsTrigger value="cover">
                  <FileText className="h-3.5 w-3.5" /> Cover letter
                </TabsTrigger>
                <TabsTrigger value="answers">
                  Screening answers
                  {unresolved.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-warn-raw/25 text-warn px-1.5 text-[10px] font-semibold tabular">
                      {unresolved.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="resume" className="mt-3">
                {artifacts?.resumeUrl ? (
                  <iframe title="Resume preview" src={artifacts.resumeUrl} className="w-full h-[52vh] rounded-lg border border-line bg-white" />
                ) : (
                  <p className="text-sm text-ink-3 py-8 text-center">Resume PDF not generated yet.</p>
                )}
              </TabsContent>
              <TabsContent value="cover" className="mt-3">
                {artifacts?.coverLetterUrl ? (
                  <iframe title="Cover letter preview" src={artifacts.coverLetterUrl} className="w-full h-[52vh] rounded-lg border border-line bg-white" />
                ) : (
                  <p className="text-sm text-ink-3 py-8 text-center">Cover letter PDF not generated yet.</p>
                )}
              </TabsContent>
              <TabsContent value="answers" className="mt-3">
                {rows.length > 0 ? (
                  <>
                    <div className="space-y-2 max-h-[46vh] overflow-y-auto pr-1">
                      {rows.map((r) => (
                        <AnswerField
                          key={r.question}
                          row={r}
                          draft={drafts[r.question] ?? ''}
                          standing={standing[r.question] ?? false}
                          onChange={(v) => setDrafts((d) => ({ ...d, [r.question]: v }))}
                          onStandingChange={(v) => setStanding((s) => ({ ...s, [r.question]: v }))}
                        />
                      ))}
                    </div>
                    <div className="flex items-center justify-between gap-3 mt-2.5 pt-2.5 border-t border-line">
                      <p className="text-[11px] text-ink-3 leading-relaxed">
                        Every answer is editable. Homer fills what your profile and standing answers cover, and asks
                        for the rest instead of guessing.
                      </p>
                      <Button size="sm" disabled={!dirty || saving} onClick={() => void saveAnswers()}>
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        Save answers
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-ink-3 py-8 text-center">No screening answers recorded for this form.</p>
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>

        <div className="mt-4 pt-3 border-t border-line">
          {rejecting ? (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                placeholder="What should the re-draft fix? (e.g. lead with the Stripe billing work)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                variant="destructive"
                disabled={!reason.trim() || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.rejectApplication(app.id, reason.trim());
                    onOpenChange(false);
                  } finally {
                    setBusy(false);
                    setRejecting(false);
                    setReason('');
                  }
                }}
              >
                Reject draft
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-ink-3 inline-flex items-center gap-1.5 max-w-lg leading-relaxed">
                {unresolved.length > 0 ? (
                  <>
                    <Lock className="h-3.5 w-3.5 text-warn shrink-0" />
                    <span>
                      {unresolved.length} question{unresolved.length === 1 ? '' : 's'} still need
                      {unresolved.length === 1 ? 's' : ''} your answer. Fill{' '}
                      {unresolved.length === 1 ? 'it' : 'them'} in Screening answers, then approve.
                    </span>
                  </>
                ) : unsavedAnswers.length > 0 ? (
                  <>
                    <PencilLine className="h-3.5 w-3.5 text-warn shrink-0" />
                    <span>Save your answers before approving.</span>
                  </>
                ) : (
                  <span>Unknowns are asked, never invented.</span>
                )}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="destructive-outline" onClick={() => setRejecting(true)} disabled={busy}>
                  <XCircle className="h-4 w-4" /> Reject
                </Button>
                <Button
                  variant="good"
                  disabled={busy || blocked}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.approveApplication(app.id);
                      onOpenChange(false);
                    } catch (e) {
                      pushToast('error', `Approve failed: ${e instanceof Error ? e.message : e}`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" /> Approve & submit
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
