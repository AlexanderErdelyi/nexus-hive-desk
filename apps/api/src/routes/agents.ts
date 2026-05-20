import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';

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
          mcpConnections: { include: { mcpConnection: true } },
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
        mcpConnections: { include: { mcpConnection: true } },
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
      systemPrompt?: string;
      triggerType?: string;
      skillIds?: string[];
      mcpConnectionIds?: string[];
    };
  }>('/', async (req, reply) => {
    const { name, description, customerId, projectId, modelProvider, systemPrompt, triggerType, skillIds, mcpConnectionIds } = req.body;

    if (!name) {
      return reply.status(400).send({ error: 'validation', message: 'name is required' });
    }

    const agent = await prisma.agent.create({
      data: {
        name,
        description,
        customerId,
        projectId,
        modelProvider,
        systemPrompt,
        triggerType,
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
      systemPrompt?: string;
      triggerType?: string;
      skillIds?: string[];
      mcpConnectionIds?: string[];
    };
  }>('/:id', async (req, reply) => {
    const { skillIds, mcpConnectionIds, ...data } = req.body;

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

      const completedRun = await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'completed', endedAt: new Date() },
      });

      return reply.status(201).send({ data: completedRun });
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
}
