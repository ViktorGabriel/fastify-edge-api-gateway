import { RouteProxyDefinition } from "../types/index.js";
import { env } from "./env.js";

/**
 * Catálogo declarativo central de roteamento do API Gateway.
 * 
 * Cada entrada define as regras de interceptação de borda:
 * - prefix: prefixo capturado no Gateway.
 * - upstream: destino do tráfego do microsserviço.
 * - rewritePrefix: mapeamento de path para o upstream.
 * - authRequired: intercepta e valida JWT antes do proxy upstream.
 * - rateLimit: contenção de vazão por Sliding Window via Redis Lua.
 * - circuitBreaker: contenção de cascata de falhas e Fail-Fast (503).
 * - timeoutMs: resiliência e circuit protection contra saturação.
 */
export const routesConfig: RouteProxyDefinition[] = [
  // ==========================================
  // SERVIÇO DE USUÁRIOS & PERFIS
  // ==========================================
  {
    id: "users-public-auth",
    prefix: "/api/v1/auth",
    upstream: env.USERS_SERVICE_URL,
    rewritePrefix: "/auth",
    authRequired: false,
    allowedMethods: ["POST", "GET"],
    timeoutMs: 10000,
    rateLimit: {
      limit: 5,
      windowMs: 60000,
      keyStrategy: "ip",
    },
    circuitBreaker: {
      failureThreshold: 5,
      windowMs: 10000, // 5 falhas em 10s abrem o circuito
      resetTimeoutMs: 10000, // 10s no estado OPEN
      halfOpenSuccessThreshold: 2,
    },
    description: "Autenticação, login e registro público de usuários",
    tags: ["auth", "public"],
  },
  {
    id: "users-protected-service",
    prefix: "/api/v1/users",
    upstream: env.USERS_SERVICE_URL,
    rewritePrefix: "/users",
    authRequired: true,
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    timeoutMs: 10000,
    rateLimit: {
      limit: 100,
      windowMs: 60000,
      keyStrategy: "user-or-ip",
    },
    circuitBreaker: {
      failureThreshold: 5,
      windowMs: 10000,
      resetTimeoutMs: 10000,
      halfOpenSuccessThreshold: 2,
    },
    description: "Gestão de perfis e contas - Requer JWT e propaga x-user-id",
    tags: ["users", "authenticated"],
  },

  // ==========================================
  // SERVIÇO DE PEDIDOS & CHECKOUT
  // ==========================================
  {
    id: "orders-catalog-public",
    prefix: "/api/v1/catalog",
    upstream: env.ORDERS_SERVICE_URL,
    rewritePrefix: "/catalog",
    authRequired: false,
    allowedMethods: ["GET"],
    timeoutMs: 8000,
    rateLimit: {
      limit: 200,
      windowMs: 60000,
      keyStrategy: "ip",
    },
    circuitBreaker: {
      failureThreshold: 5,
      windowMs: 10000,
      resetTimeoutMs: 10000,
      halfOpenSuccessThreshold: 2,
    },
    description: "Catálogo de produtos aberto ao público",
    tags: ["catalog", "public"],
  },
  {
    id: "orders-checkout-protected",
    prefix: "/api/v1/orders",
    upstream: env.ORDERS_SERVICE_URL,
    rewritePrefix: "/orders",
    authRequired: true,
    allowedMethods: ["GET", "POST", "PUT", "DELETE"],
    timeoutMs: 15000,
    rateLimit: {
      limit: 20,
      windowMs: 60000,
      keyStrategy: "user",
    },
    circuitBreaker: {
      failureThreshold: 5,
      windowMs: 10000,
      resetTimeoutMs: 10000,
      halfOpenSuccessThreshold: 2,
    },
    description: "Criação e consulta de pedidos - Requer JWT e propaga x-user-id",
    tags: ["orders", "authenticated"],
  },

  // ==========================================
  // SERVIÇO DE COBRANÇA E FATURAMENTO
  // ==========================================
  {
    id: "billing-protected-service",
    prefix: "/api/v1/billing",
    upstream: env.BILLING_SERVICE_URL,
    rewritePrefix: "/billing",
    authRequired: true,
    allowedMethods: ["GET", "POST"],
    timeoutMs: 20000,
    rateLimit: {
      limit: 10,
      windowMs: 60000,
      keyStrategy: "user",
    },
    circuitBreaker: {
      failureThreshold: 3, // Tolerância menor para faturamento
      windowMs: 10000,
      resetTimeoutMs: 15000,
      halfOpenSuccessThreshold: 2,
    },
    description: "Operações de faturamento e notas fiscais protegidas",
    tags: ["billing", "financial", "authenticated"],
  },
];
