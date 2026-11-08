import { z } from "zod";
import dotenv from "dotenv";

// Carrega .env se existir
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET deve ter no mínimo 16 caracteres para segurança de produção").default("super-secret-gateway-master-key-32ch!"),
  JWT_ISSUER: z.string().default("fastify-api-gateway"),
  
  // Upstream URLs configuráveis por ambiente
  USERS_SERVICE_URL: z.string().url().default("http://127.0.0.1:3001"),
  ORDERS_SERVICE_URL: z.string().url().default("http://127.0.0.1:3002"),
  BILLING_SERVICE_URL: z.string().url().default("http://127.0.0.1:3003"),

  // Limite de timeout padrão para proxied requests
  DEFAULT_PROXY_TIMEOUT_MS: z.coerce.number().default(15000),
});

export type EnvConfig = z.infer<typeof envSchema>;

export const env: EnvConfig = envSchema.parse(process.env);
