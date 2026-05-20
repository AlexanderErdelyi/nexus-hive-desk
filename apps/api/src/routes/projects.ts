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
        repositories: { orderBy: { createdAt: 'asc' } },
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

  // ─── Sync file from remote ───────────────────────────────────────────────────
  // Fetches the latest XLIFF from the remote repo and merges it:
  // - Updates source text for existing units (preserves local target/state)
  // - Adds new units found in remote
  // - Marks units no longer in remote as 'obsolete' (does not delete them)
  app.post<{ Params: { id: string; fileId: string } }>('/:id/xliff/:fileId/sync-from-remote', async (req, reply) => {
    const file = await prisma.xliffFile.findUnique({ where: { id: req.params.fileId } });
    if (!file) return reply.status(404).send({ error: 'not_found', message: 'File not found' });
    if (!file.remoteConnectionId || !file.remotePath || !file.remoteBranch || !file.remoteRepo) {
      return reply.status(400).send({ error: 'no_remote', message: 'File has no remote configuration' });
    }

    const conn = await prisma.customerConnection.findUnique({ where: { id: file.remoteConnectionId } });
    if (!conn) return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });

    // CustomerConnection stores PAT as plain text
    const pat = conn.pat;

    // Fetch remote content
    let remoteXml: string;
    const repoParts = file.remoteRepo.split('/');
    try {
      if (conn.type === 'azure-devops') {
        // repoKey format: "domain/org/project/repo" (4 parts) or "org/project/repo" (3 parts, legacy)
        // Always use last two parts as adoProject and repoName
        const adoProject = repoParts[repoParts.length - 2];
        const repoName = repoParts[repoParts.length - 1];
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const encodedPath = encodeURIComponent(file.remotePath);
        const url = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items?path=${encodedPath}&versionDescriptor.version=${encodeURIComponent(file.remoteBranch)}&versionDescriptor.versionType=branch&$format=text&api-version=7.1`;
        const res = await fetch(url, {
          headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
        remoteXml = await res.text();
      } else {
        const [owner, repoName] = repoParts;
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${file.remotePath}?ref=${encodeURIComponent(file.remoteBranch)}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
        remoteXml = await res.text();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({ error: 'remote_error', message });
    }

    // Parse remote XLIFF
    let parsed;
    try {
      parsed = parseXliff(remoteXml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: 'parse_error', message });
    }

    // Merge: update originalXml, upsert units
    await prisma.xliffFile.update({
      where: { id: file.id },
      data: { originalXml: remoteXml },
    });

    const existing = await prisma.translation.findMany({ where: { xliffFileId: file.id } });
    const existingMap = new Map(existing.map((t) => [t.unitId, t]));
    const remoteIds = new Set(parsed.units.map((u) => u.id));

    let added = 0;
    let updated = 0;

    for (const unit of parsed.units) {
      const local = existingMap.get(unit.id);
      if (!local) {
        await prisma.translation.create({
          data: {
            xliffFileId: file.id,
            projectId: req.params.id,
            unitId: unit.id,
            source: unit.source,
            target: unit.target ?? '',
            state: unit.state,
            note: unit.note,
            developerNote: unit.developerNote,
          },
        });
        added++;
      } else if (local.source !== unit.source) {
        await prisma.translation.update({
          where: { id: local.id },
          data: { source: unit.source, note: unit.note, developerNote: unit.developerNote },
        });
        updated++;
      }
    }

    // Mark removed units
    const removed = existing.filter((t) => !remoteIds.has(t.unitId));
    for (const t of removed) {
      await prisma.translation.update({ where: { id: t.id }, data: { state: 'needs-review' } });
    }

    return { data: { added, updated, obsolete: removed.length, total: parsed.units.length } };
  });
  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; customerId?: string | null; sourceLanguage?: string; targetLanguage?: string; connectionId?: string | null; adoProjectName?: string | null; adoRepoName?: string | null; defaultBranch?: string | null };
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

  // ─── Project Repositories ────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/:id/repositories', async (req, reply) => {
    const repos = await prisma.projectRepository.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });
    return { data: repos };
  });

  app.post<{
    Params: { id: string };
    Body: { label?: string; connectionId: string; adoProjectName?: string; repoName: string; defaultBranch?: string };
  }>('/:id/repositories', async (req, reply) => {
    const { label, connectionId, adoProjectName, repoName, defaultBranch } = req.body;
    if (!connectionId || !repoName) {
      return reply.status(400).send({ error: 'validation', message: 'connectionId and repoName are required' });
    }
    const repo = await prisma.projectRepository.create({
      data: { projectId: req.params.id, label, connectionId, adoProjectName, repoName, defaultBranch },
    });
    return reply.status(201).send({ data: repo });
  });

  app.patch<{
    Params: { id: string; repoId: string };
    Body: { label?: string; connectionId?: string; adoProjectName?: string | null; repoName?: string; defaultBranch?: string | null };
  }>('/:id/repositories/:repoId', async (req, reply) => {
    const repo = await prisma.projectRepository.update({
      where: { id: req.params.repoId },
      data: req.body,
    });
    return { data: repo };
  });

  app.delete<{ Params: { id: string; repoId: string } }>('/:id/repositories/:repoId', async (req, reply) => {
    await prisma.projectRepository.delete({ where: { id: req.params.repoId } });
    return reply.status(204).send();
  });

  // GET /:id/repositories/:repoId/tree?path=&branch=
  app.get<{
    Params: { id: string; repoId: string };
    Querystring: { path?: string; branch?: string };
  }>('/:id/repositories/:repoId/tree', async (req, reply) => {
    const repo = await prisma.projectRepository.findUnique({ where: { id: req.params.repoId } });
    if (!repo) return reply.status(404).send({ error: 'not_found' });

    const conn = await prisma.customerConnection.findUnique({ where: { id: repo.connectionId } });
    if (!conn) return reply.status(404).send({ error: 'connection_not_found' });

    const path = req.query.path || '/';
    const branch = req.query.branch || repo.defaultBranch || 'main';
    const pat = conn.pat;

    try {
      if (conn.type === 'azure-devops') {
        const adoProject = repo.adoProjectName || repo.repoName.split('/').slice(-2, -1)[0];
        const repoName = repo.repoName.split('/').pop() || repo.repoName;
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const url = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items?path=${encodeURIComponent(path)}&recursionLevel=oneLevel&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=7.1`;
        const res = await fetch(url, {
          headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { value?: Array<{ path: string; isFolder?: boolean; gitObjectType?: string }> };
        const items = (data.value ?? []).map((item) => ({
          name: item.path.split('/').pop() || item.path,
          path: item.path,
          type: (item.isFolder || item.gitObjectType === 'tree') ? 'tree' : 'blob',
        }));
        return { data: items };
      }

      const parts = repo.repoName.split('/');
      const [owner, repoSlug] = parts.length >= 2 ? [parts[0], parts[1]] : [parts[0], parts[0]];
      const cleanPath = path.replace(/^\//, '');
      const url = `https://api.github.com/repos/${owner}/${repoSlug}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as Array<{ name: string; path: string; type: string }>;
      const items = Array.isArray(data)
        ? data.map((item) => ({ name: item.name, path: item.path, type: item.type === 'dir' ? 'tree' : 'blob' }))
        : [];
      return { data: items };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({ error: 'remote_error', message });
    }
  });

  // ─── ADO Access Config ───────────────────────────────────────────────────────

  app.patch<{
    Params: { id: string };
    Body: { connectionId?: string | null; adoProjectName?: string | null; adoAccessScope?: string };
  }>('/:id/ado-access', async (req, reply) => {
    const { connectionId, adoProjectName, adoAccessScope } = req.body;
    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: {
        ...(connectionId !== undefined && { connectionId }),
        ...(adoProjectName !== undefined && { adoProjectName }),
        ...(adoAccessScope !== undefined && { adoAccessScope }),
      },
    });
    return { data: project };
  });
}
