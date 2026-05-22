import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { executeAgentRun } from '../lib/agent-engine';
import { fetchModelStream } from '../lib/stream-ai.js';
import { requireAuth } from '../lib/auth';

function stripMCPCredentials(agent: any) {
  if (!agent?.mcpConnections) return agent;
  return {
    ...agent,
    mcpConnections: agent.mcpConnections.map((ac: any) => {
      if (!ac?.mcpConnection) return ac;
      const { encryptedCredential, credentialIv, credentialTag, ...safeMcp } = ac.mcpConnection;
      return { ...ac, mcpConnection: safeMcp };
    }),
  };
}

export async function agentRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));
  // ─── List agents ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { customerId?: string; projectId?: string } }>(
    '/',
    async (req) => {
      const { customerId, projectId } = req.query;
      const where: Record<string, string> = {};
      if (customerId) where.customerId = customerId;
      if (projectId) where.projectId = projectId;

      const agents = await prisma.agent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          skills: { include: { skill: true } },
          mcpConnections: {
            include: {
              mcpConnection: { select: { id: true, name: true, type: true } },
            },
          },
          _count: { select: { runs: true } },
        },
      });

      return { data: agents.map(stripMCPCredentials) };
    }
  );

  // ─── Get agent ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const agent = await prisma.agent.findUnique({
      where: { id: req.params.id },
      include: {
        skills: { include: { skill: true } },
        mcpConnections: {
          include: {
            mcpConnection: { select: { id: true, name: true, type: true } },
          },
        },
        _count: { select: { runs: true } },
      },
    });

    if (!agent) {
      return reply.status(404).send({ error: 'not_found', message: 'Agent not found' });
    }

    return { data: stripMCPCredentials(agent) };
  });

  // ─── Create agent ─────────────────────────────────────────────────────────
  app.post<{
    Body: {
      name: string;
      description?: string;
      customerId?: string;
      projectId?: string;
      modelProvider?: string;
      model?: string;
      systemPrompt?: string;
      triggerType?: string;
      tools?: string | string[];
      argumentHint?: string;
      skillIds?: string[];
      mcpConnectionIds?: string[];
    };
  }>('/', async (req, reply) => {
    const { name, description, customerId, projectId, modelProvider, model, systemPrompt, triggerType, tools, argumentHint, skillIds, mcpConnectionIds } = req.body;

    if (!name) {
      return reply.status(400).send({ error: 'validation', message: 'name is required' });
    }

    // Normalize tools to JSON string
    const toolsJson = tools
      ? (Array.isArray(tools) ? JSON.stringify(tools) : tools)
      : undefined;

    const agent = await prisma.agent.create({
      data: {
        name,
        description,
        customerId,
        projectId,
        modelProvider,
        model,
        systemPrompt,
        triggerType,
        tools: toolsJson,
        argumentHint,
        skills: skillIds?.length
          ? { create: skillIds.map((skillId) => ({ skillId })) }
          : undefined,
        mcpConnections: mcpConnectionIds?.length
          ? { create: mcpConnectionIds.map((mcpConnectionId) => ({ mcpConnectionId })) }
          : undefined,
      },
      include: {
        skills: { include: { skill: true } },
        mcpConnections: { include: { mcpConnection: true } },
        _count: { select: { runs: true } },
      },
    });

    return reply.status(201).send({ data: stripMCPCredentials(agent) });
  });

  // ─── Update agent ─────────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      customerId?: string;
      projectId?: string;
      modelProvider?: string;
      model?: string;
      systemPrompt?: string;
      triggerType?: string;
      tools?: string | string[];
      argumentHint?: string;
      skillIds?: string[];
      mcpConnectionIds?: string[];
    };
  }>('/:id', async (req, reply) => {
    const { skillIds, mcpConnectionIds, tools, ...rest } = req.body;

    // Normalize tools to JSON string
    const data = {
      ...rest,
      ...(tools !== undefined
        ? { tools: Array.isArray(tools) ? JSON.stringify(tools) : tools }
        : {}),
    };

    const agent = await prisma.$transaction(async (tx) => {
      if (skillIds) {
        await tx.agentSkill.deleteMany({ where: { agentId: req.params.id } });
        if (skillIds.length) {
          await tx.agentSkill.createMany({
            data: skillIds.map((skillId) => ({ agentId: req.params.id, skillId })),
          });
        }
      }

      if (mcpConnectionIds) {
        await tx.agentMCPConnection.deleteMany({ where: { agentId: req.params.id } });
        if (mcpConnectionIds.length) {
          await tx.agentMCPConnection.createMany({
            data: mcpConnectionIds.map((mcpConnectionId) => ({ agentId: req.params.id, mcpConnectionId })),
          });
        }
      }

      return tx.agent.update({
        where: { id: req.params.id },
        data,
        include: {
          skills: { include: { skill: true } },
          mcpConnections: { include: { mcpConnection: true } },
          _count: { select: { runs: true } },
        },
      });
    });

    return { data: stripMCPCredentials(agent) };
  });

  // ─── Delete agent ─────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    await prisma.agent.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  // ─── Trigger agent run ────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { input?: Record<string, unknown> } }>(
    '/:id/run',
    async (req, reply) => {
      const agent = await prisma.agent.findUnique({ where: { id: req.params.id } });

      if (!agent) {
        return reply.status(404).send({ error: 'not_found', message: 'Agent not found' });
      }

      const now = new Date();
      const run = await prisma.agentRun.create({
        data: {
          agentId: req.params.id,
          status: 'pending',
          input: req.body.input ? JSON.stringify(req.body.input) : null,
          startedAt: now,
        },
      });

      // Fire-and-forget: execute in background so we don't block the HTTP response
      const inputData = req.body.input ?? {};
      void executeAgentRun(agent.id, run.id, inputData);

      return reply.status(201).send({ data: run });
    }
  );

  // ─── Get agent run history ────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/:id/runs',
    async (req) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 100);

      const runs = await prisma.agentRun.findMany({
        where: { agentId: req.params.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      return { data: runs };
    }
  );

  // ─── Test-run agent (SSE chat stream) ────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; model?: string };
  }>('/:id/test-stream', async (req, reply) => {
    const agent = await prisma.agent.findUnique({
      where: { id: req.params.id },
      include: { skills: { include: { skill: true } } },
    });
    if (!agent) return reply.status(404).send({ error: 'not_found', message: 'Agent not found' });

    const { messages: history, model: modelOverride } = req.body;
    if (!Array.isArray(history) || history.length === 0) {
      return reply.status(400).send({ error: 'validation', message: 'messages array is required' });
    }

    const token = process.env.GITHUB_TOKEN ?? '';
    const model = modelOverride || agent.model || process.env.AI_MODEL || 'gpt-4o-mini';

    // Build system message: agent system prompt + injected skills context
    const skillsContext = (agent.skills ?? [])
      .filter((s) => s.skill.promptTemplate)
      .map((s) => `### Skill: ${s.skill.name}\n${s.skill.promptTemplate}`)
      .join('\n\n');

    const systemContent = [
      agent.systemPrompt?.trim() || `You are a helpful AI assistant called "${agent.name}".`,
      skillsContext ? `\n\n--- Attached Skills ---\n${skillsContext}` : '',
    ].join('');

    const messages = [
      { role: 'system' as const, content: systemContent },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      let charCount = 0;
      await fetchModelStream(token, model, messages, (chunk) => {
        charCount += chunk.length;
        send('token', { chunk });
      });
      send('done', { estimatedTokens: Math.ceil(charCount / 4) });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : 'Stream failed' });
    } finally {
      reply.raw.end();
    }
  });
}
