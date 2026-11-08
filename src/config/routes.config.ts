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
 * - rateLimit: política de contenção por Sliding Window via Redis Lua.
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
    // Proteção contra brute force e credential stuffing (por IP)
    rateLimit: {
      limit: 5,
      windowMs: 60000, // 5 requisições por minuto por IP
      keyStrategy: "ip",
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
    // Cota de perfil por usuário autenticado
    rateLimit: {
      limit: 100,
      windowMs: 60000, // 100 requisições por minuto por User ID
      keyStrategy: "user-or-ip",
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
    // Catálogo aberto com alta vazão
    rateLimit: {
      limit: 200,
      windowMs: 60000,
      keyStrategy: "ip",
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
    // Proteção contra spam de checkout e concorrência abusiva por User ID
    rateLimit: {
      limit: 20,
      windowMs: 60000,
      keyStrategy: "user",
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
    description: "Operações de faturamento e notas fiscais protegidas",
    tags: ["billing", "financial", "authenticated"],
  },
];
