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
