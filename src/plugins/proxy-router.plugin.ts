import fp from "fastify-plugin";
import fastifyHttpProxy from "@fastify/http-proxy";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RouteProxyDefinition } from "../types/index.js";
import { env } from "../config/env.js";

export interface ProxyRouterOptions {
  routes: RouteProxyDefinition[];
}

/**
 * Plugin de Roteamento Declarativo & Reverse Proxying
 * 
 * Itera sobre o catálogo central routes.config.ts e registra proxies individuais
 * de alta performance via @fastify/http-proxy:
 * 1. Intercepta a rota baseada no 'prefix'.
 * 2. Valida o token JWT no 'preHandler' caso 'authRequired' seja verdadeiro.
 * 3. Previne Header Spoofing deletando headers internos vindos do cliente externo.
 * 4. Enriquece os headers com 'x-request-id', 'x-user-id' e metadados de observabilidade.
 * 5. Faz stream da requisição e resposta diretamente com o serviço Upstream.
 */
export const proxyRouterPlugin = fp(async (fastify: FastifyInstance, opts: ProxyRouterOptions) => {
  const routes = opts.routes || [];

  for (const route of routes) {
    // Encapsula cada registro de proxy em um escopo filho para isolamento total
    await fastify.register(async (scope) => {
      scope.register(fastifyHttpProxy, {
        upstream: route.upstream,
        prefix: route.prefix,
        rewritePrefix: route.rewritePrefix ?? "",
        http2: false,
        preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
          // 1. Validação de Método HTTP (se especificado na rota declarativa)
          if (route.allowedMethods && route.allowedMethods.length > 0) {
            const method = request.method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
            if (!route.allowedMethods.includes(method)) {
              return reply.status(405).send({
                statusCode: 405,
                error: "Method Not Allowed",
                message: `Método ${method} não é permitido para esta rota. Métodos aceitos: ${route.allowedMethods.join(", ")}`,
                requestId: request.correlationId,
              });
            }
          }

          // 2. Interceptação e Autenticação de Token JWT
          if (route.authRequired) {
            await fastify.authenticate(request, reply);
          } else {
            // Em rota pública, tenta extrair caso o cliente envie o token
            await fastify.tryExtractUser(request);
          }
        },
        replyOptions: {
          rewriteRequestHeaders: (originalReq, headers) => {
            const forwardedHeaders: Record<string, string | string[] | undefined> = { ...headers };

            // ========================================================
            // SEGURANÇA: PREVENÇÃO DE HEADER SPOOFING
            // Remove quaisquer headers de identidade forjados pelo cliente externo
            // ========================================================
            delete forwardedHeaders["x-user-id"];
            delete forwardedHeaders["x-user-role"];
            delete forwardedHeaders["x-user-email"];

            // ========================================================
            // ENRIQUECIMENTO DE CONTEXTO: CORRELATION ID
            // ========================================================
            forwardedHeaders["x-request-id"] = originalReq.correlationId;

            // ========================================================
            // ENRIQUECIMENTO DE CONTEXTO: IDENTIDADE AUTENTICADA (x-user-id)
            // ========================================================
            const user = originalReq.user;
            if (user?.sub || user?.id || user?.userId) {
              const userId = String(user.sub || user.userId || user.id);
              forwardedHeaders["x-user-id"] = userId;

              if (user.role) forwardedHeaders["x-user-role"] = String(user.role);
              if (user.email) forwardedHeaders["x-user-email"] = String(user.email);
            }

            // Metadados de Borda e Auditoria
            forwardedHeaders["x-forwarded-by"] = "fastify-api-gateway";
            forwardedHeaders["x-gateway-route-id"] = route.id;
            forwardedHeaders["x-gateway-timestamp"] = new Date().toISOString();

            return forwardedHeaders;
          },
          onError: (reply, { error }) => {
            const req = reply.request;
            req.log.error({
              msg: "Falha de comunicação com Upstream no API Gateway",
              routeId: route.id,
              upstream: route.upstream,
              correlationId: req.correlationId,
              error: error.message,
            });

            reply.status(502).send({
              statusCode: 502,
              error: "Bad Gateway",
              message: `Não foi possível conectar ao serviço upstream [${route.id}]`,
              upstream: route.upstream,
              requestId: req.correlationId,
              timestamp: new Date().toISOString(),
            });
          },
        },
      });
    });

    fastify.log.info(
      `[Gateway Route Registered] ${route.prefix} -> ${route.upstream}${route.rewritePrefix ?? ""} (Auth: ${route.authRequired})`
    );
  }
});
