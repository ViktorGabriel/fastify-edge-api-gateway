import { Redis } from "ioredis";
import type { Redis as RedisClient } from "ioredis";
import { RateLimitResult } from "../types/index.js";
import { env } from "../config/env.js";

/**
 * Script Lua Atômico para Sliding Window Counter no Redis
 * 
 * Utiliza um Sorted Set (ZSET) onde o score é o timestamp Unix em milissegundos.
 * 
 * - KEYS[1]: Chave no Redis para a rota/cliente (ex: 'gateway:ratelimit:orders:usr_123')
 * - ARGV[1]: Timestamp atual em milissegundos (now)
 * - ARGV[2]: Duração da janela móvel em milissegundos (windowMs)
 * - ARGV[3]: Limite máximo permitido (limit)
 * - ARGV[4]: Identificador único da requisição (requestId)
 * 
 * Retorno: { allowed (1|0), remaining, retryAfter (segundos), resetAfter (segundos) }
 */
export const SLIDING_WINDOW_LUA_SCRIPT = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local reqId = ARGV[4]
  local clearBefore = now - windowMs

  -- 1. Remove atopicamente requisições fora da janela deslizante móvel
  redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)

  -- 2. Conta quantas requisições estão registradas na janela ativa
  local currentCount = redis.call('ZCARD', key)

  if currentCount < limit then
    -- 3a. Limite não excedido: registra requisição com score = now
    redis.call('ZADD', key, now, reqId)
    -- Garante TTL para desalocar memória do Redis quando a chave ficar inativa
    redis.call('PEXPIRE', key, windowMs)

    local remaining = limit - currentCount - 1
    local resetSec = math.ceil(windowMs / 1000)
    return { 1, remaining, 0, resetSec }
  else
    -- 3b. Limite estourado: calcula tempo restante até a requisição mais antiga expirar
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retryAfterMs = windowMs

    if oldest and oldest[2] then
      local oldestTime = tonumber(oldest[2])
      retryAfterMs = (oldestTime + windowMs) - now
      if retryAfterMs < 0 then
        retryAfterMs = 0
      end
    end

    local retryAfterSec = math.ceil(retryAfterMs / 1000)
    if retryAfterSec <= 0 then
      retryAfterSec = 1
    end

    return { 0, 0, retryAfterSec, retryAfterSec }
  end
`;

export class RedisRateLimiterService {
  private redis: RedisClient;
  private keyPrefix: string;
  private isConnected = false;

  constructor(customRedis?: RedisClient, keyPrefix = env.REDIS_KEY_PREFIX) {
    this.keyPrefix = keyPrefix;

    if (customRedis) {
      this.redis = customRedis;
      this.isConnected = true;
    } else {
      this.redis = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
      });

      this.redis.on("connect", () => {
        this.isConnected = true;
      });

      this.redis.on("error", (err) => {
        this.isConnected = false;
      });
    }
  }

  public async connect(): Promise<void> {
    if (!this.isConnected && this.redis.status === "wait") {
      try {
        await this.redis.connect();
        this.isConnected = true;
      } catch (err) {
        this.isConnected = false;
        throw err;
      }
    }
  }

  public async disconnect(): Promise<void> {
    if (this.redis.status === "ready" || this.redis.status === "connecting") {
      await this.redis.quit();
    }
  }

  public getClient(): RedisClient {
    return this.redis;
  }

  /**
   * Avalia a barreira de limite de taxa utilizando o script Lua de Sliding Window
   * 
   * @param key Chave identificadora única (ex: 'orders-checkout:usr_123' ou 'catalog:192.168.1.5')
   * @param limit Quantidade máxima permitida
   * @param windowMs Duração da janela móvel em ms
   * @param requestId Identificador de correlação para evitar colisões no ZSET
   */
  public async consume(
    key: string,
    limit: number,
    windowMs: number,
    requestId: string,
    now: number = Date.now()
  ): Promise<RateLimitResult> {
    const redisKey = `${this.keyPrefix}${key}`;
    const uniqueReqId = `${now}:${requestId}`;

    try {
      const result = (await this.redis.eval(
        SLIDING_WINDOW_LUA_SCRIPT,
        1,
        redisKey,
        String(now),
        String(windowMs),
        String(limit),
        uniqueReqId
      )) as [number, number, number, number];

      const [allowedNum, remaining, retryAfter, resetAfter] = result;

      return {
        allowed: allowedNum === 1,
        limit,
        remaining: Math.max(0, remaining),
        retryAfter: retryAfter || 0,
        resetAfter: resetAfter || Math.ceil(windowMs / 1000),
      };
    } catch (error) {
      // Resiliência de Plataforma: Em caso de falha transitória do Redis,
      // registramos o erro e permitimos a passagem (Fail-Open) para não indisponibilizar a borda.
      return {
        allowed: true,
        limit,
        remaining: 1,
        retryAfter: 0,
        resetAfter: Math.ceil(windowMs / 1000),
      };
    }
  }
}
