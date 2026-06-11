import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { Logger } from "nestjs-pino";

/** Path where interactive API docs are served. */
export const SWAGGER_PATH = "docs";

/**
 * Applies runtime concerns shared by the HTTP server and tooling: the pino
 * logger, CORS, and graceful shutdown hooks. Global pipe/filter/guards are
 * registered in {@link AppModule} so they also apply under test.
 */
export function configureApp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  app.enableCors();
  app.enableShutdownHooks();
}

/** Builds the OpenAPI document without mounting it (used by export/check). */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("ClimateChain API")
    .setDescription(
      "Parametric climate micro-insurance backend API. Coordinates policy " +
        "lifecycle, premium pricing, and on-chain integration.",
    )
    .setVersion("1.0")
    .addBearerAuth()
    .addTag("health", "Liveness and readiness probes")
    .addTag("blockchain", "On-chain deployment metadata")
    .addTag("policies", "Parametric policy lifecycle")
    .addTag("pricing", "Premium quoting")
    .addTag("auth", "Authentication and administrative access")
    .build();

  return SwaggerModule.createDocument(app, config);
}

/** Builds and mounts the OpenAPI document, returning it for offline export. */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup(SWAGGER_PATH, app, document);
  return document;
}
