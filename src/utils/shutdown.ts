import { FastifyInstance } from "fastify";

/**
 * Registra listeners de sinais de terminação (SIGINT, SIGTERM) para encerramento gracioso do Gateway
 */
export function setupGracefulShutdown(app: FastifyInstance): void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info({ msg: `Sinal ${signal} recebido. Iniciando graceful shutdown do API Gateway...` });

      try {
        await app.close();
        app.log.info({ msg: "API Gateway encerrado com sucesso. Todas as conexões ativas foram drenadas." });
        process.exit(0);
      } catch (err) {
        app.log.error({ msg: "Erro durante o shutdown do API Gateway", err });
        process.exit(1);
      }
    });
  }

  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ msg: "Unhandled Rejection detectada no processo", reason });
  });

  process.on("uncaughtException", (error) => {
    app.log.fatal({ msg: "Uncaught Exception detectada no processo", error });
    process.exit(1);
  });
}
