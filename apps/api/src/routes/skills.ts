import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';

const VALID_TYPES = ['prompt', 'code', 'mcp-tool', 'wiki-style'] as const;

const NOBILIS_GREEN_STYLE = `You are a technical documentation designer for a Wiki.js knowledge base.
Generate a visually rich HTML page using only inline CSS (no external stylesheets, no <script>, no <link> tags).
CRITICAL — Element rules (violations break the page in Wiki.js):
  1. NEVER use <h1>, <h2>, <h3>, <h4>, <h5>, <h6> — use <div style="font-size:...;font-weight:600;"> instead.
  2. NEVER use <p> — use <div style="font-size:13px;color:#5C5B57;line-height:1.5;"> for body text.
  3. NEVER use <ul>, <ol>, <li> — use <div> rows with a bullet character if needed.
  4. NEVER use <figure>, <figcaption>, <section>, <article>, <header>, <footer>, <nav>, <main> — use <div> or <span> only.
  5. NEVER use <em>, <i>, <b> — use <span style="font-style:italic"> or <span style="font-weight:600"> instead.
  6. <strong> and <a> and <code> are OK to use.
CRITICAL — CSS rules (any violation silently breaks layouts):
  7. NEVER use display:flex or display:grid ANYWHERE — not even for single-row nav.
  8. NEVER use grid-template-columns, auto-fit, minmax, or any CSS Grid/Flex property.
  9. For ALL multi-column layouts: use <table cellpadding="0" cellspacing="8" border="0">.
  10. For inline pill tabs: use display:inline-block on each <a> or <div> — no flex container.
  11. Use HTML entities for special chars: &rarr; &rsaquo; &uuml; &ouml; &auml; &Uuml; &amp; &mdash; etc.
  12. Do NOT set background-color or padding on the outermost wrapper div.
  13. Outer wrapper: <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1C1A;line-height:1.5;padding:0;">
Color palette: #2D7A4F (green primary), #1C1C1A (dark text), #5C5B57 (muted text), #8A8985 (subtle), #E0DFDB (border), #F5F4F1 (light bg), #EAF5EE (green tint), #FFFFFF (card bg)
Style components (proven to work — match exactly):
- Breadcrumb: <div style="padding:12px 0 0;"><span style="font-size:12px;font-weight:500;color:#8A8985;"><a style="color:#8A8985;text-decoration:none;">...</a><span style="margin:0 6px;">&rsaquo;</span>...</span></div>
- Tab pills: active=<a style="display:inline-block;background:#2D7A4F;border-radius:20px;padding:8px 20px;font-size:13px;font-weight:500;color:#FFFFFF;margin-right:8px;margin-bottom:8px;"> inactive=<a style="display:inline-block;background:#FFFFFF;border:1px solid #E0DFDB;border-radius:20px;padding:8px 20px;font-size:13px;font-weight:500;color:#5C5B57;margin-right:8px;margin-bottom:8px;">
- Hero banner: <div style="background:#2D7A4F;border-radius:12px;padding:32px;margin:12px 0 24px;"> title=<div style="font-size:32px;font-weight:600;color:#FFFFFF;"> subtitle=<div style="font-size:15px;color:#FFFFFFB3;">
- Section heading: <div style="font-size:18px;font-weight:600;color:#1C1C1A;margin-top:32px;margin-bottom:16px;">
- Feature cards: <table cellpadding="0" cellspacing="8" border="0"><tr><td style="vertical-align:top;background:transparent;"> card=<div style="background:#FFFFFF;border:1px solid #E0DFDB;border-radius:12px;overflow:hidden;"> header=<div style="background:#EAF5EE;padding:16px 20px;border-bottom:1px solid #E0DFDB;"> body=<div style="padding:14px 20px 18px;">
- Screenshot: <div style="margin:20px 0;"><img src="..." style="max-width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.12);"><div style="text-align:center;color:#8A8985;font-size:14px;margin-top:8px;">caption</div></div>`;

