import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import { buildApp } from "../src/app.js";
import { RouteProxyDefinition } from "../src/types/index.js";

describe("Fastify Edge API Gateway - Infraestrutura e Plataforma", () => {
  let gatewayApp: FastifyInstance;
  let mockUsersService: FastifyInstance;
  let mockOrdersService: FastifyInstance;

  const usersServicePort = 3101;
  const ordersServicePort = 3102;
  const testSecret = "super-secret-gateway-master-key-32ch!";
  let validJwtToken: string;

  beforeAll(async () => {
    // 1. Inicializa o Mock do Serviço de Usuários
    mockUsersService = Fastify({ logger: false });
    mockUsersService.get("/users/profile", async (req, reply) => {
      return reply.status(200).send({
        status: "success",
        headersReceived: {
          userId: req.headers["x-user-id"],
          requestId: req.headers["x-request-id"],
          userRole: req.headers["x-user-role"],
          forwardedBy: req.headers["x-forwarded-by"],
        },
      });
    });

    mockUsersService.post("/auth/login", async (_req, reply) => {
      return reply.status(200).send({ message: "Login mock" });
    });

    await mockUsersService.listen({ port: usersServicePort, host: "127.0.0.1" });

    // 2. Inicializa o Mock do Serviço de Pedidos / Catálogo
    mockOrdersService = Fastify({ logger: false });
    mockOrdersService.get("/catalog/items", async (req, reply) => {
      return reply.status(200).send({
        status: "success",
        items: [{ id: "item-1", name: "Servidor Cloud" }],
        requestId: req.headers["x-request-id"],
      });
    });

    await mockOrdersService.listen({ port: ordersServicePort, host: "127.0.0.1" });

    // 3. Define rotas declarativas de teste apontando para as portas dos mocks
    const testRoutes: RouteProxyDefinition[] = [
      {
        id: "test-auth-public",
        prefix: "/api/v1/auth",
        upstream: `http://127.0.0.1:${usersServicePort}`,
        rewritePrefix: "/auth",
        authRequired: false,
        allowedMethods: ["POST", "GET"],
      },
      {
        id: "test-users-protected",
        prefix: "/api/v1/users",
        upstream: `http://127.0.0.1:${usersServicePort}`,
        rewritePrefix: "/users",
        authRequired: true,
        allowedMethods: ["GET", "POST"],
      },
      {
        id: "test-catalog-public",
        prefix: "/api/v1/catalog",
        upstream: `http://127.0.0.1:${ordersServicePort}`,
        rewritePrefix: "/catalog",
        authRequired: false,
        allowedMethods: ["GET"],
      },
    ];

    // 4. Constrói a instância do Gateway usando as rotas de teste
    gatewayApp = await buildApp({
      customRoutes: testRoutes,
      fastifyOptions: { logger: false },
    });
    await gatewayApp.ready();

    // 5. Gera um token JWT de teste válido
    validJwtToken = gatewayApp.jwt.sign(
      { sub: "usr_platform_12345", role: "staff_engineer", email: "viktor@plataforma.io" },
      { expiresIn: "1h" }
    );
  });

  afterAll(async () => {
    if (gatewayApp) await gatewayApp.close();
    if (mockUsersService) await mockUsersService.close();
    if (mockOrdersService) await mockOrdersService.close();
  });

  // =========================================================================
  // Health Check & Diagnostics
  // =========================================================================
  it("deve responder 200 no Liveness Probe (/health/live)", async () => {
    const res = await gatewayApp.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("UP");
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("deve responder 200 no Readiness Probe (/health/ready) e no catálogo (/gateway/routes)", async () => {
    const res = await gatewayApp.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("READY");
    expect(body.registeredRoutesCount).toBeGreaterThan(0);

    const routesRes = await gatewayApp.inject({
      method: "GET",
      url: "/gateway/routes",
    });
    expect(routesRes.statusCode).toBe(200);
    const routesBody = JSON.parse(routesRes.payload);
    expect(routesBody.routes.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Rota Pública: Proxying e Propagação de x-request-id
  // =========================================================================
  it("deve permitir acesso à rota pública sem token JWT e injetar x-request-id", async () => {
    const res = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/catalog/items",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("success");
    expect(body.items.length).toBe(1);

    // Verifica que o Gateway retornou x-request-id na resposta
    const responseReqId = res.headers["x-request-id"];
    expect(responseReqId).toBeDefined();
    expect(typeof responseReqId).toBe("string");

    // Verifica que o upstream recebeu o mesmo requestId
    expect(body.requestId).toBe(responseReqId);
  });

  it("deve preservar o x-request-id enviado pelo cliente para tracing distribuído", async () => {
    const customCorrelationId = "custom-trace-uuid-9999-platform";

    const res = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/catalog/items",
      headers: {
        "x-request-id": customCorrelationId,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(res.headers["x-request-id"]).toBe(customCorrelationId);
    expect(body.requestId).toBe(customCorrelationId);
  });

  // =========================================================================
  // Rota Protegida: Rejeições de Autenticação (401 Unauthorized)
  // =========================================================================
  it("deve bloquear com 401 Unauthorized se rota protegida for chamada sem Authorization header", async () => {
    const res = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/users/profile",
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("Unauthorized");
    expect(body.message).toContain("Authorization");
    expect(body.requestId).toBeDefined();
  });

  it("deve bloquear com 401 se formato do token não for Bearer", async () => {
    const res = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/users/profile",
      headers: {
        authorization: "Basic dXNlcjpwYXNz",
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.message).toContain("Bearer");
  });

  it("deve bloquear com 401 se o token JWT for inválido ou tiver assinatura forjada", async () => {
    const forgedToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJoYWNrZXIifQ.assinatura_falsa";

    const res = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/users/profile",
      headers: {
        authorization: `Bearer ${forgedToken}`,
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("Unauthorized");
    expect(body.message).toContain("inválido");
  });

  // =========================================================================
  // Rota Protegida: Sucesso e Enriquecimento de Contexto (x-user-id)
  // =========================================================================
  it("deve autenticar JWT válido e enriquecer headers x-user-id e x-request-id para o upstream", async () => {
    const res = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/users/profile",
      headers: {
        authorization: `Bearer ${validJwtToken}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("success");

    // Verifica headers recebidos pelo upstream
    expect(body.headersReceived.userId).toBe("usr_platform_12345");
    expect(body.headersReceived.userRole).toBe("staff_engineer");
    expect(body.headersReceived.forwardedBy).toBe("fastify-api-gateway");
    expect(body.headersReceived.requestId).toBeDefined();
    expect(body.headersReceived.requestId).toBe(res.headers["x-request-id"]);
  });

  // =========================================================================
  // Segurança de Plataforma: Prevenção de Header Spoofing
  // =========================================================================
  it("deve sobrescrever qualquer header x-user-id forjado pelo cliente com o valor real do JWT", async () => {
    const spoofedUserId = "impostor-admin-999";

    const res = await gatewayApp.inject({
      method: "GET",
      url: "/api/v1/users/profile",
      headers: {
        authorization: `Bearer ${validJwtToken}`,
        "x-user-id": spoofedUserId, // Tentativa de forjar identidade
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // Garante que o upstream recebeu o sub autêntico do token e NÃO o spoofado
    expect(body.headersReceived.userId).toBe("usr_platform_12345");
    expect(body.headersReceived.userId).not.toBe(spoofedUserId);
  });

  // =========================================================================
  // Validação de Método HTTP (405 Method Not Allowed)
  // =========================================================================
  it("deve retornar 405 Method Not Allowed se o método não estiver na lista permitida da rota declarativa", async () => {
    // Rota /api/v1/catalog só aceita GET
    const res = await gatewayApp.inject({
      method: "DELETE",
      url: "/api/v1/catalog/items",
    });

    expect(res.statusCode).toBe(405);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("Method Not Allowed");
  });
});
