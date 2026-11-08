import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import { buildApp } from "../src/app.js";
import { RouteProxyDefinition } from "../src/types/index.js";
import { RedisRateLimiterService } from "../src/services/redis-rate-limiter.service.js";

describe("Middleware de Rate Limiting - Sliding Window Counter (Redis Lua)", () => {
  let gatewayApp: FastifyInstance;
  let mockBackendService: FastifyInstance;
  let redisMock: any;

  const backendPort = 3201;
  let userTokenAlice: string;
  let userTokenBob: string;

  beforeAll(async () => {
    // 1. Inicializa o serviço backend mock que o Gateway irá repassar
    mockBackendService = Fastify({ logger: false });
    mockBackendService.all("/*", async (req, reply) => {
      return reply.status(200).send({
        status: "ok",
        service: "upstream-backend",
        path: req.raw.url,
        headers: {
          userId: req.headers["x-user-id"],
          requestId: req.headers["x-request-id"],
        },
      });
    });

    await mockBackendService.listen({ port: backendPort, host: "127.0.0.1" });

    // 2. Instancia o cliente mock do Redis para testes de alta fidelidade
    redisMock = new RedisMock();

    // 3. Define rotas declarativas com limites estritos para testes
    const testRoutes: RouteProxyDefinition[] = [
      {
        id: "route-strict-limit",
        prefix: "/api/v1/strict",
        upstream: `http://127.0.0.1:${backendPort}`,
        rewritePrefix: "/strict",
        authRequired: false,
        rateLimit: {
          limit: 3, // Máximo 3 requisições
          windowMs: 5000, // Janela de 5 segundos
          keyStrategy: "ip",
        },
      },
      {
        id: "route-user-quota",
        prefix: "/api/v1/user-quota",
        upstream: `http://127.0.0.1:${backendPort}`,
        rewritePrefix: "/user-quota",
        authRequired: true,
        rateLimit: {
          limit: 2, // Máximo 2 requisições por usuário
          windowMs: 10000,
          keyStrategy: "user",
        },
      },
      {
        id: "route-other-service",
        prefix: "/api/v1/other",
        upstream: `http://127.0.0.1:${backendPort}`,
        rewritePrefix: "/other",
        authRequired: false,
        rateLimit: {
          limit: 10,
          windowMs: 10000,
          keyStrategy: "ip",
        },
      },
    ];

    // 4. Constrói a aplicação injetando o mock do Redis
    gatewayApp = await buildApp({
      customRoutes: testRoutes,
      customRedis: redisMock,
      fastifyOptions: { logger: false },
    });
    await gatewayApp.ready();

    // 5. Gera tokens JWT para usuários distintos
    userTokenAlice = gatewayApp.jwt.sign({ sub: "usr_alice", role: "member" }, { expiresIn: "1h" });
    userTokenBob = gatewayApp.jwt.sign({ sub: "usr_bob", role: "member" }, { expiresIn: "1h" });
  });

  beforeEach(async () => {
    // Limpa as chaves do Redis entre os testes
    await redisMock.flushall();
  });

  afterAll(async () => {
    if (gatewayApp) await gatewayApp.close();
    if (mockBackendService) await mockBackendService.close();
  });

  // =========================================================================
  // 1. Barreira de Limite e Headers RFC
  // =========================================================================
  it("deve permitir requisições dentro da cota e retornar headers RFC decrementados", async () => {
    // 1ª Requisição (consumo 1 de 3)
    const res1 = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/strict/test",
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.headers["x-ratelimit-limit"]).toBe("3");
    expect(res1.headers["x-ratelimit-remaining"]).toBe("2");
    expect(res1.headers["x-ratelimit-reset"]).toBeDefined();
    expect(res1.headers["retry-after"]).toBeUndefined();

    // 2ª Requisição (consumo 2 de 3)
    const res2 = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/strict/test",
    });

    expect(res2.statusCode).toBe(200);
    expect(res2.headers["x-ratelimit-remaining"]).toBe("1");

    // 3ª Requisição (consumo 3 de 3 - esgotando a cota)
    const res3 = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/strict/test",
    });

    expect(res3.statusCode).toBe(200);
    expect(res3.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("deve barrar a 4ª requisição com HTTP 429 Too Many Requests e header Retry-After", async () => {
    // Esgota as 3 requisições permitidas
    for (let i = 0; i < 3; i++) {
      await gatewayApp.inject({
        method: "GET",
        url: "/api/v1/strict/test",
      });
    }

    // 4ª Requisição (ultrapassou o limite)
    const resBlocked = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/strict/test",
    });

    expect(resBlocked.statusCode).toBe(429);
    expect(resBlocked.headers["x-ratelimit-limit"]).toBe("3");
    expect(resBlocked.headers["x-ratelimit-remaining"]).toBe("0");

    // Valida presença e formato do Retry-After (RFC 6585)
    const retryAfter = resBlocked.headers["retry-after"];
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

    // Valida payload RFC padronizado
    const body = JSON.parse(resBlocked.payload);
    expect(body.statusCode).toBe(429);
    expect(body.error).toBe("Too Many Requests");
    expect(body.message).toContain("Limite de requisições excedido");
    expect(body.retryAfter).toBe(Number(retryAfter));
    expect(body.requestId).toBeDefined();
    expect(body.timestamp).toBeDefined();
  });

  // =========================================================================
  // 2. Isolamento por Identidade do Usuário (keyStrategy: "user")
  // =========================================================================
  it("deve isolar as cotas de rate limit por User ID autenticado no JWT", async () => {
    // Alice faz 2 requisições e esgota sua cota de 2
    for (let i = 0; i < 2; i++) {
      const resAlice = await gatewayApp.inject({
        method: "GET",
        url: "/api/v1/user-quota/profile",
        headers: { authorization: `Bearer ${userTokenAlice}` },
      });
      expect(resAlice.statusCode).toBe(200);
    }

    // 3ª Requisição de Alice deve ser bloqueada (429)
    const resAliceBlocked = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/user-quota/profile",
      headers: { authorization: `Bearer ${userTokenAlice}` },
    });
    expect(resAliceBlocked.statusCode).toBe(429);

    // Bob faz requisição na MESMA rota e deve ser APROVADO com 200 (sua cota é independente)
    const resBob = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/user-quota/profile",
      headers: { authorization: `Bearer ${userTokenBob}` },
    });

    expect(resBob.statusCode).toBe(200);
    expect(resBob.headers["x-ratelimit-remaining"]).toBe("1");
    const bobBody = JSON.parse(resBob.payload);
    expect(bobBody.headers.userId).toBe("usr_bob");
  });

  // =========================================================================
  // 3. Isolamento entre Rotas Diferentes
  // =========================================================================
  it("deve isolar limites de rotas distintas (estourar uma rota não bloqueia outra)", async () => {
    // Esgota rota '/api/v1/strict' (limite 3)
    for (let i = 0; i < 3; i++) {
      await gatewayApp.inject({ method: "GET", url: "/api/v1/strict/ping" });
    }

    const resStrictBlocked = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/strict/ping",
    });
    expect(resStrictBlocked.statusCode).toBe(429);

    // Rota '/api/v1/other' deve continuar respondendo 200 normalmente
    const resOther = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/other/ping",
    });
    expect(resOther.statusCode).toBe(200);
    expect(resOther.headers["x-ratelimit-remaining"]).toBe("9");
  });

  // =========================================================================
  // 4. Teste Unitário do Algoritmo Sliding Window com Decurso de Tempo
  // =========================================================================
  it("deve restaurar a cota no Sliding Window conforme o tempo avança além da janela", async () => {
    const rateLimiter = new RedisRateLimiterService(redisMock, "test:sliding:");
    const testKey = "client-window-test";
    const limit = 2;
    const windowMs = 5000; // 5 segundos
    const baseTime = 1000000000000;

    // 1ª chamada no tempo T=0 -> Permitido (restante: 1)
    const c1 = await rateLimiter.consume(testKey, limit, windowMs, "req-1", baseTime);
    expect(c1.allowed).toBe(true);
    expect(c1.remaining).toBe(1);

    // 2ª chamada no tempo T=+1s -> Permitido (restante: 0)
    const c2 = await rateLimiter.consume(testKey, limit, windowMs, "req-2", baseTime + 1000);
    expect(c2.allowed).toBe(true);
    expect(c2.remaining).toBe(0);

    // 3ª chamada no tempo T=+2s -> Bloqueado (429)
    const c3 = await rateLimiter.consume(testKey, limit, windowMs, "req-3", baseTime + 2000);
    expect(c3.allowed).toBe(false);
    expect(c3.remaining).toBe(0);
    expect(c3.retryAfter).toBeGreaterThanOrEqual(1);

    // 4ª chamada no tempo T=+5.5s (req-1 no T=0 já expirou da janela de 5s, mas req-2 no T=1000 ainda está ativa)
    const c4 = await rateLimiter.consume(testKey, limit, windowMs, "req-4", baseTime + 5500);
    expect(c4.allowed).toBe(true);
    expect(c4.remaining).toBe(0); // req-2 e req-4 ocupam os 2 slots da janela ativa

    // 5ª chamada no tempo T=+12s (todas as requisições anteriores expiraram) -> Janela totalmente limpa
    const c5 = await rateLimiter.consume(testKey, limit, windowMs, "req-5", baseTime + 12000);
    expect(c5.allowed).toBe(true);
    expect(c5.remaining).toBe(1);
  });
});
