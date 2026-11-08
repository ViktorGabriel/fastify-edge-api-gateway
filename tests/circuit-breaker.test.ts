import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import { buildApp } from "../src/app.js";
import { RouteProxyDefinition } from "../src/types/index.js";

describe("Padrão Circuit Breaker - Resiliência e Fail-Fast (CLOSED, OPEN, HALF-OPEN)", () => {
  let gatewayApp: FastifyInstance;
  let mockFlakyBackend: FastifyInstance;
  let redisMock: any;

  const flakyPort = 3301;
  let shouldFailWith500 = false;
  let backendHitCount = 0;

  beforeAll(async () => {
    // 1. Inicializa o serviço backend com comportamento comutável (saudável vs degradado)
    mockFlakyBackend = Fastify({ logger: false });

    mockFlakyBackend.all("/*", async (req, reply) => {
      backendHitCount += 1;

      if (shouldFailWith500) {
        return reply.status(500).send({
          status: "error",
          message: "Internal Database Connection Timeout",
        });
      }

      return reply.status(200).send({
        status: "ok",
        message: "Operação executada com sucesso pelo backend recuperado",
        hitCount: backendHitCount,
      });
    });

    await mockFlakyBackend.listen({ port: flakyPort, host: "127.0.0.1" });

    // 2. Instancia mock do Redis para o Rate Limiting desacoplado
    redisMock = new RedisMock();

    // 3. Define rota com política de Circuit Breaker estrita para testes
    const testRoutes: RouteProxyDefinition[] = [
      {
        id: "resilient-service",
        prefix: "/api/v1/orders-service",
        upstream: `http://127.0.0.1:${flakyPort}`,
        rewritePrefix: "/orders",
        authRequired: false,
        circuitBreaker: {
          failureThreshold: 5, // 5 falhas abrem o circuito
          windowMs: 5000, // em uma janela de 5 segundos
          resetTimeoutMs: 800, // 800ms de permanência em OPEN antes de HALF-OPEN
          halfOpenSuccessThreshold: 2, // 2 sucessos em HALF-OPEN para fechar
        },
      },
    ];

    // 4. Constrói a instância do Gateway
    gatewayApp = await buildApp({
      customRoutes: testRoutes,
      customRedis: redisMock,
      fastifyOptions: { logger: false },
    });
    await gatewayApp.ready();
  });

  beforeEach(() => {
    shouldFailWith500 = false;
    backendHitCount = 0;
    // Reseta o estado do Circuit Breaker entre os testes
    const breaker = gatewayApp.circuitBreakers.get("resilient-service");
    if (breaker) breaker.reset();
  });

  afterAll(async () => {
    if (gatewayApp) await gatewayApp.close();
    if (mockFlakyBackend) await mockFlakyBackend.close();
  });

  // =========================================================================
  // Teste Completo de Ciclo de Vida: CLOSED -> OPEN -> 503 Fail-Fast -> HALF-OPEN -> CLOSED
  // =========================================================================
  it("deve abrir o circuito após 5 falhas 5xx, retornar fallback 503 rápido e se recuperar gradualmente em HALF-OPEN", async () => {
    // -----------------------------------------------------------------------
    // FASE 1: Circuito CLOSED - Tráfego saudável normal
    // -----------------------------------------------------------------------
    const initialRes = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/orders-service/test",
    });

    expect(initialRes.statusCode).toBe(200);
    expect(initialRes.headers["x-circuit-breaker-state"]).toBe("CLOSED");
    expect(backendHitCount).toBe(1);

    // -----------------------------------------------------------------------
    // FASE 2: Degradação do Upstream (5 falhas consecutivas de 5xx)
    // -----------------------------------------------------------------------
    shouldFailWith500 = true; // Simula queda do banco de dados no upstream

    for (let i = 1; i <= 5; i++) {
      const failRes = await gatewayApp.inject({
        method: "GET",
        url: "/api/v1/orders-service/test",
      });
      expect(failRes.statusCode).toBe(500);
    }

    // O circuito acumulou 5 falhas dentro da janela e agora deve estar OPEN!
    const breaker = gatewayApp.circuitBreakers.get("resilient-service");
    expect(breaker?.getState()).toBe("OPEN");

    // -----------------------------------------------------------------------
    // FASE 3: Circuito OPEN - Fail-Fast imediato com HTTP 503
    // O Gateway corta a chamada antes de onerar o backend degradado!
    // -----------------------------------------------------------------------
    const hitsBeforeFailFast = backendHitCount;

    const fastFailRes = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/orders-service/test",
    });

    // 1. Valida o status e headers RFC de fallback
    expect(fastFailRes.statusCode).toBe(503);
    expect(fastFailRes.headers["x-circuit-breaker-state"]).toBe("OPEN");
    expect(fastFailRes.headers["retry-after"]).toBeDefined();

    // 2. Valida payload informativo estruturado
    const failFastBody = JSON.parse(fastFailRes.payload);
    expect(failFastBody.statusCode).toBe(503);
    expect(failFastBody.error).toBe("Service Unavailable");
    expect(failFastBody.circuitBreaker.state).toBe("OPEN");
    expect(failFastBody.requestId).toBeDefined();

    // 3. Prova irrefutável de proteção: o backend NÃO recebeu a requisição!
    expect(backendHitCount).toBe(hitsBeforeFailFast);

    // -----------------------------------------------------------------------
    // FASE 4: Recuperação do Upstream e Transição para HALF-OPEN
    // -----------------------------------------------------------------------
    shouldFailWith500 = false; // Backend recuperou sua integridade

    // Aguarda o resetTimeoutMs (800ms) para o circuito transitar para HALF-OPEN
    await new Promise((resolve) => setTimeout(resolve, 950));

    expect(breaker?.getState()).toBe("HALF-OPEN");

    // 1ª Requisição de Sondagem (Canary Probe 1 de 2 em HALF-OPEN)
    const probeRes1 = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/orders-service/test",
    });

    expect(probeRes1.statusCode).toBe(200);
    expect(probeRes1.headers["x-circuit-breaker-state"]).toBe("HALF-OPEN");
    expect(breaker?.getState()).toBe("HALF-OPEN");

    // 2ª Requisição de Sondagem (Canary Probe 2 de 2 -> fecha o circuito!)
    const probeRes2 = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/orders-service/test",
    });

    expect(probeRes2.statusCode).toBe(200);
    // Após o 2º sucesso consecutivo, o circuito atinge o threshold e FECHA!
    expect(breaker?.getState()).toBe("CLOSED");

    // -----------------------------------------------------------------------
    // FASE 5: Restabelecimento Pleno (CLOSED)
    // -----------------------------------------------------------------------
    const fullyRecoveredRes = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/orders-service/test",
    });

    expect(fullyRecoveredRes.statusCode).toBe(200);
    expect(fullyRecoveredRes.headers["x-circuit-breaker-state"]).toBe("CLOSED");
  });

  // =========================================================================
  // Telemetria e Probes de Diagnóstico de Plataforma
  // =========================================================================
  it("deve expor o snapshot em tempo real no endpoint /gateway/circuit-breakers", async () => {
    const res = await gatewayApp.inject({
      method: "GET",
      url: "/gateway/circuit-breakers",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.totalCircuits).toBeGreaterThan(0);

    const circuit = body.circuits.find((c: any) => c.id === "resilient-service");
    expect(circuit).toBeDefined();
    expect(circuit.state).toBe("CLOSED");
    expect(circuit.failureThreshold).toBe(5);
    expect(circuit.halfOpenSuccessThreshold).toBe(2);
  });
});