const BUILT_IN_SKILLS = [
  { name: 'TranslateXLIFF', type: 'code', description: 'Translate XLIFF strings using glossary' },
  { name: 'ReviewTranslations', type: 'code', description: 'Quality-check translations' },
  { name: 'SummarizeBCObject', type: 'prompt', description: 'Describe a BC table/page/codeunit from metadata' },
  { name: 'GenerateWikiPage', type: 'prompt', description: 'Produce structured markdown documentation' },
  { name: 'CreateDevOpsBranch', type: 'mcp-tool', description: 'Create a branch in Azure DevOps or GitHub' },
  { name: 'CreatePullRequest', type: 'mcp-tool', description: 'Open a PR with changes' },
  {
    name: 'WikiHtmlStyleNobilisGreen',
    type: 'wiki-style',
    description: 'Nobilis green design system — div-only inline CSS, table-based columns, green hero banners',
    promptTemplate: NOBILIS_GREEN_STYLE,
  },
] as const;

export async function skillRoutes(app: FastifyInstance) {
  // ─── List skills (optional ?type= filter) ────────────────────────────────
  app.get<{ Querystring: { type?: string } }>('/', async (req) => {
    const typeFilter = req.query.type?.trim();
    const skills = await prisma.skill.findMany({
      where: typeFilter ? { type: typeFilter } : undefined,
      orderBy: [{ builtIn: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { agents: true } } },
    });
    return { data: skills };
  });

  // ─── List wiki-style skills ───────────────────────────────────────────────
  app.get('/wiki-styles', async () => {
    const skills = await prisma.skill.findMany({
      where: { type: 'wiki-style' },
      orderBy: [{ builtIn: 'desc' }, { name: 'asc' }],
    });
    return { data: skills };
  });

  // ─── Get skill ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const skill = await prisma.skill.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { agents: true } } },
    });

    if (!skill) {
      return reply.status(404).send({ error: 'not_found', message: 'Skill not found' });
    }

    return { data: skill };
  });

  // ─── Create skill ─────────────────────────────────────────────────────────
  app.post<{
    Body: {
      name: string;
      description?: string;
      type?: string;
      promptTemplate?: string;
      inputSchema?: string;
      outputSchema?: string;
    };
  }>('/', async (req, reply) => {
    const { name, description, type, promptTemplate, inputSchema, outputSchema } = req.body;

    if (!name) {
      return reply.status(400).send({ error: 'validation', message: 'name is required' });
    }

    if (type && !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
      return reply
        .status(400)
        .send({ error: 'validation', message: 'type must be prompt, code, or mcp-tool' });
    }

    const skill = await prisma.skill.create({
      data: { name, description, type, promptTemplate, inputSchema, outputSchema, builtIn: false },
    });
    return reply.status(201).send({ data: skill });
  });

  // ─── Update skill ─────────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      type?: string;
      promptTemplate?: string;
      inputSchema?: string;
      outputSchema?: string;
    };
  }>('/:id', async (req, reply) => {
    const existing = await prisma.skill.findUnique({ where: { id: req.params.id } });

    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Skill not found' });
    }

    if (existing.builtIn) {
      return reply
        .status(403)
        .send({ error: 'forbidden', message: 'Built-in skills cannot be modified' });
    }

    if (req.body.type && !VALID_TYPES.includes(req.body.type as (typeof VALID_TYPES)[number])) {
      return reply
        .status(400)
        .send({ error: 'validation', message: 'type must be prompt, code, or mcp-tool' });
    }

    const skill = await prisma.skill.update({
      where: { id: req.params.id },
      data: req.body,
    });
    return { data: skill };
  });

  // ─── Delete skill ─────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const existing = await prisma.skill.findUnique({ where: { id: req.params.id } });

    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Skill not found' });
    }

    if (existing.builtIn) {
      return reply
        .status(403)
        .send({ error: 'forbidden', message: 'Built-in skills cannot be deleted' });
    }

    await prisma.skill.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  // ─── Seed built-in skills ─────────────────────────────────────────────────
  app.post('/seed-built-in', async (_req, reply) => {
    const results = await Promise.all(
      BUILT_IN_SKILLS.map((skill) =>
        prisma.skill.upsert({
          where: { name_builtIn: { name: skill.name, builtIn: true } },
          update: { description: skill.description, ...('promptTemplate' in skill ? { promptTemplate: skill.promptTemplate } : {}) },
          create: { ...skill, builtIn: true },
        })
      )
    );

    return reply.status(201).send({ data: results });
  });
}
