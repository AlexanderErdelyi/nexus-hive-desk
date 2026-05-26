import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'fs';
import nodePath from 'path';
import { prisma } from '@nexus/db';
import { getXliffStats, parseXliff, serializeXliff } from '@nexus/xliff';
import type { TranslationState } from '@nexus/types';
import { requireAuth } from '../lib/auth';

export async function projectRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));
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
            lastSyncAt: true,
            remoteObjectId: true,
            sourceLanguage: true,
            targetLanguage: true,
            remoteConnectionId: true,
            remotePath: true,
            remoteBranch: true,
            remoteRepo: true,
            remotePrId: true,
            remotePrUrl: true,
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

  app.post<{ Body: { name: string; description?: string; customerId?: string; sourceLanguage?: string; targetLanguage?: string; capabilities?: string } }>(
    '/',
    async (req, reply) => {
      const { name, description, customerId, sourceLanguage, targetLanguage, capabilities = 'translation' } = req.body;
      if (!name) {
        return reply.status(400).send({ error: 'validation', message: 'name is required' });
      }

      const project = await prisma.project.create({
        data: { name, description, customerId, sourceLanguage, targetLanguage, capabilities },
      });

      // Auto-assign creator as project admin
      await prisma.projectMember.create({
        data: { userId: req.user.sub, projectId: project.id, role: 'admin' },
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
        sourceLanguage: parsed.sourceLanguage || project.sourceLanguage || 'en',
        targetLanguage: parsed.targetLanguage || project.targetLanguage || 'en',
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
    Body: { remoteConnectionId?: string; remotePath?: string; remoteBranch?: string; remoteRepo?: string; remotePrId?: string | null; remotePrUrl?: string | null };
  }>('/:id/xliff/:fileId/remote', async (req, reply) => {
    const file = await prisma.xliffFile.update({
      where: { id: req.params.fileId },
      data: {
        remoteConnectionId: req.body.remoteConnectionId,
        remotePath: req.body.remotePath,
        remoteBranch: req.body.remoteBranch,
        remoteRepo: req.body.remoteRepo,
        ...(req.body.remotePrId !== undefined ? { remotePrId: req.body.remotePrId } : {}),
        ...(req.body.remotePrUrl !== undefined ? { remotePrUrl: req.body.remotePrUrl } : {}),
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
    let fetchedObjectId: string | undefined;
    const repoParts = file.remoteRepo.split('/');
    try {
      if (conn.type === 'azure-devops') {
        // repoKey format: "domain/org/project/repo" (4 parts) or "org/project/repo" (3 parts, legacy)
        // Always use last two parts as adoProject and repoName
        const adoProject = repoParts[repoParts.length - 2];
        const repoName = repoParts[repoParts.length - 1];
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const authHeader = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

        // Step 1: get item metadata (JSON) to retrieve the blob objectId
        const metaUrl = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items?path=${encodeURIComponent(file.remotePath)}&versionDescriptor.version=${encodeURIComponent(file.remoteBranch)}&versionDescriptor.versionType=branch&includeContent=false&api-version=7.1`;
        const metaRes = await fetch(metaUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
        if (!metaRes.ok) throw new Error(`ADO metadata HTTP ${metaRes.status}: ${await metaRes.text().catch(() => metaRes.statusText)}`);
        const meta = await metaRes.json() as { objectId?: string };
        if (!meta.objectId) throw new Error('ADO did not return objectId for file');
        fetchedObjectId = meta.objectId;

        // Step 2: download blob by objectId — no size limit, always returns raw bytes
        const blobUrl = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/blobs/${meta.objectId}?download=true&api-version=7.1`;
        const blobRes = await fetch(blobUrl, { headers: { Authorization: authHeader } });
        if (!blobRes.ok) throw new Error(`ADO blob HTTP ${blobRes.status}: ${await blobRes.text().catch(() => blobRes.statusText)}`);
        remoteXml = await blobRes.text();
      } else {
        const [owner, repoName] = repoParts;
        // Step 1: get JSON metadata to retrieve the file SHA (for staleness checks)
        const metaUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${file.remotePath}?ref=${encodeURIComponent(file.remoteBranch)}`;
        const metaRes = await fetch(metaUrl, {
          headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' },
        });
        if (!metaRes.ok) throw new Error(`GitHub metadata HTTP ${metaRes.status}: ${await metaRes.text().catch(() => metaRes.statusText)}`);
        const metaJson = await metaRes.json() as { sha?: string; download_url?: string };
        if (metaJson.sha) fetchedObjectId = metaJson.sha;

        // Step 2: download raw content
        const downloadUrl = metaJson.download_url ?? metaUrl;
        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
        });
        if (!res.ok) throw new Error(`GitHub download HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
        remoteXml = await res.text();
      }
      // Strip UTF-8 BOM (\uFEFF) — ADO / some editors add it; fast-xml-parser chokes on it
      remoteXml = remoteXml.replace(/^\uFEFF/, '');
      // Guard: content must look like XML, not an HTML error page
      const firstNonWs = remoteXml.trimStart();
      if (!firstNonWs.startsWith('<')) {
        throw new Error(`Remote content is not XML (first chars: ${JSON.stringify(firstNonWs.substring(0, 80))})`);
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
      return reply.status(400).send({ error: 'parse_error', message: `XML parse failed: ${message}` });
    }

    // Merge: update originalXml + lastSyncAt, upsert units
    const syncNow = new Date();
    await prisma.xliffFile.update({
      where: { id: file.id },
      data: {
        originalXml: remoteXml,
        lastSyncAt: syncNow,
        ...(fetchedObjectId ? { remoteObjectId: fetchedObjectId } : {}),
        // Refresh language metadata from the XLIFF header if present
        ...(parsed.sourceLanguage ? { sourceLanguage: parsed.sourceLanguage } : {}),
        ...(parsed.targetLanguage ? { targetLanguage: parsed.targetLanguage } : {}),
      },
    });

    const existing = await prisma.translation.findMany({ where: { xliffFileId: file.id } });
    const existingMap = new Map(existing.map((t) => [t.unitId, t]));
    const remoteIds = new Set(parsed.units.map((u) => u.id));

    // ── Batch inserts for new units (createMany in chunks to stay under SQLite variable limit) ──
    const newUnits = parsed.units.filter((u) => !existingMap.has(u.id));
    const CHUNK = 80;
    for (let i = 0; i < newUnits.length; i += CHUNK) {
      await prisma.translation.createMany({
        data: newUnits.slice(i, i + CHUNK).map((unit) => ({
          xliffFileId: file.id,
          projectId: req.params.id,
          unitId: unit.id,
          source: unit.source,
          target: unit.target ?? '',
          state: unit.state,
          note: unit.note ?? null,
          developerNote: unit.developerNote ?? null,
          syncChangedAt: syncNow,
          syncChangeType: 'added',
        })),
        // Note: skipDuplicates not supported by SQLite; newUnits is already deduplicated above
      });
    }
    const added = newUnits.length;

    // ── Batch updates for source-changed units ──
    const sourceChangedUnits = parsed.units.filter((u) => {
      const local = existingMap.get(u.id);
      return local && local.source !== u.source;
    });
    if (sourceChangedUnits.length > 0) {
      await prisma.$transaction(
        sourceChangedUnits.map((unit) => {
          const local = existingMap.get(unit.id)!;
          return prisma.translation.update({
            where: { id: local.id },
            data: {
              source: unit.source,
              note: unit.note ?? null,
              developerNote: unit.developerNote ?? null,
              syncChangedAt: syncNow,
              syncChangeType: 'source-changed',
            },
          });
        })
      );
    }
    const updated = sourceChangedUnits.length;

    // ── Batch updates for removed units ──
    const removed = existing.filter((t) => !remoteIds.has(t.unitId));
    if (removed.length > 0) {
      await prisma.$transaction(
        removed.map((t) =>
          prisma.translation.update({
            where: { id: t.id },
            data: { state: 'needs-review', syncChangedAt: syncNow, syncChangeType: 'removed' },
          })
        )
      );
    }

    return { data: { added, updated, obsolete: removed.length, total: parsed.units.length, syncAt: syncNow.toISOString() } };
  });

  // POST /:id/xliff-files/check-staleness — lightweight metadata check for each remote-connected file
  app.post<{ Params: { id: string } }>('/:id/xliff-files/check-staleness', async (req) => {
    const files = await prisma.xliffFile.findMany({
      where: { projectId: req.params.id, remoteConnectionId: { not: null }, remotePath: { not: null }, remoteBranch: { not: null }, remoteRepo: { not: null } },
      select: { id: true, remoteConnectionId: true, remotePath: true, remoteBranch: true, remoteRepo: true, remoteObjectId: true },
    });

    const results = await Promise.allSettled(
      files.map(async (file) => {
        if (!file.remoteConnectionId || !file.remotePath || !file.remoteBranch || !file.remoteRepo) return null;
        const conn = await prisma.customerConnection.findUnique({ where: { id: file.remoteConnectionId }, select: { type: true, baseUrl: true, pat: true } });
        if (!conn) return null;

        const repoParts = file.remoteRepo.split('/');
        let currentObjectId: string | null = null;

        try {
          if (conn.type === 'azure-devops') {
            const adoProject = repoParts[repoParts.length - 2];
            const repoName = repoParts[repoParts.length - 1];
            const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
            const authHeader = `Basic ${Buffer.from(`:${conn.pat}`).toString('base64')}`;
            const metaUrl = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items?path=${encodeURIComponent(file.remotePath)}&versionDescriptor.version=${encodeURIComponent(file.remoteBranch)}&versionDescriptor.versionType=branch&includeContent=false&api-version=7.1`;
            const res = await fetch(metaUrl, { headers: { Authorization: authHeader, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (res.ok) {
              const data = await res.json() as { objectId?: string };
              currentObjectId = data.objectId ?? null;
            }
          } else {
            const [owner, repoName] = repoParts;
            const metaUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${file.remotePath}?ref=${encodeURIComponent(file.remoteBranch)}`;
            const res = await fetch(metaUrl, { headers: { Authorization: `Bearer ${conn.pat}`, Accept: 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(8000) });
            if (res.ok) {
              const data = await res.json() as { sha?: string };
              currentObjectId = data.sha ?? null;
            }
          }
        } catch { /* network failure — skip */ }

        return {
          fileId: file.id,
          currentObjectId,
          storedObjectId: file.remoteObjectId,
          isStale: currentObjectId !== null && file.remoteObjectId !== null && currentObjectId !== file.remoteObjectId,
          neverSynced: file.remoteObjectId === null && currentObjectId !== null,
        };
      })
    );

    return {
      data: results
        .filter((r): r is PromiseFulfilledResult<NonNullable<typeof r extends PromiseFulfilledResult<infer V> ? V : never>> => r.status === 'fulfilled' && r.value !== null)
        .map((r) => r.value),
    };
  });

  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; customerId?: string | null; sourceLanguage?: string | null; targetLanguage?: string | null; connectionId?: string | null; adoProjectName?: string | null; adoRepoName?: string | null; defaultBranch?: string | null; capabilities?: string; localWorkspacePath?: string | null };
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

  // ─── VS Code navigation links ──────────────────────────────────────────────
  // Reads local files on the server (which runs on the dev's machine) to find
  // the exact line of a translation unit or its AL source declaration, then
  // returns a vscode://file/... deep-link URL.
  //
  // Query params:
  //   type        'xliff' | 'source'
  //   xliffFileId  required for both types
  //   unitId       required for 'xliff' type (searches for trans-unit)
  //   note         required for 'source' type (BC Xliff note, e.g. "Table 18 - Field No. - Property Caption")
  app.get<{
    Params: { id: string };
    Querystring: { type: 'xliff' | 'source'; xliffFileId: string; unitId?: string; note?: string };
  }>('/:id/vscode-link', async (req, reply) => {
    const { type, xliffFileId, unitId, note } = req.query;

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { localWorkspacePath: true },
    });
    if (!project?.localWorkspacePath) {
      return reply.status(400).send({ error: 'no_workspace', message: 'No local workspace path configured. Set it in Project Setup.' });
    }
    const workspacePath = project.localWorkspacePath.replace(/[\\/]+$/, ''); // strip trailing slashes

    const xliffFile = await prisma.xliffFile.findUnique({
      where: { id: xliffFileId },
      select: { remotePath: true },
    });

    /** Convert an absolute filesystem path to a vscode://file/ URL.
     *  Windows: C:\foo\bar  → vscode://file/C:/foo/bar
     *  Unix:    /foo/bar    → vscode://file//foo/bar  (note the double slash)
     */
    function toVsCodeUrl(absPath: string, line?: number): string {
      const normalized = absPath.replace(/\\/g, '/');
      const encoded = normalized.split('/').map(encodeURIComponent).join('/');
      const base = `vscode://file/${encoded}`;
      return line != null ? `${base}:${line}` : base;
    }

    /** Find a string in a text and return its 1-based line number, or undefined. */
    function findLine(text: string, searchStr: string): number | undefined {
      const lines = text.split('\n');
      const idx = lines.findIndex((l) => l.includes(searchStr));
      return idx >= 0 ? idx + 1 : undefined;
    }

    // ── XLIFF file navigation ─────────────────────────────────────────────
    if (type === 'xliff') {
      if (!unitId) return reply.status(400).send({ error: 'validation', message: 'unitId is required for type=xliff' });
      if (!xliffFile?.remotePath) {
        return reply.status(400).send({ error: 'no_remote_path', message: 'This XLIFF file has no remote path configured.' });
      }
      const absPath = nodePath.join(workspacePath, xliffFile.remotePath);
      let line: number | undefined;
      try {
        const content = await fs.readFile(absPath, 'utf8');
        // Search for the trans-unit id — escape the unitId to avoid regex issues
        line = findLine(content, `id="${unitId.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}"`);
      } catch {
        // file not found locally — still return the URL without a line number
      }
      return { url: toVsCodeUrl(absPath, line) };
    }

    // ── AL source file navigation ─────────────────────────────────────────
    if (type === 'source') {
      if (!note) return reply.status(400).send({ error: 'validation', message: 'note is required for type=source' });

      // Parse note: "{ObjectType} {ObjectName} - [{MemberType} {MemberName} -] Property {PropName}"
      const BC_OBJECT_TYPES = [
        'Table', 'TableExtension', 'Page', 'PageExtension', 'PageCustomization',
        'Codeunit', 'Report', 'ReportExtension', 'XMLPort', 'Query', 'Enum',
        'EnumExtension', 'Profile', 'Interface', 'PermissionSet',
      ];
      const parts = note.split(' - ');
      const firstSpaceIdx = parts[0].indexOf(' ');
      const objectType = firstSpaceIdx >= 0 ? parts[0].substring(0, firstSpaceIdx) : '';
      const objectName = firstSpaceIdx >= 0 ? parts[0].substring(firstSpaceIdx + 1) : '';
      if (!BC_OBJECT_TYPES.includes(objectType) || !objectName) {
        return reply.status(400).send({ error: 'parse_error', message: 'Could not parse object type/name from note' });
      }

      // Property text we'll search for within the found file
      const lastPart = parts[parts.length - 1];
      const lastSpaceIdx = lastPart.indexOf(' ');
      const propertyValue = lastSpaceIdx >= 0 ? lastPart.substring(lastSpaceIdx + 1) : lastPart;

      // Walk the workspace recursively, looking for a .al file that declares this object
      async function findAlFiles(dir: string): Promise<string[]> {
        const result: string[] = [];
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch { return result; }
        for (const e of entries) {
          const full = nodePath.join(dir, e.name);
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
            result.push(...await findAlFiles(full));
          } else if (e.isFile() && e.name.endsWith('.al')) {
            result.push(full);
          }
        }
        return result;
      }

      const alFiles = await findAlFiles(workspacePath);
      const AL_OBJECT_RE = /^(tableextension|table|pagecustomization|pageextension|page|codeunit|reportextension|report|xmlport|query|enumextension|enum|profile|interface|permissionset)\s+\d+\s+["']?([^"'{\n]+?)["']?\s*[{(]/im;

      let foundPath: string | undefined;
      let foundLine: number | undefined;

      for (const filePath of alFiles) {
        let content: string;
        try { content = await fs.readFile(filePath, 'utf8'); }
        catch { continue; }
        const m = AL_OBJECT_RE.exec(content);
        if (!m) continue;
        const declaredName = m[2].trim().replace(/^["']|["']$/g, '');
        if (declaredName.toLowerCase() !== objectName.toLowerCase()) continue;

        foundPath = filePath;
        // Try to find the property source value
        if (propertyValue) {
          const l = findLine(content, propertyValue);
          if (l) foundLine = l;
        }
        break;
      }

      if (!foundPath) {
        // Fallback: just open the workspace folder
        return { url: toVsCodeUrl(workspacePath), hint: `No AL file found for ${objectType} "${objectName}"` };
      }

      return { url: toVsCodeUrl(foundPath, foundLine) };
    }

    return reply.status(400).send({ error: 'validation', message: 'type must be xliff or source' });
  });
  // Aggregates translations by AL object (parsed from the `note` field which
  // follows the BC Xliff Generator format:
  //   "{ObjectType} {ObjectName} - [Member -] Property PropertyName"
  // Returns per-object coverage stats useful for the AL Analyser view.
  app.get<{
    Params: { id: string };
    Querystring: { xliffFileId?: string };
  }>('/:id/al-coverage', async (req, reply) => {
    const { id: projectId } = req.params;
    const { xliffFileId } = req.query;

    const BC_OBJECT_TYPES = [
      'Table', 'TableExtension', 'Page', 'PageExtension', 'PageCustomization',
      'Codeunit', 'Report', 'ReportExtension', 'XMLPort', 'Query', 'Enum',
      'EnumExtension', 'Profile', 'Interface', 'PermissionSet',
    ];

    const whereClause = xliffFileId ? { projectId, xliffFileId } : { projectId };
    const translations = await prisma.translation.findMany({
      where: whereClause,
      select: { id: true, state: true, target: true, note: true },
    });

    if (!translations.length) {
      return { data: { objects: [], summary: { totalObjects: 0, totalStrings: 0, translated: 0, untranslated: 0, coveragePct: 0 } } };
    }

    // Parse note → {objectType, objectName}
    type ObjectKey = string; // "{ObjectType}|{ObjectName}"
    type ObjectStats = {
      objectType: string;
      objectName: string;
      total: number;
      translated: number;
      needsReview: number;
      untranslated: number;
    };

    const objectMap = new Map<ObjectKey, ObjectStats>();

    for (const t of translations) {
      const note = t.note ?? '';
      const spaceIdx = note.indexOf(' ');
      if (spaceIdx === -1) continue;

      const objectType = note.substring(0, spaceIdx);
      if (!BC_OBJECT_TYPES.includes(objectType)) continue;

      // objectName is the part between first space and first ' - '
      const dashIdx = note.indexOf(' - ');
      const objectName = dashIdx !== -1 ? note.substring(spaceIdx + 1, dashIdx) : note.substring(spaceIdx + 1);
      if (!objectName) continue;

      const key: ObjectKey = `${objectType}|${objectName}`;
      let stats = objectMap.get(key);
      if (!stats) {
        stats = { objectType, objectName, total: 0, translated: 0, needsReview: 0, untranslated: 0 };
        objectMap.set(key, stats);
      }

      stats.total++;
      const isTranslated = ['translated', 'final', 'signed-off'].includes(t.state);
      const isReview = t.state === 'needs-review-translation';
      const isUntranslated = ['new', 'needs-translation'].includes(t.state) || !t.target;

      if (isTranslated) stats.translated++;
      else if (isReview) stats.needsReview++;
      else if (isUntranslated) stats.untranslated++;
      else stats.translated++; // catch-all for other states
    }

    // Convert to array, add coveragePct, sort by coveragePct asc (worst first)
    const objects = Array.from(objectMap.values())
      .map((o) => ({
        ...o,
        coveragePct: o.total > 0 ? Math.round((o.translated / o.total) * 100) : 0,
      }))
      .sort((a, b) => a.coveragePct - b.coveragePct || a.objectType.localeCompare(b.objectType) || a.objectName.localeCompare(b.objectName));

    const totalStrings = translations.length;
    const totalTranslated = translations.filter((t) => ['translated', 'final', 'signed-off'].includes(t.state)).length;
    const totalUntranslated = translations.filter((t) => ['new', 'needs-translation'].includes(t.state) || !t.target).length;

    return {
      data: {
        objects,
        summary: {
          totalObjects: objects.length,
          totalStrings,
          translated: totalTranslated,
          untranslated: totalUntranslated,
          coveragePct: totalStrings > 0 ? Math.round((totalTranslated / totalStrings) * 100) : 0,
        },
      },
    };
  });

  // ─── Compare two XLIFF files ─────────────────────────────────────────────────
  // Diffs the translations of two loaded XLIFF files (by unitId) and returns
  // rows categorised as: added | removed | changed | unchanged.
  // Query params: fileA (base), fileB (compare-to / "theirs")
  app.get<{
    Params: { id: string };
    Querystring: {
      fileA: string;
      fileB: string;
      changeType?: string; // 'added' | 'removed' | 'changed' | 'unchanged'
      search?: string;
      page?: string;
      pageSize?: string;
    };
  }>('/:id/xliff/compare', async (req, reply) => {
    const { fileA, fileB, changeType, search, page = '1', pageSize = '50' } = req.query;
    if (!fileA || !fileB) {
      return reply.status(400).send({ error: 'validation', message: 'fileA and fileB query params are required' });
    }

    const pageNum = Math.max(1, Number(page));
    const pageSizeNum = Math.min(200, Math.max(1, Number(pageSize)));

    // Load both translation sets in parallel
    const [aRows, bRows] = await Promise.all([
      prisma.translation.findMany({
        where: { xliffFileId: fileA },
        select: { unitId: true, source: true, target: true, state: true, note: true },
      }),
      prisma.translation.findMany({
        where: { xliffFileId: fileB },
        select: { unitId: true, source: true, target: true, state: true, note: true },
      }),
    ]);

    const aMap = new Map(aRows.map((r) => [r.unitId, r]));
    const bMap = new Map(bRows.map((r) => [r.unitId, r]));
    const allIds = new Set([...aMap.keys(), ...bMap.keys()]);

    type DiffRow = {
      unitId: string;
      changeType: 'added' | 'removed' | 'changed' | 'unchanged';
      source: string;
      targetA: string;
      targetB: string;
      stateA: string;
      stateB: string;
      note?: string | null;
    };

    const rows: DiffRow[] = [];
    for (const id of allIds) {
      const a = aMap.get(id);
      const b = bMap.get(id);
      let ct: DiffRow['changeType'];
      if (!a) ct = 'added';
      else if (!b) ct = 'removed';
      else if (a.target !== b.target || a.source !== b.source) ct = 'changed';
      else ct = 'unchanged';

      rows.push({
        unitId: id,
        changeType: ct,
        source: b?.source ?? a?.source ?? '',
        targetA: a?.target ?? '',
        targetB: b?.target ?? '',
        stateA: a?.state ?? '',
        stateB: b?.state ?? '',
        note: b?.note ?? a?.note,
      });
    }

    // Filter
    let filtered = rows;
    if (changeType && changeType !== 'all') {
      filtered = filtered.filter((r) => r.changeType === changeType);
    }
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.unitId.toLowerCase().includes(q) ||
          r.source.toLowerCase().includes(q) ||
          r.targetA.toLowerCase().includes(q) ||
          r.targetB.toLowerCase().includes(q)
      );
    }

    const summary = {
      added: rows.filter((r) => r.changeType === 'added').length,
      removed: rows.filter((r) => r.changeType === 'removed').length,
      changed: rows.filter((r) => r.changeType === 'changed').length,
      unchanged: rows.filter((r) => r.changeType === 'unchanged').length,
      total: rows.length,
    };

    const total = filtered.length;
    const skip = (pageNum - 1) * pageSizeNum;
    const data = filtered.slice(skip, skip + pageSizeNum);

    return {
      data,
      summary,
      meta: { total, page: pageNum, pageSize: pageSizeNum, totalPages: Math.ceil(total / pageSizeNum) },
    };
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
        const url = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items?scopePath=${encodeURIComponent(path)}&recursionLevel=OneLevel&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=7.1`;
        const res = await fetch(url, {
          headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => res.statusText);
            throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
          }
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
      if (!res.ok) {
        const body = await res.text().catch(() => res.statusText);
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
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

  // ─── Pull Requests ───────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/:id/pull-requests', async (req, reply) => {
    const repos = await prisma.projectRepository.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });

    if (repos.length === 0) {
      return { data: [] };
    }

    interface PullRequest {
      id: string;
      title: string;
      author: string;
      status: string;
      sourceBranch: string;
      targetBranch: string;
      reviewers: Array<{ name: string; vote: number }>;
      createdAt: string;
      url: string;
      repoLabel: string;
      provider: 'github' | 'azure-devops';
      // metadata needed for action endpoints
      connectionId: string;
      adoProjectName?: string;
      repoSlug: string;
    }

    interface RepoError {
      repoLabel: string;
      error: string;
    }

    const pullRequests: PullRequest[] = [];
    const errors: RepoError[] = [];

    await Promise.all(
      repos.map(async (repo) => {
        const repoLabel = repo.label ?? repo.repoName;
        try {
          const conn = await prisma.customerConnection.findUnique({ where: { id: repo.connectionId } });
          if (!conn) {
            errors.push({ repoLabel, error: 'Connection not found' });
            return;
          }

          const pat = conn.pat;

          if (conn.type === 'azure-devops') {
            const adoProject = repo.adoProjectName ?? repo.repoName.split('/').slice(-2, -1)[0];
            const repoName = repo.repoName.split('/').pop() ?? repo.repoName;
            const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
            const url = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/pullrequests?searchCriteria.status=active&$top=100&api-version=7.1`;
            const res = await fetch(url, {
              headers: {
                Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
                'Content-Type': 'application/json',
              },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
            const data = await res.json() as {
              value?: Array<{
                pullRequestId: number;
                title: string;
                createdBy?: { displayName?: string };
                status: string;
                sourceRefName: string;
                targetRefName: string;
                reviewers?: Array<{ displayName?: string; vote?: number }>;
                creationDate: string;
                _links?: { web?: { href?: string } };
                remoteUrl?: string;
              }>;
            };
            for (const pr of data.value ?? []) {
              pullRequests.push({
                id: String(pr.pullRequestId),
                title: pr.title,
                author: pr.createdBy?.displayName ?? 'Unknown',
                status: pr.status,
                sourceBranch: pr.sourceRefName.replace('refs/heads/', ''),
                targetBranch: pr.targetRefName.replace('refs/heads/', ''),
                reviewers: (pr.reviewers ?? [])
                  .filter((r) => r.displayName)
                  .map((r) => ({ name: r.displayName!, vote: r.vote ?? 0 })),
                createdAt: pr.creationDate,
                url: pr._links?.web?.href ?? '',
                repoLabel,
                provider: 'azure-devops',
                connectionId: conn.id,
                adoProjectName: adoProject,
                repoSlug: repoName,
              });
            }
          } else {
            // GitHub
            const parts = repo.repoName.split('/');
            const [owner, repoSlug] = parts.length >= 2 ? [parts[0], parts[1]] : [parts[0], parts[0]];
            const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoSlug)}/pulls?state=open&per_page=100`;
            const res = await fetch(url, {
              headers: {
                Authorization: `Bearer ${pat}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
            const data = await res.json() as Array<{
              number: number;
              title: string;
              user?: { login?: string };
              state: string;
              head?: { ref?: string };
              base?: { ref?: string };
              requested_reviewers?: Array<{ login?: string }>;
              created_at: string;
              html_url: string;
            }>;
            for (const pr of Array.isArray(data) ? data : []) {
              pullRequests.push({
                id: String(pr.number),
                title: pr.title,
                author: pr.user?.login ?? 'Unknown',
                status: pr.state,
                sourceBranch: pr.head?.ref ?? '',
                targetBranch: pr.base?.ref ?? '',
                reviewers: (pr.requested_reviewers ?? [])
                  .filter((r) => r.login)
                  .map((r) => ({ name: r.login!, vote: 0 })),
                createdAt: pr.created_at,
                url: pr.html_url,
                repoLabel,
                provider: 'github',
                connectionId: conn.id,
                repoSlug: `${owner}/${repoSlug}`,
              });
            }
          }
        } catch (err) {
          errors.push({ repoLabel, error: err instanceof Error ? err.message : 'Unknown error' });
        }
      })
    );

    pullRequests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Deduplicate by PR id (same repo added multiple times produces duplicates)
    const seen = new Set<string>();
    const unique = pullRequests.filter((pr) => {
      const key = `${pr.provider}:${pr.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { data: unique, errors: errors.length > 0 ? errors : undefined };
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
