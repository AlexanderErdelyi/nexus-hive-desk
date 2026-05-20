import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { getXliffStats, parseXliff, serializeXliff } from '@nexus/xliff';
import type { TranslationState } from '@nexus/types';

export async function projectRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { customerId?: string } }>('/', async (req) => {
    const where: { customerId?: string | null } = {};
    if (req.query.customerId === 'none') {
      where.customerId = null;
    } else if (req.query.customerId) {
      where.customerId = req.query.customerId;
    }

    const projects = await prisma.project.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true } },
        _count: { select: { xliffFiles: true } },
      },
    });
    return { data: projects };
  });

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        customer: { select: { id: true, name: true } },
        xliffFiles: {
          select: {
            id: true,
            filename: true,
            uploadedAt: true,
            sourceLanguage: true,
            targetLanguage: true,
            remoteConnectionId: true,
            remotePath: true,
            remoteBranch: true,
            remoteRepo: true,
          },
        },
        _count: { select: { glossaryEntries: true } },
      },
    });

    if (!project) {
      return reply.status(404).send({ error: 'not_found', message: 'Project not found' });
    }

    return { data: project };
  });

  app.post<{ Body: { name: string; description?: string; customerId?: string; sourceLanguage: string; targetLanguage: string } }>(
    '/',
    async (req, reply) => {
      const { name, description, customerId, sourceLanguage = 'en', targetLanguage = 'de' } = req.body;
      if (!name) {
        return reply.status(400).send({ error: 'validation', message: 'name is required' });
      }

      const project = await prisma.project.create({
        data: { name, description, customerId, sourceLanguage, targetLanguage },
      });

      return reply.status(201).send({ data: project });
    }
  );

  app.post<{ Params: { id: string } }>('/:id/xliff', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) {
      return reply.status(404).send({ error: 'not_found', message: 'Project not found' });
    }

    const data = await req.file();
    if (!data) {
      return reply.status(400).send({ error: 'validation', message: 'No file uploaded' });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk as Buffer);
    }
    const xmlContent = Buffer.concat(chunks).toString('utf-8');

    let parsed;
    try {
      parsed = parseXliff(xmlContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: 'parse_error', message });
    }

    // Create the XLIFF file record first
    const xliffFile = await prisma.xliffFile.create({
      data: {
        projectId: project.id,
        filename: data.filename,
        originalXml: xmlContent,
        sourceLanguage: parsed.sourceLanguage,
        targetLanguage: parsed.targetLanguage,
      },
    });

    // Batch inserts in chunks of 500 to avoid SQLite limits with large files
    const CHUNK = 500;
    const rows = parsed.units.map((unit) => ({
      xliffFileId: xliffFile.id,
      projectId: project.id,
      unitId: unit.id,
      source: unit.source,
      target: unit.target ?? '',
      state: unit.state,
      note: unit.note,
      developerNote: unit.developerNote,
    }));
    for (let i = 0; i < rows.length; i += CHUNK) {
      await prisma.translation.createMany({ data: rows.slice(i, i + CHUNK) });
    }

    const stats = getXliffStats(parsed.units);
    return reply.status(201).send({ data: { xliffFile, stats } });
  });

  app.get<{ Params: { id: string; fileId: string } }>('/:id/xliff/:fileId/stats', async (req, reply) => {
    const translations = await prisma.translation.findMany({
      where: { xliffFileId: req.params.fileId },
      select: { state: true, target: true },
    });

    if (!translations.length) {
      return reply.status(404).send({ error: 'not_found', message: 'File not found' });
    }

    const total = translations.length;
    const translated = translations.filter((t) => ['translated', 'final', 'signed-off'].includes(t.state)).length;
    const needsTranslation = translations.filter(
      (t) => ['new', 'needs-translation'].includes(t.state) || !t.target
    ).length;
    const needsReview = translations.filter((t) => t.state === 'needs-review-translation').length;

    return {
      data: {
        total,
        translated,
        needsTranslation,
        needsReview,
        progress: total > 0 ? Math.round((translated / total) * 100) : 0,
      },
    };
  });

  app.get<{ Params: { id: string; fileId: string } }>('/:id/xliff/:fileId/download', async (req, reply) => {
    const file = await prisma.xliffFile.findUnique({ where: { id: req.params.fileId } });
    if (!file) {
      return reply.status(404).send({ error: 'not_found', message: 'File not found' });
    }

    const translations = await prisma.translation.findMany({ where: { xliffFileId: file.id } });
    const updates = new Map(
      translations.map((translation) => [
        translation.unitId,
        { target: translation.target, state: translation.state as TranslationState },
      ])
    );

    const xml = serializeXliff(file.originalXml, updates);

    reply.header('Content-Type', 'application/xml; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${file.filename}"`);
    return reply.send(xml);
  });

  app.delete<{ Params: { id: string; fileId: string } }>('/:id/xliff/:fileId', async (req, reply) => {
    await prisma.translation.deleteMany({ where: { xliffFileId: req.params.fileId } });
    await prisma.xliffFile.delete({ where: { id: req.params.fileId } });
    return reply.status(204).send();
  });

  // Update remote source info on a file
  app.patch<{
    Params: { id: string; fileId: string };
    Body: { remoteConnectionId?: string; remotePath?: string; remoteBranch?: string; remoteRepo?: string };
  }>('/:id/xliff/:fileId/remote', async (req, reply) => {
    const file = await prisma.xliffFile.update({
      where: { id: req.params.fileId },
      data: {
        remoteConnectionId: req.body.remoteConnectionId,
        remotePath: req.body.remotePath,
        remoteBranch: req.body.remoteBranch,
        remoteRepo: req.body.remoteRepo,
      },
    });
    return { data: file };
  });

  // Get the serialized XLIFF content for a file (for committing back to remote)
  app.get<{ Params: { id: string; fileId: string } }>('/:id/xliff/:fileId/content', async (req, reply) => {
    const file = await prisma.xliffFile.findUnique({ where: { id: req.params.fileId } });
    if (!file) {
      return reply.status(404).send({ error: 'not_found', message: 'File not found' });
    }

    const translations = await prisma.translation.findMany({ where: { xliffFileId: file.id } });
    const updates = new Map(
      translations.map((translation) => [
        translation.unitId,
        { target: translation.target, state: translation.state as TranslationState },
      ])
    );

    const xml = serializeXliff(file.originalXml, updates);
    return { data: { content: xml, filename: file.filename } };
  });

  // ─── Update project ──────────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; customerId?: string | null; sourceLanguage?: string; targetLanguage?: string };
  }>('/:id', async (req, reply) => {
    const existing = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Project not found' });
    }

    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: req.body,
      include: { customer: { select: { id: true, name: true } } },
    });
    return { data: project };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    await prisma.project.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });
}
