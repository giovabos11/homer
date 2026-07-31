// Real-option matching (FR-9): a resolved answer must land on a LEGAL option
// or park with the options attached — it is never typed blindly into a select.
import { describe, expect, it } from 'vitest';
import { buildOptionPrompt, matchOption, type FieldOption } from '../src/apply/option-match';
import { planFormFill, type FieldDescriptor } from '../src/apply/playwright-driver';
import type { ApplyProfile } from '../src/apply/driver';

const opts = (...labels: string[]): FieldOption[] => labels.map((l) => ({ value: l.toLowerCase(), label: l }));

describe('deterministic option matching', () => {
  it('exact and punctuation-insensitive matches win first', () => {
    expect(matchOption(opts('Yes', 'No'), 'Yes')).toMatchObject({ via: 'exact' });
    expect(matchOption(opts("Bachelor's degree", 'Master’s degree'), 'Bachelors degree')).toMatchObject({
      via: 'normalized',
    });
  });

  it('synonym classes map prose answers onto the employer’s wording', () => {
    expect(matchOption(opts('Please select', 'Yes', 'No'), 'Yes, for any employer')?.option.label).toBe('Yes');
    expect(
      matchOption(opts('I am authorized to work for any employer in the U.S.', 'I need sponsorship'), 'Yes')?.option
        .label,
    ).toBe('I am authorized to work for any employer in the U.S.');
    expect(
      matchOption(opts('Hispanic or Latino', 'White', 'I do not wish to answer'), 'Prefer not to say')?.option.label,
    ).toBe('I do not wish to answer');
    expect(
      matchOption(opts('Yes', 'No', 'Decline to self-identify'), 'Prefer not to say')?.option.label,
    ).toBe('Decline to self-identify');
    expect(matchOption(opts('High school', "Bachelor's degree", 'PhD'), 'B.S. Computer Science')?.option.label).toBe(
      "Bachelor's degree",
    );
  });

  it('numeric answers land in the right years-of-experience bucket', () => {
    const buckets = opts('0-1 years', '2-4 years', '5+ years');
    expect(matchOption(buckets, '3 years')?.option.label).toBe('2-4 years');
    expect(matchOption(buckets, '8')?.option.label).toBe('5+ years');
  });

  it('returns null rather than guessing when nothing preserves the meaning', () => {
    expect(matchOption(opts('Red', 'Blue'), 'Yes')).toBeNull();
    expect(matchOption(opts('Yes', 'No'), 'Only on Thursdays')).toBeNull();
    expect(matchOption(opts('Please select'), 'Yes')).toBeNull(); // placeholders are not options
  });

  it('the agent prompt enumerates the options and permits "none"', () => {
    const p = buildOptionPrompt('Are you a US citizen?', 'Authorized for any employer', opts('Yes', 'No'));
    expect(p).toContain('0: Yes');
    expect(p).toContain('1: No');
    expect(p).toContain('"index": null');
  });
});

function field(partial: Partial<FieldDescriptor> & { index: number }): FieldDescriptor {
  return {
    tag: 'input', type: 'text', name: '', id: '', placeholder: '', ariaLabel: '',
    labelText: '', contextText: '', required: false, visible: true, value: '', options: [],
    ...partial,
  };
}

const profile: ApplyProfile = {
  fullName: 'Test Candidate',
  firstName: 'Test',
  lastName: 'Candidate',
  email: 'test.candidate@example.com',
  phone: '+1 555-010-0000',
  location: 'Dallas, TX 75231',
  links: [],
  resumePath: null,
  coverLetterPath: null,
  answers: {
    'Are you willing to relocate?': 'Yes, anywhere in the US',
    'Highest education completed': 'Bachelor of Science in Computer Science',
    'Salary expectations': { status: 'needs_user', question: 'Salary expectations', standingKey: 'salaryExpectation' },
  },
};

describe('planFormFill with real option sets', () => {
  it('parks an unmatchable required select WITH its real options attached', () => {
    const optionSet = opts('Please select', 'Sometimes', 'Only with notice');
    const plan = planFormFill(
      [
        field({
          index: 0,
          tag: 'select',
          labelText: 'Are you willing to relocate?',
          required: true,
          options: optionSet.map((o) => o.label),
          optionSet,
        }),
      ],
      profile,
    );
    expect(plan.actions).toEqual([]);
    expect(plan.blockers).toHaveLength(1);
    const blocker = plan.blockers[0]!;
    expect(blocker.reason).toBe('no_option_match');
    expect(blocker.answer).toBe('Yes, anywhere in the US');
    expect(blocker.options?.map((o) => o.label)).toEqual(['Please select', 'Sometimes', 'Only with notice']);
    expect(blocker.apply).toBe('select');
  });

  it('a flagged question parks with the options so the user can click one', () => {
    const optionSet = opts('Under 80k', '80k-120k', 'Over 120k');
    const plan = planFormFill(
      [
        field({
          index: 0,
          tag: 'select',
          labelText: 'Salary expectations',
          required: true,
          options: optionSet.map((o) => o.label),
          optionSet,
        }),
      ],
      profile,
    );
    expect(plan.blockers[0]?.reason).toBe('salary');
    expect(plan.blockers[0]?.options).toHaveLength(3);
  });

  it('radio groups carry an input index per option', () => {
    const plan = planFormFill(
      [
        field({ index: 3, type: 'radio', name: 'reloc', value: 'sometimes', labelText: 'Sometimes', contextText: 'Are you willing to relocate?', required: true }),
        field({ index: 4, type: 'radio', name: 'reloc', value: 'never', labelText: 'Never', contextText: 'Are you willing to relocate?' }),
      ],
      profile,
    );
    expect(plan.blockers[0]?.reason).toBe('no_option_match');
    expect(plan.blockers[0]?.optionIndexes).toEqual([3, 4]);
    expect(plan.blockers[0]?.apply).toBe('check');
  });

  it('a matchable select is filled with the option label, not the raw answer', () => {
    const optionSet = opts('Please select', 'Yes', 'No');
    const plan = planFormFill(
      [
        field({
          index: 0,
          tag: 'select',
          labelText: 'Are you willing to relocate?',
          required: true,
          options: optionSet.map((o) => o.label),
          optionSet,
        }),
      ],
      profile,
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.actions[0]).toMatchObject({ index: 0, kind: 'select', value: 'Yes' });
  });

  it('free-text fields never block when a resolved answer exists', () => {
    const plan = planFormFill(
      [field({ index: 0, labelText: 'Highest education completed', required: true })],
      profile,
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.actions[0]?.value).toBe('Bachelor of Science in Computer Science');
  });
});
