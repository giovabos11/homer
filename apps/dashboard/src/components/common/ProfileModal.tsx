// Profile modal — opened from the sidebar profile chip. Contact overrides
// (PATCH /api/profile), the documents/ inventory, and an inline editor for the
// text profile files (GET/PUT /api/profile/files, strict server-side safe-list).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText, Loader2, PencilLine, Save, UserRound, X,
} from 'lucide-react';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { fmtRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

const SKILL_DIR = '.claude/skills/job-application-assistant';
const PROFILE_FILES: { path: string; label: string }[] = [
  { path: 'CLAUDE.md', label: 'CLAUDE.md — career context (ground truth)' },
  { path: `${SKILL_DIR}/01-candidate-profile.md`, label: '01 · Candidate profile' },
  { path: `${SKILL_DIR}/02-behavioral-profile.md`, label: '02 · Behavioral profile' },
  { path: `${SKILL_DIR}/03-writing-style.md`, label: '03 · Writing style rules' },
  { path: `${SKILL_DIR}/04-job-evaluation.md`, label: '04 · Job evaluation framework' },
  { path: `${SKILL_DIR}/05-cv-templates.md`, label: '05 · CV templates' },
  { path: `${SKILL_DIR}/06-cover-letter-templates.md`, label: '06 · Cover letter templates' },
  { path: `${SKILL_DIR}/07-interview-prep.md`, label: '07 · Interview prep (STAR)' },
  { path: `${SKILL_DIR}/08-application-forms.md`, label: '08 · Screening defaults' },
];

const EDITABLE_EXT = /\.(md|txt)$/i;

function FileEditor({ path, onClose }: { path: string; onClose: () => void }) {
  const setProfile = useStore((s) => s.setProfile);
  const pushToast = useStore((s) => s.pushToast);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    api
      .getProfileFile(path)
      .then((r) => alive && setContent(r.content))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-mono text-ink-2 truncate">{path}</p>
        <div className="flex gap-2 shrink-0">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-3.5 w-3.5" /> Close editor
          </Button>
          <Button
            size="sm"
            disabled={saving || content == null || !dirty}
            onClick={async () => {
              if (content == null) return;
              setSaving(true);
              try {
                await api.putProfileFile(path, content);
                setDirty(false);
                // profileReady may have flipped — refresh identity + onboarding.
                const p = await api.getProfile();
                setProfile(p);
                pushToast('success', `Saved ${path.split('/').pop()}`);
              } catch (e) {
                pushToast('error', `Save failed: ${e instanceof Error ? e.message : e}`);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save file
          </Button>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-critical">{error}</p>
      ) : content == null ? (
        <p className="text-xs text-ink-3 inline-flex items-center gap-1.5 py-6 justify-center w-full">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : (
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
          spellCheck={false}
          className="w-full h-[46vh] rounded-lg border border-line bg-raised/60 p-3 font-mono text-[12px] leading-relaxed text-ink resize-y focus:outline-none focus:border-accent/60"
        />
      )}
    </div>
  );
}

function ContactSection() {
  const profile = useStore((s) => s.profile);
  const setProfile = useStore((s) => s.setProfile);
  const pushToast = useStore((s) => s.pushToast);
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile) setForm({ name: profile.fullName, email: profile.email, phone: profile.phone });
  }, [profile]);

  const changed =
    !!profile &&
    (form.name !== profile.fullName || form.email !== profile.email || form.phone !== profile.phone);

  return (
    <div>
      <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-2">Contact — used to fill forms</p>
      <div className="grid grid-cols-3 gap-2 max-[860px]:grid-cols-1">
        <Input placeholder="Full name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <Input placeholder="Email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
      </div>
      <div className="flex items-center justify-between mt-2">
        <p className="text-[11px] text-ink-3">Overrides what was extracted from your documents; profile files stay untouched.</p>
        <Button
          size="sm"
          disabled={!changed || saving}
          onClick={async () => {
            setSaving(true);
            try {
              const p = await api.patchProfile({
                ...(form.name !== profile?.fullName ? { name: form.name } : {}),
                ...(form.email !== profile?.email ? { email: form.email } : {}),
                ...(form.phone !== profile?.phone ? { phone: form.phone } : {}),
              });
              setProfile(p);
              pushToast('success', 'Contact details saved');
            } catch (e) {
              pushToast('error', `Save failed: ${e instanceof Error ? e.message : e}`);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save contact
        </Button>
      </div>
    </div>
  );
}

export function ProfileModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const profile = useStore((s) => s.profile);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setEditing(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogTitle className="flex items-center gap-2">
          <UserRound className="h-4.5 w-4.5 text-accent" /> Your profile
        </DialogTitle>
        <DialogDescription>
          Everything Homer knows about you. Documents feed the profile files; the profile files ground every
          evaluation, resume, and cover letter.{' '}
          {profile && !profile.profileReady && (
            <span className="text-warn">
              Profile still holds placeholders — build it in{' '}
              <Link to="/assistant" className="underline" onClick={() => onOpenChange(false)}>
                Assistant → Profile Setup
              </Link>
              .
            </span>
          )}
        </DialogDescription>

        {editing ? (
          <div className="mt-4">
            <FileEditor path={editing} onClose={() => setEditing(null)} />
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            <ContactSection />

            <div>
              <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-2">
                Source documents <span className="text-ink-3 normal-case font-normal">(documents/ — watched, edits queue a re-sync)</span>
              </p>
              {profile && profile.documents.length > 0 ? (
                <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                  {profile.documents.map((d) => {
                    const editable = EDITABLE_EXT.test(d.name);
                    const ageDays = (Date.now() - new Date(d.modifiedAt).getTime()) / 86400000;
                    return (
                      <div key={d.path} className="flex items-center gap-2 text-[13px] rounded-md px-2 py-1.5 hover:bg-overlay/60">
                        <FileText className="h-3.5 w-3.5 text-ink-3 shrink-0" />
                        <span className="text-ink-2 truncate flex-1" title={d.path}>{d.name}</span>
                        <Badge variant={ageDays < 7 ? 'good' : ageDays > 30 ? 'warn' : 'default'}>
                          {ageDays < 7 ? 'fresh' : `updated ${fmtRelative(d.modifiedAt)}`}
                        </Badge>
                        {editable ? (
                          <Button variant="ghost" size="sm" onClick={() => setEditing(d.path)}>
                            <PencilLine className="h-3.5 w-3.5" /> Edit
                          </Button>
                        ) : (
                          <span className="text-[10px] text-ink-3 w-14 text-right">read-only</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-ink-3">
                  No documents yet — drop your resume and LinkedIn export into the <code className="font-mono">documents/</code>{' '}
                  folder in the project.
                </p>
              )}
              <p className="text-[11px] text-ink-3 mt-1.5">
                PDFs and other binaries are listed but edited outside; markdown/text files can be edited right here.
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-2">
                Profile files <span className="text-ink-3 normal-case font-normal">(advanced — what the agents actually read)</span>
              </p>
              <div className="grid grid-cols-2 gap-1 max-[860px]:grid-cols-1">
                {PROFILE_FILES.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => setEditing(f.path)}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink-2',
                      'hover:bg-overlay/60 transition-colors cursor-pointer',
                    )}
                  >
                    <PencilLine className="h-3.5 w-3.5 text-ink-3 shrink-0" />
                    <span className="truncate">{f.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
