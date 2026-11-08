import { FastifyRequest } from "fastify";

/**
 * Payload estruturado do token JWT decodificado no Gateway
 */
export interface JwtUserPayload {
  sub: string;
  email?: string;
  role?: string;
  roles?: string[];
  permissions?: string[];
  iss?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  id?: string;
  userId?: string;
  [key: string]: unknown;
}

/**
 * Estratégia de extração da chave para o Rate Limiting
 */
export type RateLimitKeyStrategy = "ip" | "user" | "user-or-ip";

/**
 * Configuração de Rate Limiting por rota
 */
export interface RateLimitConfig {
  /** Quantidade máxima de requisições permitidas na janela */
  limit: number;
  /** Tamanho da janela móvel deslizante em milissegundos (ex: 60000 = 1 min) */
  windowMs: number;
  /** Estratégia de identificação do cliente (padrão: "user-or-ip") */
  keyStrategy?: RateLimitKeyStrategy;
  /** Prefixo opcional para isolamento de cotas */
  keyPrefix?: string;
}

/**
 * Resultado da avaliação do script Lua no Redis
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
  resetAfter: number;
}

/**
 * Estados da Máquina de Estados do Circuit Breaker
 */
export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF-OPEN";

/**
 * Configuração de Circuit Breaker por rota/serviço upstream
 */
export interface CircuitBreakerConfig {
  /** Quantidade de falhas para abrir o circuito (padrão: 5) */
  failureThreshold?: number;
  /** Janela móvel para contagem de falhas em ms (padrão: 10000ms = 10s) */
  windowMs?: number;
  /** Tempo de permanência no estado OPEN antes de testar em HALF-OPEN (padrão: 10000ms = 10s) */
  resetTimeoutMs?: number;
  /** Quantidade de sucessos consecutivos em HALF-OPEN para fechar o circuito (padrão: 2) */
  halfOpenSuccessThreshold?: number;
}

/**
 * Snapshot de telemetria do Circuit Breaker
 */
export interface CircuitBreakerSnapshot {
  id: string;
  state: CircuitBreakerState;
  failuresCount: number;
  failureThreshold: number;
  consecutiveSuccesses: number;
  halfOpenSuccessThreshold: number;
  windowMs: number;
  resetTimeoutMs: number;
  lastFailureTime?: number;
  nextAttemptTime?: number;
  retryAfterSeconds?: number;
  totalTrips: number;
}

/**
 * Definição declarativa de uma rota de proxy no API Gateway
 */
export interface RouteProxyDefinition {
  /** Identificador amigável da rota para logs, métricas e tracing */
  id: string;
  /** Prefixo no Gateway que será interceptado (ex: '/api/v1/users') */
  prefix: string;
  /** URL base do serviço upstream (ex: 'http://localhost:3001') */
  upstream: string;
  /** Se informado, reescreve o prefixo ao repassar ao upstream (ex: '/api/v1/users' -> '/users') */
  rewritePrefix?: string;
  /** Se a rota exige token JWT válido no cabeçalho Authorization */
  authRequired: boolean;
  /** Configuração declarativa de Rate Limiting via Redis Sliding Window */
  rateLimit?: RateLimitConfig;
  /** Configuração declarativa de Circuit Breaker para resiliência do upstream */
  circuitBreaker?: CircuitBreakerConfig;
  /** Timeout em milissegundos para a chamada ao upstream */
  timeoutMs?: number;
  /** Métodos HTTP permitidos para esta rota (se omitido, aceita todos) */
  allowedMethods?: ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD")[];
  /** Metadados de documentação e engenharia de plataforma */
  description?: string;
  tags?: string[];
}

/**
 * Extensão dos tipos do @fastify/jwt e FastifyRequest
 */
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtUserPayload;
    user: JwtUserPayload;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}
