import fp from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";

/**
 * Plugin de Plataforma para Injeção de Contexto e Correlation ID
 * 
 * - Garante rastreabilidade distribuída de ponta a ponta (Tracing).
 * - Extrai ou gera um x-request-id padronizado (UUID v4).
 * - Reflete o x-request-id em todos os cabeçalhos de resposta.
 * - Disponibiliza request.correlationId para uso nos logs e proxies.
 */
export const requestContextPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.decorateRequest("correlationId", "");

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Reutiliza x-request-id existente ou gera um novo UUID v4
    const existingReqId = request.headers["x-request-id"];
    const correlationId = typeof existingReqId === "string" && existingReqId.trim().length > 0
      ? existingReqId.trim()
      : crypto.randomUUID();

    request.correlationId = correlationId;

    // Propaga de volta no cabeçalho de resposta do cliente
    reply.header("x-request-id", correlationId);
  });
});
