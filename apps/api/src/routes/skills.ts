import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';

const VALID_TYPES = ['prompt', 'code', 'mcp-tool'] as const;

const BUILT_IN_SKILLS = [
  { name: 'TranslateXLIFF', type: 'code', description: 'Translate XLIFF strings using glossary' },
  { name: 'ReviewTranslations', type: 'code', description: 'Quality-check translations' },
  { name: 'SummarizeBCObject', type: 'prompt', description: 'Describe a BC table/page/codeunit from metadata' },
  { name: 'GenerateWikiPage', type: 'prompt', description: 'Produce structured markdown documentation' },
  { name: 'CreateDevOpsBranch', type: 'mcp-tool', description: 'Create a branch in Azure DevOps or GitHub' },
  { name: 'CreatePullRequest', type: 'mcp-tool', description: 'Open a PR with changes' },
] as const;

export async function skillRoutes(app: FastifyInstance) {
  // ─── List skills ──────────────────────────────────────────────────────────
  app.get('/', async () => {
    const skills = await prisma.skill.findMany({
      orderBy: [{ builtIn: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { agents: true } } },
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
          update: {},
          create: { ...skill, builtIn: true },
        })
      )
    );

    return reply.status(201).send({ data: results });
  });
}
