import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';

export async function customerRoutes(app: FastifyInstance) {
  // ─── List customers ─────────────────────────────────────────────────────────
  app.get('/', async () => {
    const customers = await prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { connections: true, projects: true } } },
    });
    return { data: customers };
  });

  // ─── Get customer with connections ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        connections: {
          select: {
            id: true,
            type: true,
            name: true,
            baseUrl: true,
            createdAt: true,
            updatedAt: true,
            customerId: true,
          },
        },
        projects: {
          select: { id: true, name: true, sourceLanguage: true, targetLanguage: true },
        },
        _count: { select: { connections: true, projects: true } },
      },
    });

    if (!customer) {
      return reply.status(404).send({ error: 'not_found', message: 'Customer not found' });
    }

    return { data: customer };
  });

  // ─── Create customer ───────────────────────────────────────────────────────
  app.post<{ Body: { name: string; description?: string } }>('/', async (req, reply) => {
    const { name, description } = req.body;
    if (!name) {
      return reply.status(400).send({ error: 'validation', message: 'name is required' });
    }

    const customer = await prisma.customer.create({ data: { name, description } });
    return reply.status(201).send({ data: customer });
  });

  // ─── Update customer ───────────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    '/:id',
    async (req, reply) => {
      const customer = await prisma.customer.update({
        where: { id: req.params.id },
        data: req.body,
      });
      return { data: customer };
    }
  );

  // ─── Delete customer ───────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    await prisma.customer.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  // ─── Add connection ────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { type: string; name: string; baseUrl?: string; pat: string };
  }>('/:id/connections', async (req, reply) => {
    const { type, name, baseUrl, pat } = req.body;

    if (!type || !name || !pat) {
      return reply
        .status(400)
        .send({ error: 'validation', message: 'type, name, and pat are required' });
    }

    if (type !== 'azure-devops' && type !== 'github') {
      return reply
        .status(400)
        .send({ error: 'validation', message: 'type must be azure-devops or github' });
    }

    const connection = await prisma.customerConnection.create({
      data: { customerId: req.params.id, type, name, baseUrl, pat },
    });

    // Return without the PAT for security
    const { pat: _pat, ...safe } = connection;
    return reply.status(201).send({ data: safe });
  });

  // ─── Update connection ─────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string; connId: string };
    Body: { name?: string; baseUrl?: string; pat?: string };
  }>('/:id/connections/:connId', async (req, reply) => {
    const connection = await prisma.customerConnection.update({
      where: { id: req.params.connId },
      data: req.body,
    });

    const { pat: _pat, ...safe } = connection;
    return { data: safe };
  });

  // ─── Delete connection ─────────────────────────────────────────────────────
  app.delete<{ Params: { id: string; connId: string } }>(
    '/:id/connections/:connId',
    async (req, reply) => {
      await prisma.customerConnection.delete({ where: { id: req.params.connId } });
      return reply.status(204).send();
    }
  );

  // ─── Test connection ───────────────────────────────────────────────────────
  app.post<{ Params: { id: string; connId: string } }>(
    '/:id/connections/:connId/test',
    async (req, reply) => {
      const conn = await prisma.customerConnection.findUnique({
        where: { id: req.params.connId },
      });

      if (!conn) {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        if (conn.type === 'azure-devops') {
          const url = conn.baseUrl
            ? `${conn.baseUrl.replace(/\/$/, '')}/_apis/projects?api-version=7.1`
            : 'https://dev.azure.com/_apis/connectionData?api-version=7.1';

          const res = await fetch(url, {
            headers: {
              Authorization: `Basic ${Buffer.from(`:${conn.pat}`).toString('base64')}`,
            },
          });

          if (!res.ok) {
            return reply.status(400).send({
              error: 'connection_failed',
              message: `Azure DevOps returned ${res.status}: ${res.statusText}`,
            });
          }
        } else {
          const res = await fetch('https://api.github.com/user', {
            headers: {
              Authorization: `Bearer ${conn.pat}`,
              Accept: 'application/vnd.github+json',
            },
          });

          if (!res.ok) {
            return reply.status(400).send({
              error: 'connection_failed',
              message: `GitHub returned ${res.status}: ${res.statusText}`,
            });
          }
        }

        return { data: { status: 'ok', message: 'Connection successful' } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(400).send({ error: 'connection_failed', message });
      }
    }
  );
}
