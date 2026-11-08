import fp from "fastify-plugin";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CircuitBreakerRegistry, CircuitBreaker } from "../services/circuit-breaker.js";
import { RouteProxyDefinition } from "../types/index.js";

declare module "fastify" {
  interface FastifyInstance {
    circuitBreakers: CircuitBreakerRegistry;
    applyCircuitBreaker: (
      request: FastifyRequest,
      reply: FastifyReply,
      route: RouteProxyDefinition
    ) => Promise<boolean>;
    recordCircuitBreakerResult: (
      route: RouteProxyDefinition,
      statusCode: number,
      isNetworkError?: boolean
    ) => void;
  }
}

/**
 * Plugin de Circuit Breaker para Resiliência de Microsserviços Upstream
 * 
 * - Monitora o volume de falhas 5xx e erros de conectividade de rede por rota/upstream.
 * - Quando as falhas atingem o threshold (ex: 5 falhas em 10s), abre o circuito (OPEN).
 * - No estado OPEN, corta imediatamente requisições futuras retornando HTTP 503 rápido (Fail-Fast),
 *   evitando saturar o serviço degradado e protegendo a integridade da plataforma.
 * - Realiza transição gradual para HALF-OPEN para testar e validar a recuperação do downstream.
 */
export const circuitBreakerPlugin = fp(async (fastify: FastifyInstance) => {
  const registry = new CircuitBreakerRegistry();
  fastify.decorate("circuitBreakers", registry);

  fastify.decorate(
    "applyCircuitBreaker",
    async function (
      request: FastifyRequest,
      reply: FastifyReply,
      route: RouteProxyDefinition
    ): Promise<boolean> {
      // Se a rota não definir política de Circuit Breaker, permite o tráfego
      if (!route.circuitBreaker) {
        return true;
      }

      const breaker = registry.getOrCreate(route.id, route.circuitBreaker);
      const state = breaker.getState();

      // Injeta o estado atual do circuito no cabeçalho de diagnóstico
      reply.header("X-Circuit-Breaker-State", state);

      if (!breaker.canExecute()) {
        const retryAfter = breaker.getRetryAfterSeconds();
        reply.header("Retry-After", String(retryAfter));

        request.log.warn({
          msg: "Requisição bloqueada pelo Circuit Breaker (Estado: OPEN)",
          routeId: route.id,
          upstream: route.upstream,
          retryAfter,
          correlationId: request.correlationId,
        });

        reply.status(503).send({
          statusCode: 503,
          error: "Service Unavailable",
          message: `Circuito aberto para o serviço upstream [${route.id}]. O serviço destino está temporariamente fora de operação.`,
          circuitBreaker: {
            id: route.id,
            state: "OPEN",
            retryAfter,
          },
          requestId: request.correlationId,
          timestamp: new Date().toISOString(),
        });

        return false;
      }

      return true;
    }
  );

  fastify.decorate(
    "recordCircuitBreakerResult",
    function (route: RouteProxyDefinition, statusCode: number, isNetworkError = false) {
      if (!route.circuitBreaker) return;

      const breaker = registry.getOrCreate(route.id, route.circuitBreaker);

      if (isNetworkError || statusCode >= 500) {
        breaker.recordFailure();
        fastify.log.warn({
          msg: "Falha registrada no Circuit Breaker",
          routeId: route.id,
          statusCode,
          isNetworkError,
          currentState: breaker.getState(),
        });
      } else {
        breaker.recordSuccess();
      }
    }
  );
});
