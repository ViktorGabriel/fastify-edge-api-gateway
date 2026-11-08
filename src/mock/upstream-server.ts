import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import { env } from "../config/env.js";

/**
 * Servidor Mock de Microsserviços Upstream
 * Usado para demonstração local, desenvolvimento e testes de ponta a ponta.
 */
export async function startUpstreamMocks() {
  // ==========================================
  // 1. Mock Users Service (Porta 3001)
  // ==========================================
  const usersApp = Fastify({ logger: false });
  await usersApp.register(fastifyJwt, { secret: env.JWT_SECRET });

  // Rota pública de login que gera token JWT válido
  usersApp.post("/auth/login", async (req, reply) => {
    const body = (req.body as any) || {};
    const userId = body.userId || "usr_99887766";
    const role = body.role || "admin";
    const email = body.email || "engenheiro@plataforma.io";

    const token = usersApp.jwt.sign(
      { sub: userId, role, email, iss: env.JWT_ISSUER },
      { expiresIn: "1h" }
    );

    return reply.status(200).send({
      message: "Login realizado com sucesso no serviço de usuários",
      token,
      user: { id: userId, role, email },
      receivedGatewayHeaders: {
        "x-request-id": req.headers["x-request-id"],
        "x-forwarded-by": req.headers["x-forwarded-by"],
      },
    });
  });

  // Rota protegida de perfil do usuário
  usersApp.get("/users/profile", async (req, reply) => {
    return reply.status(200).send({
      message: "Perfil do usuário recuperado com sucesso",
      service: "users-service",
      // Demonstra que o Gateway repassou o x-user-id e x-request-id com sucesso!
      contextReceived: {
        userId: req.headers["x-user-id"],
        userRole: req.headers["x-user-role"],
        userEmail: req.headers["x-user-email"],
        requestId: req.headers["x-request-id"],
        forwardedBy: req.headers["x-forwarded-by"],
        gatewayTimestamp: req.headers["x-gateway-timestamp"],
      },
    });
  });

  // ==========================================
  // 2. Mock Orders Service (Porta 3002)
  // ==========================================
  const ordersApp = Fastify({ logger: false });

  // Rota pública de catálogo
  ordersApp.get("/catalog/items", async (req, reply) => {
    return reply.status(200).send({
      message: "Catálogo público de produtos",
      service: "orders-service",
      requestId: req.headers["x-request-id"],
      items: [
        { id: "prod_1", name: "Servidor Bare Metal", price: 1200 },
        { id: "prod_2", name: "Cluster Kubernetes Gerenciado", price: 450 },
      ],
    });
  });

  // Rota protegida de checkout
  ordersApp.post("/orders/checkout", async (req, reply) => {
    return reply.status(201).send({
      message: "Pedido criado com sucesso!",
      service: "orders-service",
      orderId: "ord_554433",
      buyerUserId: req.headers["x-user-id"],
      requestId: req.headers["x-request-id"],
      timestamp: new Date().toISOString(),
    });
  });

  await usersApp.listen({ port: 3001, host: "0.0.0.0" });
  await ordersApp.listen({ port: 3002, host: "0.0.0.0" });

  console.log("Mock Users Service rodando na porta 3001");
  console.log("Mock Orders Service rodando na porta 3002");

  return { usersApp, ordersApp };
}

// Se executado diretamente
if (process.argv[1]?.endsWith("upstream-server.ts") || process.argv[1]?.endsWith("upstream-server.js")) {
  startUpstreamMocks().catch(console.error);
}
