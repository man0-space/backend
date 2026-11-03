export interface Consent {
  id: string;
  policy: string;
  accepted: string;
}

export const policy = {
  updated: '2026-04-19',
  title: 'Terms & Privacy',
  sections: [
    {
      title: 'Usage & Outputs',
      heading: 'Usage & Outputs',
      text: 'You are responsible for the prompts and files you submit and for reviewing all workflow outputs before acting on them.',
      paragraphs: [
        'You are responsible for the prompts and files you submit and for reviewing all workflow outputs before acting on them.',
      ],
    },
    {
      title: 'Billing & Royalties',
      heading: 'Billing & Royalties',
      text: 'Each run is billed from your active session balance for step execution plus the listed creator and service fees.',
      paragraphs: [
        'Each run is billed from your active session balance for step execution plus the listed creator and service fees.',
      ],
    },
    {
      title: 'Creator Publishing',
      heading: 'Creator Publishing',
      text: 'Draft workflows stay private to you until published. Publishing makes a workflow runnable by others at your chosen royalty rate.',
      paragraphs: [
        'Draft workflows stay private to you until published. Publishing makes a workflow runnable by others at your chosen royalty rate.',
      ],
    },
    {
      title: 'Privacy & Inputs',
      heading: 'Privacy & Inputs',
      text: 'Run inputs are sent only to the steps inside the workflow you execute. Avoid submitting private keys or sensitive secrets.',
      paragraphs: [
        'Run inputs are sent only to the steps inside the workflow you execute. Avoid submitting private keys or sensitive secrets.',
      ],
    },
    {
      title: 'Assumption of Risk',
      heading: 'Assumption of Risk',
      text: 'Automated steps and third-party services may produce inaccurate results or fail mid-run. Use outputs at your own discretion.',
      paragraphs: [
        'Automated steps and third-party services may produce inaccurate results or fail mid-run. Use outputs at your own discretion.',
      ],
    },
  ],
  checks: {
    terms: 'I accept the Terms of Use.',
    privacy: 'I accept the Privacy Policy.',
  },
} as const;

export const text = [
  `${policy.title} (${policy.updated})`,
  ...policy.sections.flatMap(s => [s.heading, ...s.paragraphs]),
  'Confidential Intents',
  policy.checks.terms,
  policy.checks.privacy,
].join('\n\n');
