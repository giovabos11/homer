// Profile modal — opened from the sidebar profile chip. Contact overrides
// (PATCH /api/profile), the documents/ inventory, and an inline editor for the
// text profile files (GET/PUT /api/profile/files, strict server-side safe-list).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardList, FileText, Loader2, PencilLine, Save, UserRound, X,
} from 'lucide-react';
import type { StandingAnswerKey, StandingAnswers } from '@shared';
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

/* --------------------------- Standing answers form --------------------------- */
type FieldSpec = { key: StandingAnswerKey; label: string; placeholder: string; wide?: boolean; numeric?: boolean };

const ANSWER_GROUPS: { title: string; note: string; fields: FieldSpec[] }[] = [
  {
    title: 'Compensation & timing',
    note: 'Homer never puts a number here on your behalf.',
    fields: [
      { key: 'salaryExpectation', label: 'Salary expectations', placeholder: 'e.g. Open, targeting market rate for the role', wide: true },
      { key: 'salaryMinAcceptable', label: 'Minimum acceptable (optional)', placeholder: 'e.g. 80000', numeric: true },
      { key: 'earliestStartDate', label: 'Earliest start date', placeholder: 'e.g. Two weeks from an offer' },
      { key: 'noticePeriod', label: 'Notice period', placeholder: 'e.g. None' },
    ],
  },
  {
    title: 'Work authorization',
    note: 'Your words, verbatim. Citizenship is never inferred from anything else in your profile.',
    fields: [
      { key: 'citizenshipStatus', label: 'Citizenship / status', placeholder: 'e.g. Authorized to work in the US for any employer', wide: true },
      { key: 'requiresSponsorship', label: 'Requires sponsorship', placeholder: 'yes or no' },
      { key: 'securityClearance', label: 'Security clearance', placeholder: 'e.g. None' },
      { key: 'willingToRelocate', label: 'Willing to relocate', placeholder: 'e.g. Yes, anywhere in the US' },
    ],
  },
  {
    title: 'Voluntary EEO',
    note: '“Prefer not to say” is always a valid answer and is the default.',
    fields: [
      { key: 'eeoRace', label: 'Race / ethnicity', placeholder: 'Prefer not to say' },
      { key: 'eeoGender', label: 'Gender', placeholder: 'Prefer not to say' },
      { key: 'eeoVeteran', label: 'Veteran status', placeholder: 'Prefer not to say' },
      { key: 'eeoDisability', label: 'Disability status', placeholder: 'Prefer not to say' },
    ],
  },
  {
    title: 'Other',
    note: 'Optional. Blank stays blank.',
    fields: [
      { key: 'preferredPronouns', label: 'Preferred pronouns', placeholder: 'left blank unless you set it' },
      { key: 'referencesAvailable', label: 'References', placeholder: 'e.g. Available on request' },
    ],
  },
];

function StandingAnswersSection() {
  const pushToast = useStore((s) => s.pushToast);
  const setMissingStanding = useStore((s) => s.setMissingStanding);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);

  const toForm = (a: StandingAnswers): Record<string, string> =>
    Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v == null ? '' : String(v)]));

  useEffect(() => {
    let alive = true;
    api
      .getStandingAnswers()
      .then((r) => {
        if (!alive) return;
        setForm(toForm(r.answers));
        setLoaded(toForm(r.answers));
        setMissingStanding(r.missingCritical);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [setMissingStanding]);

  const dirty = loaded != null && Object.keys(form).some((k) => (form[k] ?? '') !== (loaded[k] ?? ''));

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if ((loaded?.[k] ?? '') === v) continue;
        if (k === 'salaryMinAcceptable') body[k] = v.trim() === '' ? null : Number(v.replace(/[^\d.]/g, ''));
        else body[k] = v;
      }
      const r = await api.putStandingAnswers(body as Partial<StandingAnswers>);
      setForm(toForm(r.answers));
      setLoaded(toForm(r.answers));
      setMissingStanding(r.missingCritical);
      pushToast('success', 'Application answers saved — reused on every application from now on');
    } catch (e) {
      pushToast('error', `Save failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-1 inline-flex items-center gap-1.5">
        <ClipboardList className="h-3.5 w-3.5 text-accent" /> Application answers
      </p>
      <p className="text-[11px] text-ink-3 mb-2.5 leading-relaxed">
        Answer these once and every application reuses them. Anything left blank keeps its question flagged, and an
        application that hits a flagged question waits for you instead of guessing.
      </p>
      <div className="space-y-3.5">
        {ANSWER_GROUPS.map((g) => (
          <div key={g.title}>
            <div className="flex items-baseline gap-2 mb-1.5">
              <p className="text-[11px] font-semibold text-ink-2 uppercase tracking-wide">{g.title}</p>
              <p className="text-[11px] text-ink-3">{g.note}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 max-[860px]:grid-cols-1">
              {g.fields.map((f) => (
                <label key={f.key} className={cn('block', f.wide && 'col-span-2 max-[860px]:col-span-1')}>
                  <span className="text-[11px] text-ink-3">
                    {f.label}
                    {(form[f.key] ?? '') === '' && <span className="text-warn ml-1.5">not answered</span>}
                  </span>
                  <Input
                    value={form[f.key] ?? ''}
                    placeholder={f.placeholder}
                    inputMode={f.numeric ? 'numeric' : undefined}
                    onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    className="mt-0.5"
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end mt-2.5">
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save answers
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
            <StandingAnswersSection />

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
