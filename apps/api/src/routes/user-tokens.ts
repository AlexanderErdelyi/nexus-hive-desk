import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { requireAuth } from '../lib/auth';
import { encryptToken, decryptToken, maskToken } from '../lib/crypto';

const ALLOWED_AZDO_HOSTS = new Set(['dev.azure.com']);
const ALLOWED_AZDO_SUFFIXES = ['.visualstudio.com'];

/**
 * Parse and sanitize an Azure DevOps base URL.
 * Returns a safe, reconstructed URL string or null if invalid.
 */
function sanitizeAzureDevOpsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    const isAllowed =
      ALLOWED_AZDO_HOSTS.has(host) ||
      ALLOWED_AZDO_SUFFIXES.some((suffix) => host.endsWith(suffix));
    if (!isAllowed) return null;
    // Reconstruct URL from validated components – no user-controlled opaque string
    const safePath = parsed.pathname.replace(/\/+$/, '');
    return `https://${host}${safePath}`;
  } catch {
    return null;
  }
}

export async function userTokenRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('onRequest', requireAuth(app));

  // ─── List current user's tokens (masked) ────────────────────────────────────
  app.get('/', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const tokens = await prisma.userToken.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: 'desc' },
    });

    const masked = tokens.map((t) => {
      const plain = decryptToken(t.encryptedToken, t.tokenIv, t.tokenTag);
      return {
        id: t.id,
        provider: t.provider,
        scopeType: t.scopeType,
        scopeId: t.scopeId,
        label: t.label,
        baseUrl: t.baseUrl,
        maskedToken: maskToken(plain),
        expiresAt: t.expiresAt,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    });

    return { data: masked };
  });

  // ─── Create / save a new token ──────────────────────────────────────────────
  app.post<{
    Body: {
      provider: string;
      scopeType?: string;
      scopeId?: string;
      token: string;
      label: string;
      baseUrl?: string;
      expiresAt?: string;
    };
  }>('/', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { provider, scopeType = 'global', scopeId, token, label, baseUrl, expiresAt } = req.body;

    if (!provider || !token || !label) {
      return reply
        .status(400)
        .send({ error: 'validation', message: 'provider, token, and label are required' });
    }

    if (provider !== 'github' && provider !== 'azuredevops') {
      return reply
        .status(400)
        .send({ error: 'validation', message: 'provider must be github or azuredevops' });
    }

    if (!['global', 'customer', 'project'].includes(scopeType)) {
      return reply
        .status(400)
        .send({ error: 'validation', message: 'scopeType must be global, customer, or project' });
    }

    if (scopeType !== 'global' && !scopeId) {
      return reply
        .status(400)
        .send({ error: 'validation', message: 'scopeId is required for customer/project scoped tokens' });
    }

    // Validate token against provider
    try {
      if (provider === 'github') {
        const res = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
          },
        });
        if (!res.ok) {
          return reply.status(400).send({
            error: 'validation',
            message: `GitHub token validation failed (${res.status}: ${res.statusText})`,
          });
        }
      } else {
        let azdoValidationUrl: string;
        if (baseUrl) {
          const sanitized = sanitizeAzureDevOpsUrl(baseUrl);
          if (!sanitized) {
            return reply.status(400).send({
              error: 'validation',
              message: 'baseUrl must be a valid Azure DevOps URL (https://dev.azure.com/... or https://*.visualstudio.com/...)',
            });
          }
          azdoValidationUrl = `${sanitized}/_apis/projects?api-version=7.1`;
        } else {
          azdoValidationUrl = 'https://dev.azure.com/_apis/connectionData?api-version=7.1';
        }
        const res = await fetch(azdoValidationUrl, {
          headers: {
            Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
          },
        });
        if (!res.ok) {
          return reply.status(400).send({
            error: 'validation',
            message: `Azure DevOps token validation failed (${res.status}: ${res.statusText})`,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(400).send({ error: 'validation', message: `Token validation failed: ${message}` });
    }

    const { encrypted, iv, tag } = encryptToken(token);

    const userToken = await prisma.userToken.create({
      data: {
        userId: req.user.sub,
        provider,
        scopeType,
        scopeId: scopeType === 'global' ? null : scopeId,
        encryptedToken: encrypted,
        tokenIv: iv,
        tokenTag: tag,
        label,
        baseUrl: provider === 'azuredevops' && baseUrl ? sanitizeAzureDevOpsUrl(baseUrl) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    return reply.status(201).send({
      data: {
        id: userToken.id,
        provider: userToken.provider,
        scopeType: userToken.scopeType,
        scopeId: userToken.scopeId,
        label: userToken.label,
        baseUrl: userToken.baseUrl,
        maskedToken: maskToken(token),
        expiresAt: userToken.expiresAt,
        createdAt: userToken.createdAt,
        updatedAt: userToken.updatedAt,
      },
    });
  });

  // ─── Update label / expiry ──────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { label?: string; expiresAt?: string | null };
  }>('/:id', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    // Ensure token belongs to current user
    const existing = await prisma.userToken.findFirst({
      where: { id: req.params.id, userId: req.user.sub },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Token not found' });
    }

    const updateData: { label?: string; expiresAt?: Date | null } = {};
    if (req.body.label !== undefined) updateData.label = req.body.label;
    if (req.body.expiresAt !== undefined) {
      updateData.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
    }

    const updated = await prisma.userToken.update({
      where: { id: req.params.id },
      data: updateData,
    });

    const plain = decryptToken(updated.encryptedToken, updated.tokenIv, updated.tokenTag);

    return {
      data: {
        id: updated.id,
        provider: updated.provider,
        scopeType: updated.scopeType,
        scopeId: updated.scopeId,
        label: updated.label,
        baseUrl: updated.baseUrl,
        maskedToken: maskToken(plain),
        expiresAt: updated.expiresAt,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    };
  });

  // ─── Delete token ───────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    // Ensure token belongs to current user
    const existing = await prisma.userToken.findFirst({
      where: { id: req.params.id, userId: req.user.sub },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Token not found' });
    }

    await prisma.userToken.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });
}
