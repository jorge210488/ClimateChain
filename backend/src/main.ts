import { NestFactory } from "@nestjs/core";
import { Logger as NestLogger } from "@nestjs/common";

import { AppModule } from "./app.module";
import { configureApp, setupSwagger, SWAGGER_PATH } from "./app-setup";
import { AppConfigService } from "./config/app-config.service";

async function bootstrap(): Promise<void> {
  // `bufferLogs` holds startup logs until the pino logger is installed so the
  // fail-fast metadata validation surfaces through structured logging.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  configureApp(app);
  setupSwagger(app);

  const config = app.get(AppConfigService);
  const { port, nodeEnv } = config.app;

  await app.listen(port);

  const logger = new NestLogger("Bootstrap");
  logger.log(
    `ClimateChain backend listening on port ${port} (profile=${nodeEnv}); ` +
      `API docs at /${SWAGGER_PATH}`,
  );
}

bootstrap().catch((error) => {
  // Fail-fast: write straight to stderr so the diagnostic is always visible,
  // even though `bufferLogs` is active and the app never finished starting
  // (buffered Nest logs would otherwise be discarded on early failure).
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[Bootstrap] Backend failed to start:\n${detail}`);
  process.exit(1);
});
