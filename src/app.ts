import Fastify, { FastifyError, FastifyInstance, FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import { requestContextPlugin } from "./plugins/request-context.plugin.js";
import { authPlugin } from "./plugins/auth.plugin.js";
import { proxyRouterPlugin } from "./plugins/proxy-router.plugin.js";
import { healthPlugin } from "./plugins/health.plugin.js";
import { routesConfig } from "./config/routes.config.js";
import { env } from "./config/env.js";

export interface BuildAppOptions {
  customRoutes?: typeof routesConfig;
  fastifyOptions?: FastifyServerOptions;
}

/**
 * Application Factory para o API Gateway Fastify
 * Permite instanciar o servidor com facilidade para testes unitários, de integração e produção.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const isDev = env.NODE_ENV === "development";

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
    requestIdHeader: "x-request-id",
    ...options.fastifyOptions,
  });

  // 1. Plugins de Segurança e Utilitários HTTP de Borda
  await app.register(helmet, {
    contentSecurityPolicy: false, // Deixa flexível para proxies de API
  });
  await app.register(cors, {
    origin: true,
    credentials: true,
    exposedHeaders: ["x-request-id"],
  });
  await app.register(sensible);

  // 2. Plugin de Contexto & Tracing (x-request-id)
  await app.register(requestContextPlugin);

  // 3. Plugin de Autenticação JWT
  await app.register(authPlugin);

  // 4. Probes de Infraestrutura & Health Check
  await app.register(healthPlugin);

  // 5. Roteador Declarativo de Proxy (@fastify/http-proxy)
  const activeRoutes = options.customRoutes || routesConfig;
  await app.register(proxyRouterPlugin, {
    routes: activeRoutes,
  });

  // 6. Manipulador Global de Erros Estruturados
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({
      err: error,
      correlationId: request.correlationId,
      url: request.raw.url,
      method: request.raw.method,
    });

    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;

    return reply.status(statusCode).send({
      statusCode,
      error: error.name || "InternalServerError",
      message: error.message || "Ocorreu um erro interno no API Gateway",
      requestId: request.correlationId,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
