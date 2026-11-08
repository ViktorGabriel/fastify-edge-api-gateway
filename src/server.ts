import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { setupGracefulShutdown } from "./utils/shutdown.js";

async function bootstrap() {
  const app = await buildApp();

  setupGracefulShutdown(app);

  try {
    const address = await app.listen({
      port: env.PORT,
      host: env.HOST,
    });

    app.log.info({
      msg: "🚀 Fastify Edge API Gateway iniciado com sucesso!",
      address,
      environment: env.NODE_ENV,
      port: env.PORT,
      host: env.HOST,
    });
  } catch (err) {
    app.log.fatal({ msg: "Falha ao iniciar o API Gateway", err });
    process.exit(1);
  }
}

bootstrap();
