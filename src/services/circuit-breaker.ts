import {
  CircuitBreakerConfig,
  CircuitBreakerSnapshot,
  CircuitBreakerState,
} from "../types/index.js";

/**
 * Implementação do Padrão Circuit Breaker com Máquina de Estados
 * 
 * Estados:
 * - CLOSED: Operação normal. Tráfego flui para o upstream. Falhas são contabilizadas em janela móvel.
 * - OPEN: Falhas ultrapassaram o threshold. Interrompe tráfego imediatamente (Fail-Fast 503).
 * - HALF-OPEN: Tempo de reset expirou. Permite requisições canary/teste para validar recuperação.
 */
export class CircuitBreaker {
  public readonly id: string;
  private state: CircuitBreakerState = "CLOSED";
  private failureTimestamps: number[] = [];
  private consecutiveSuccesses = 0;
  private nextAttemptTime = 0;
  private lastFailureTime = 0;
  private totalTrips = 0;

  public readonly failureThreshold: number;
  public readonly windowMs: number;
  public readonly resetTimeoutMs: number;
  public readonly halfOpenSuccessThreshold: number;

  constructor(id: string, config: CircuitBreakerConfig = {}) {
    this.id = id;
    this.failureThreshold = config.failureThreshold ?? 5;
    this.windowMs = config.windowMs ?? 10000; // 10 segundos
    this.resetTimeoutMs = config.resetTimeoutMs ?? 10000; // 10 segundos
    this.halfOpenSuccessThreshold = config.halfOpenSuccessThreshold ?? 2;
  }

  /**
   * Obtém o estado atual considerando o decurso do tempo (transição OPEN -> HALF-OPEN)
   */
  public getState(now: number = Date.now()): CircuitBreakerState {
    if (this.state === "OPEN") {
      if (now >= this.nextAttemptTime) {
        this.state = "HALF-OPEN";
        this.consecutiveSuccesses = 0;
      }
    } else if (this.state === "CLOSED") {
      this.purgeExpiredFailures(now);
    }

    return this.state;
  }

  /**
   * Avalia se a requisição pode transitar para o upstream
   * @returns true se a chamada for permitida; false se o circuito estiver OPEN (Fail-Fast)
   */
  public canExecute(now: number = Date.now()): boolean {
    const currentState = this.getState(now);
    if (currentState === "OPEN") {
      return false;
    }
    return true;
  }

  /**
   * Registra uma execução bem-sucedida (status HTTP < 500)
   */
  public recordSuccess(): void {
    if (this.state === "HALF-OPEN") {
      this.consecutiveSuccesses += 1;

      // Se atingiu os sucessos requeridos em teste, o serviço se recuperou: fecha o circuito!
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.state = "CLOSED";
        this.failureTimestamps = [];
        this.consecutiveSuccesses = 0;
        this.nextAttemptTime = 0;
      }
    } else if (this.state === "CLOSED") {
      // Em CLOSED, sucessos ajudam na estabilidade
      this.consecutiveSuccesses += 1;
    }
  }

  /**
   * Registra uma falha de upstream (status HTTP >= 500, timeout ou erro de conexão de rede)
   */
  public recordFailure(now: number = Date.now()): void {
    this.lastFailureTime = now;

    if (this.state === "HALF-OPEN") {
      // Qualquer falha em HALF-OPEN reabre o circuito imediatamente
      this.trip(now);
    } else if (this.state === "CLOSED") {
      this.failureTimestamps.push(now);
      this.purgeExpiredFailures(now);

      // Se ultrapassou o limiar de falhas na janela temporal, abre o circuito!
      if (this.failureTimestamps.length >= this.failureThreshold) {
        this.trip(now);
      }
    }
  }

  /**
   * Transita o estado para OPEN e agenda a próxima tentativa
   */
  private trip(now: number): void {
    this.state = "OPEN";
    this.nextAttemptTime = now + this.resetTimeoutMs;
    this.consecutiveSuccesses = 0;
    this.totalTrips += 1;
  }

  /**
   * Remove falhas que ocorreram fora da janela temporal deslizante
   */
  private purgeExpiredFailures(now: number): void {
    const windowStart = now - this.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= windowStart);
  }

  /**
   * Retorna os segundos restantes antes de permitir a próxima tentativa (para cabeçalho Retry-After)
   */
  public getRetryAfterSeconds(now: number = Date.now()): number {
    if (this.state !== "OPEN") return 0;
    const diffMs = this.nextAttemptTime - now;
    return diffMs > 0 ? Math.ceil(diffMs / 1000) : 1;
  }

  /**
   * Reseta manualmente o estado do circuito para CLOSED (útil para testes ou intervenção operacional)
   */
  public reset(): void {
    this.state = "CLOSED";
    this.failureTimestamps = [];
    this.consecutiveSuccesses = 0;
    this.nextAttemptTime = 0;
  }

  /**
   * Retorna snapshot completo de telemetria para auditoria e monitoramento de plataforma
   */
  public getSnapshot(now: number = Date.now()): CircuitBreakerSnapshot {
    const currentState = this.getState(now);
    return {
      id: this.id,
      state: currentState,
      failuresCount: this.failureTimestamps.length,
      failureThreshold: this.failureThreshold,
      consecutiveSuccesses: this.consecutiveSuccesses,
      halfOpenSuccessThreshold: this.halfOpenSuccessThreshold,
      windowMs: this.windowMs,
      resetTimeoutMs: this.resetTimeoutMs,
      lastFailureTime: this.lastFailureTime || undefined,
      nextAttemptTime: this.nextAttemptTime || undefined,
      retryAfterSeconds: this.getRetryAfterSeconds(now),
      totalTrips: this.totalTrips,
    };
  }
}

/**
 * Catálogo central de Circuit Breakers registrados no Gateway
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  public getOrCreate(id: string, config?: CircuitBreakerConfig): CircuitBreaker {
    let breaker = this.breakers.get(id);
    if (!breaker) {
      breaker = new CircuitBreaker(id, config);
      this.breakers.set(id, breaker);
    }
    return breaker;
  }

  public get(id: string): CircuitBreaker | undefined {
    return this.breakers.get(id);
  }

  public getAllSnapshots(now: number = Date.now()): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.values()).map((b) => b.getSnapshot(now));
  }

  public clear(): void {
    this.breakers.clear();
  }
}
