import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { routesConfig } from "../config/routes.config.js";

/**
 * Plugin de Health Check e Metadados do Gateway
 * 
 * Fornece probes para Kubernetes / ECS / Docker Swarm e endpoints de diagnóstico
 */
export const healthPlugin = fp(async (fastify: FastifyInstance) => {
  // Liveness Probe
  fastify.get("/health/live", async (_req, reply) => {
    return reply.status(200).send({
      status: "UP",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  // Readiness Probe
  fastify.get("/health/ready", async (_req, reply) => {
    return reply.status(200).send({
      status: "READY",
      timestamp: new Date().toISOString(),
      registeredRoutesCount: routesConfig.length,
      memoryUsageBytes: process.memoryUsage(),
    });
  });

  // Diagnóstico de Rotas Declarativas do Gateway
  fastify.get("/gateway/routes", async (_req, reply) => {
    return reply.status(200).send({
      gateway: "Fastify Edge API Gateway",
      version: "1.0.0",
      totalRoutes: routesConfig.length,
      routes: routesConfig.map((r) => ({
        id: r.id,
        prefix: r.prefix,
        upstream: r.upstream,
        rewritePrefix: r.rewritePrefix,
        authRequired: r.authRequired,
        allowedMethods: r.allowedMethods,
        description: r.description,
        tags: r.tags,
      })),
    });
  });

  // Root endpoint informativo
  fastify.get("/", async (_req, reply) => {
    return reply.status(200).send({
      name: "Fastify Edge API Gateway",
      version: "1.0.0",
      status: "running",
      endpoints: {
        liveness: "/health/live",
        readiness: "/health/ready",
        routesCatalog: "/gateway/routes",
      },
    });
  });
});
