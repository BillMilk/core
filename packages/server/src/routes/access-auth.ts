import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { ServiceError } from '../errors.js';
import { AccessAuthService } from '../services/access-auth.service.js';

const loginSchema = z.object({
  password: z.string().min(1),
});

const updateSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().optional(),
});

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof ZodError) {
    reply.code(400);
    return {
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: error.errors,
    };
  }

  if (error instanceof ServiceError) {
    reply.code(error.statusCode);
    return {
      error: error.message,
      code: error.code,
    };
  }

  reply.log.error(error);
  reply.code(500);
  return {
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  };
}

function clearAccessAuthCookies(request: FastifyRequest, reply: FastifyReply) {
  const options = AccessAuthService.getClearCookieOptions(request);
  reply.clearCookie(AccessAuthService.cookieName, options);
  reply.clearCookie(AccessAuthService.legacyCookieName, options);
}

export async function accessAuthRoutes(app: FastifyInstance) {
  app.get('/access-auth/status', async (request, reply) => {
    const cookie = AccessAuthService.extractCookieFromHeaderWithSource(request.headers.cookie);
    const status = await AccessAuthService.getPublicStatus(cookie.token);
    const browserSessionValid = !status.enabled
      && await AccessAuthService.validateBrowserSessionToken(cookie.token);

    if (
      cookie.source === 'legacy'
      && cookie.token
      && (status.enabled ? status.authenticated : browserSessionValid)
    ) {
      reply.setCookie(
        AccessAuthService.cookieName,
        cookie.token,
        AccessAuthService.getCookieOptions(request),
      );
    } else if (!status.enabled && !browserSessionValid) {
      reply.setCookie(
        AccessAuthService.cookieName,
        await AccessAuthService.createBrowserSessionToken(),
        AccessAuthService.getCookieOptions(request),
      );
    }

    return status;
  });

  app.post('/access-auth/login', async (request, reply) => {
    try {
      const { password } = loginSchema.parse(request.body);
      const result = await AccessAuthService.login(password, request.ip);
      if (result.sessionToken) {
        reply.setCookie(
          AccessAuthService.cookieName,
          result.sessionToken,
          AccessAuthService.getCookieOptions(request),
        );
      }
      return result.status;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post('/access-auth/logout', async (request, reply) => {
    clearAccessAuthCookies(request, reply);
    const enabled = await AccessAuthService.isEnabled();
    return {
      enabled,
      authenticated: !enabled,
    };
  });

  app.get('/access-auth/settings', async (_request, reply) => {
    try {
      return await AccessAuthService.getSettings();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put('/access-auth/settings', async (request, reply) => {
    try {
      const data = updateSettingsSchema.parse(request.body);
      const result = await AccessAuthService.updateSettings(data);
      if (result.clearSession) {
        clearAccessAuthCookies(request, reply);
      } else if (result.sessionToken) {
        reply.setCookie(
          AccessAuthService.cookieName,
          result.sessionToken,
          AccessAuthService.getCookieOptions(request),
        );
      }
      return result.settings;
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
