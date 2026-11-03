import type { FastifyPluginAsync } from 'fastify';
import { cached } from './databases/cache.js';

export const MAX_TASK_TAGS = 3;

export interface TaskTagItem {
  id: string;
  label: string;
  desc: string;
}

export interface TaskCategoryGroup {
  id: string;
  label: string;
  desc: string;
  tags: TaskTagItem[];
}

export const TASK_CATEGORIES: TaskCategoryGroup[] = [
  {
    id: 'research',
    label: 'Research & Analysis',
    desc: 'Deep research, verification, synthesis, and strategic intelligence workflows',
    tags: [
      { id: 'Research', label: 'Research', desc: 'Multi-source investigation and structured research synthesis' },
      { id: 'Summarization', label: 'Summarization', desc: 'Condense long documents, threads, or transcripts into key takeaways' },
      { id: 'Due Diligence', label: 'Due Diligence', desc: 'Structured project, company, or protocol evaluation briefs' },
      { id: 'Fact Verification', label: 'Fact Verification', desc: 'Cross-reference claims against primary sources and citations' },
      { id: 'Market Intelligence', label: 'Market Intelligence', desc: 'Track sector trends, catalysts, and ecosystem signals' },
      { id: 'Competitive Analysis', label: 'Competitive Analysis', desc: 'Benchmark products, positioning, pricing, and feature gaps' },
      { id: 'Literature Review', label: 'Literature Review', desc: 'Survey technical papers, specs, and prior art systematically' },
      { id: 'Data Synthesis', label: 'Data Synthesis', desc: 'Combine heterogeneous inputs into unified decision-ready reports' },
    ],
  },
  {
    id: 'coding',
    label: 'Software & DevOps',
    desc: 'Code generation, review, testing, debugging, and engineering automation',
    tags: [
      { id: 'Code Generation', label: 'Code Generation', desc: 'Scaffold modules, features, and production-ready implementations' },
      { id: 'Code Review', label: 'Code Review', desc: 'Inspect diffs for correctness, maintainability, and edge cases' },
      { id: 'Bug Triage', label: 'Bug Triage', desc: 'Reproduce, isolate root causes, and propose targeted fixes' },
      { id: 'Test Automation', label: 'Test Automation', desc: 'Generate unit, integration, and regression test suites' },
      { id: 'Security Audit', label: 'Security Audit', desc: 'Scan application logic and dependencies for vulnerabilities' },
      { id: 'API Integration', label: 'API Integration', desc: 'Connect external services, webhooks, and typed SDK payloads' },
      { id: 'Refactoring', label: 'Refactoring', desc: 'Modernize architecture, types, and performance bottlenecks' },
      { id: 'Incident Triage', label: 'Incident Triage', desc: 'Analyze logs, traces, and alerts to accelerate remediation' },
    ],
  },
  {
    id: 'data',
    label: 'Data & Extraction',
    desc: 'Structured parsing, scraping, indexing, analytics, and ML pipelines',
    tags: [
      { id: 'Web Scraping', label: 'Web Scraping', desc: 'Crawl and normalize live web pages into clean datasets' },
      { id: 'Data Extraction', label: 'Data Extraction', desc: 'Pull typed entities, tables, and fields from raw unstructured text' },
      { id: 'Document Parsing', label: 'Document Parsing', desc: 'Convert PDFs, filings, and forms into structured schemas' },
      { id: 'ETL Pipeline', label: 'ETL Pipeline', desc: 'Ingest, validate, transform, and route multi-stage data feeds' },
      { id: 'SQL Analytics', label: 'SQL Analytics', desc: 'Author analytical queries, cohorts, and metric summaries' },
      { id: 'Classification', label: 'Classification', desc: 'Label, route, and score records across custom taxonomies' },
      { id: 'Forecasting', label: 'Forecasting', desc: 'Model time-series projections, demand, and scenario ranges' },
      { id: 'RAG Indexing', label: 'RAG Indexing', desc: 'Chunk, embed, and enrich knowledge bases for retrieval' },
    ],
  },
  {
    id: 'content',
    label: 'Content & Media',
    desc: 'Editorial writing, localization, creative media, and publishing pipelines',
    tags: [
      { id: 'Copywriting', label: 'Copywriting', desc: 'Draft launch copy, landing pages, campaigns, and messaging' },
      { id: 'Technical Writing', label: 'Technical Writing', desc: 'Produce developer docs, API guides, specs, and changelogs' },
      { id: 'Translation', label: 'Translation', desc: 'Localize content accurately across languages and tone registers' },
      { id: 'Image Generation', label: 'Image Generation', desc: 'Compose visual concepts, illustrations, and brand assets' },
      { id: 'Audio Processing', label: 'Audio Processing', desc: 'Transcribe, clean, synthesize, or transform audio streams' },
      { id: 'Video Scripting', label: 'Video Scripting', desc: 'Storyboard scenes, narration, hooks, and production cues' },
      { id: 'Social Publishing', label: 'Social Publishing', desc: 'Adapt announcements into multi-channel social threads' },
      { id: 'SEO Optimization', label: 'SEO Optimization', desc: 'Structure search intent, metadata, and semantic coverage' },
    ],
  },
  {
    id: 'ops',
    label: 'Business & Support',
    desc: 'Revenue operations, customer workflows, compliance, and executive reporting',
    tags: [
      { id: 'Lead Qualification', label: 'Lead Qualification', desc: 'Enrich inbound accounts and score buyer intent' },
      { id: 'CRM Sync', label: 'CRM Sync', desc: 'Update pipeline records, notes, and follow-up actions' },
      { id: 'Customer Triage', label: 'Customer Triage', desc: 'Classify support tickets and draft accurate resolutions' },
      { id: 'Email Automation', label: 'Email Automation', desc: 'Draft personalized outreach, replies, and digest sequences' },
      { id: 'Meeting Briefs', label: 'Meeting Briefs', desc: 'Prepare agendas, attendee dossiers, and action-item recaps' },
      { id: 'Invoice Processing', label: 'Invoice Processing', desc: 'Extract line items, totals, and billing discrepancies' },
      { id: 'Compliance Check', label: 'Compliance Check', desc: 'Review policies, disclosures, and regulatory requirements' },
      { id: 'Report Generation', label: 'Report Generation', desc: 'Compile recurring KPI briefings and stakeholder updates' },
    ],
  },
  {
    id: 'web3',
    label: 'Onchain & Finance',
    desc: 'Onchain analytics, smart contract review, DeFi intents, and treasury workflows',
    tags: [
      { id: 'Portfolio Monitoring', label: 'Portfolio Monitoring', desc: 'Track balances, exposure, PnL, and cross-chain positions' },
      { id: 'Onchain Analytics', label: 'Onchain Analytics', desc: 'Inspect wallet flows, liquidity, and contract activity' },
      { id: 'Contract Audit', label: 'Contract Audit', desc: 'Analyze smart contract invariants, access control, and risks' },
      { id: 'DeFi Execution', label: 'DeFi Execution', desc: 'Prepare quotes, swaps, and cross-chain intent routes' },
      { id: 'Governance Tracking', label: 'Governance Tracking', desc: 'Monitor DAO proposals, votes, and protocol upgrades' },
      { id: 'Risk Scoring', label: 'Risk Scoring', desc: 'Evaluate counterparty, collateral, and market volatility risk' },
      { id: 'Treasury Ops', label: 'Treasury Ops', desc: 'Coordinate payouts, allocations, and accounting reconciliations' },
      { id: 'Alerting', label: 'Alerting', desc: 'Trigger real-time notifications on threshold or state changes' },
    ],
  },
];

export const TASK_TAGS = TASK_CATEGORIES.flatMap(category => category.tags.map(tag => tag.id));

export function toTagSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const TASK_SLUG_MAP = new Map<string, string>(
  TASK_CATEGORIES.flatMap(category =>
    category.tags.flatMap(tag => [
      [toTagSlug(tag.id), tag.id] as const,
      [toTagSlug(tag.label), tag.id] as const,
    ]),
  ),
);

export function resolveCanonicalTasks(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(',')) {
      const slug = toTagSlug(part);
      if (!slug) continue;
      const canonical = TASK_SLUG_MAP.get(slug);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      resolved.push(canonical);
      if (resolved.length >= MAX_TASK_TAGS) return resolved;
    }
  }
  return resolved;
}

export const optionsRoutes: FastifyPluginAsync = async app => {
  app.get('/api/options', async () =>
    cached('options', 3600, 300_000, async () => ({
      tasks: TASK_CATEGORIES,
      maxTaskTags: MAX_TASK_TAGS,
    })),
  );
};
