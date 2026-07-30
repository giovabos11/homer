import { useEffect, useState } from 'react';
import { CheckCircle2, FileText, Flag, Loader2, XCircle } from 'lucide-react';
import type { Application, Job } from '@shared';
import { api } from '@/api/client';
import type { ApplicationArtifacts } from '@/api/types';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

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
  const [artifacts, setArtifacts] = useState<ApplicationArtifacts | null>(null);
  const [loading, setLoading] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

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
            <Tabs defaultValue="resume">
              <TabsList>
                <TabsTrigger value="resume">
                  <FileText className="h-3.5 w-3.5" /> Resume
                </TabsTrigger>
                <TabsTrigger value="cover">
                  <FileText className="h-3.5 w-3.5" /> Cover letter
                </TabsTrigger>
                <TabsTrigger value="answers">Screening answers</TabsTrigger>
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
                {answers ? (
                  <div className="space-y-2 max-h-[52vh] overflow-y-auto pr-1">
                    {Object.entries(answers).map(([q, a]) => (
                      <div key={q} className="rounded-lg border border-line bg-raised/50 px-3 py-2">
                        <p className="text-xs text-ink-3">{q}</p>
                        {a.startsWith('Flagged') ? (
                          <p className="text-sm mt-0.5 text-warn font-medium inline-flex items-center gap-1.5">
                            <Flag className="h-3.5 w-3.5 shrink-0" /> {a}
                          </p>
                        ) : (
                          <p className="text-sm mt-0.5 text-ink">{a}</p>
                        )}
                      </div>
                    ))}
                  </div>
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
            <div className="flex items-center justify-between">
              <p className="text-xs text-ink-3">
                Unknowns (salary, start date) are flagged, never invented.
              </p>
              <div className="flex items-center gap-2">
                <Button variant="destructive-outline" onClick={() => setRejecting(true)} disabled={busy}>
                  <XCircle className="h-4 w-4" /> Reject
                </Button>
                <Button
                  variant="good"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.approveApplication(app.id);
                      onOpenChange(false);
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
