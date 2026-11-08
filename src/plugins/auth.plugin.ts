import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { env } from "../config/env.js";
import { JwtUserPayload } from "../types/index.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    tryExtractUser: (request: FastifyRequest) => Promise<void>;
  }
}

/**
 * Plugin de Autenticação JWT de Borda
 * 
 * - Valida a integridade, assinatura e expiração de tokens JWT no cabeçalho Authorization.
 * - Suporta verificação estrita (authenticate) para rotas protegidas.
 * - Suporta extração tolerante (tryExtractUser) para rotas públicas com enriquecimento opcional.
 * - Evita header spoofing garantindo que apenas claims validados do token definam request.user.
 */
export const authPlugin = fp(async (fastify: FastifyInstance) => {
  await fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    verify: {
      extractToken: (request: FastifyRequest) => {
        const authHeader = request.headers.authorization;
        if (!authHeader) return undefined;

        const [scheme, token] = authHeader.split(" ");
        if (scheme?.toLowerCase() !== "bearer" || !token) {
          return undefined;
        }
        return token;
      },
    },
  });

  // Decorador para rotas que exigem obrigatoriamente autenticação (authRequired: true)
  fastify.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const authHeader = request.headers.authorization;

      if (!authHeader) {
        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Cabeçalho 'Authorization' ausente. Forneça um token no formato 'Bearer <token>'",
          requestId: request.correlationId,
          timestamp: new Date().toISOString(),
        });
      }

      const parts = authHeader.split(" ");
      if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Formato de autorização inválido. Utilize o esquema 'Bearer <token>'",
          requestId: request.correlationId,
          timestamp: new Date().toISOString(),
        });
      }

      try {
        const decoded = await request.jwtVerify<JwtUserPayload>();
        request.user = decoded;
      } catch (err: unknown) {
        request.log.warn({
          msg: "Falha na validação de token JWT no API Gateway",
          correlationId: request.correlationId,
          error: err instanceof Error ? err.message : String(err),
        });

        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Token JWT inválido, corrompido ou expirado",
          requestId: request.correlationId,
          timestamp: new Date().toISOString(),
        });
      }
    }
  );

  // Decorador para extração opcional em rotas públicas (se o cliente enviar, decodifica)
  fastify.decorate(
    "tryExtractUser",
    async function (request: FastifyRequest): Promise<void> {
      const authHeader = request.headers.authorization;
      if (!authHeader) return;

      const parts = authHeader.split(" ");
      if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
        try {
          const decoded = await request.jwtVerify<JwtUserPayload>();
          request.user = decoded;
        } catch {
          // Em rotas públicas, falha no token opcional é tolerada sem bloquear a requisição
        }
      }
    }
  );
});
