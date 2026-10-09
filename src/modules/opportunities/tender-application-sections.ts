export const TENDER_APPLICATION_SECTIONS = [
  'application-summary',
  'eligibility',
  'technical-response',
  'documents-checklist',
  'commercial-notes',
  'closing',
] as const;

export type TenderApplicationSection = (typeof TENDER_APPLICATION_SECTIONS)[number];
export const TENDER_APPLICATION_SECTION_SET = new Set<string>(TENDER_APPLICATION_SECTIONS);
