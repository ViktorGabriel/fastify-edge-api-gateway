import fp from "fastify-plugin";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RedisRateLimiterService } from "../services/redis-rate-limiter.service.js";
import { RateLimitConfig, RouteProxyDefinition } from "../types/index.js";
import type { Redis as RedisClient } from "ioredis";

export interface RateLimiterPluginOptions {
  customRedis?: RedisClient;
  keyPrefix?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    rateLimiterService: RedisRateLimiterService;
    applyRateLimit: (
      request: FastifyRequest,
      reply: FastifyReply,
      route: RouteProxyDefinition
    ) => Promise<boolean>;
  }
}

/**
 * Plugin de Rate Limiting com Sliding Window Atômico via Redis e Lua
 * 
 * - Garante atomicidade em ambientes distribuídos através de scripts Lua diretamente no Redis.
 * - Suporta rate limits configuráveis por rota e granularidade por IP, User ID ou híbrido.
 * - Injeta cabeçalhos RFC (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After).
 * - Interrompe requisições excedentes com HTTP 429 Too Many Requests antes de atingir os microsserviços.
 */
export const rateLimiterPlugin = fp(async (fastify: FastifyInstance, opts: RateLimiterPluginOptions) => {
  const service = new RedisRateLimiterService(opts.customRedis, opts.keyPrefix);

  // Conecta ao Redis se necessário
  try {
    await service.connect();
  } catch (err) {
    fastify.log.warn({
      msg: "Não foi possível conectar ao Redis durante a inicialização do Rate Limiter. Operando em modo tolerante a falhas.",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  fastify.decorate("rateLimiterService", service);

  fastify.decorate(
    "applyRateLimit",
    async function (
      request: FastifyRequest,
      reply: FastifyReply,
      route: RouteProxyDefinition
    ): Promise<boolean> {
      const config: RateLimitConfig | undefined = route.rateLimit;
      if (!config) {
        return true; // Rota sem política de rate limit prossegue normalmente
      }

      // 1. Extração da Chave Baseada na Estratégia Configurada
      const strategy = config.keyStrategy || "user-or-ip";
      let clientIdentifier: string;

      const authenticatedUserId = request.user?.sub || request.user?.userId || request.user?.id;
      const clientIp = request.ip || "unknown-ip";

      switch (strategy) {
        case "user":
          clientIdentifier = authenticatedUserId ? `user:${authenticatedUserId}` : `ip:${clientIp}`;
          break;
        case "ip":
          clientIdentifier = `ip:${clientIp}`;
          break;
        case "user-or-ip":
        default:
          clientIdentifier = authenticatedUserId ? `user:${authenticatedUserId}` : `ip:${clientIp}`;
          break;
      }

      // Chave isolada por rota e identificador do cliente
      const rateLimitKey = `${route.id}:${clientIdentifier}`;

      // 2. Executa a Barreira de Limite Atômica no Redis via Lua
      const result = await service.consume(
        rateLimitKey,
        config.limit,
        config.windowMs,
        request.correlationId
      );

      // 3. Injeta Cabeçalhos RFC de Rate Limiting
      reply.header("X-RateLimit-Limit", String(result.limit));
      reply.header("X-RateLimit-Remaining", String(result.remaining));
      reply.header("X-RateLimit-Reset", String(result.resetAfter));

      // 4. Se o Limite for Excedido, Interrompe com HTTP 429
      if (!result.allowed) {
        reply.header("Retry-After", String(result.retryAfter));

        request.log.warn({
          msg: "Rate Limit excedido no API Gateway",
          routeId: route.id,
          client: clientIdentifier,
          limit: result.limit,
          retryAfter: result.retryAfter,
          correlationId: request.correlationId,
        });

        reply.status(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: `Limite de requisições excedido. Tente novamente em ${result.retryAfter} segundos.`,
          retryAfter: result.retryAfter,
          requestId: request.correlationId,
          timestamp: new Date().toISOString(),
        });

        return false;
      }

      return true;
    }
  );

  fastify.addHook("onClose", async () => {
    await service.disconnect();
  });
});
