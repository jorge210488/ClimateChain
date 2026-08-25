import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { Logger } from "nestjs-pino";

import { AppConfigService } from "./config/app-config.service";

/** Path where interactive API docs are served. */
export const SWAGGER_PATH = "docs";

/**
 * Creation options shared by every entry point that serves HTTP (bootstrap,
 * startup check, e2e), so they exercise identical wiring.
 *
 * `bodyParser: false` is load-bearing: Nest otherwise registers its own JSON
 * parser at its default limit, which consumes the body before any parser added
 * later can see it. Registering ours in {@link configureApp} instead is what
 * makes `MAX_REQUEST_BODY_SIZE` actually authoritative rather than inert.
 */
export const HTTP_APP_OPTIONS = {
  bufferLogs: true,
  bodyParser: false,
} as const;

/**
 * Applies runtime concerns shared by the HTTP server and tooling: the pino
 * logger, security headers, CORS policy, body limits, and graceful shutdown
 * hooks. Global pipe/filter/guards are registered in {@link AppModule} so they
 * also apply under test.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfigService);
  const { corsOrigins, maxRequestBodySize } = config.app;

  app.useLogger(app.get(Logger));

  // Baseline security headers. `contentSecurityPolicy` is left at helmet's
  // default; Swagger UI is served from the same origin so it is unaffected.
  // Applied before anything reads a client address. The rate limiter keys on
  // what Express reports, so behind a proxy without this every caller shares
  // the proxy's budget; with it wrongly enabled, every caller can forge one.
  const { trustProxy } = config.app;
  if (trustProxy !== undefined) {
    const parsed = /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy;
    app.getHttpAdapter().getInstance().set("trust proxy", parsed);
  }

  app.use(helmet());

  // An empty allowlist reflects any origin, which only local/dev/test may do —
  // `configuration.ts` refuses to boot a deployed profile without CORS_ORIGINS.
  app.enableCors(
    corsOrigins.length > 0 ? { origin: corsOrigins, credentials: true } : {},
  );

  // Bound request bodies explicitly: every endpoint takes small JSON documents.
  app.use(json({ limit: maxRequestBodySize }));
  app.use(urlencoded({ extended: true, limit: maxRequestBodySize }));

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

/**
 * Mounts the OpenAPI document when the profile allows it, returning the
 * document (or `undefined` when docs are disabled).
 *
 * Swagger is mounted outside the guard chain, so `/docs` and `/docs-json` are
 * anonymous by construction: they enumerate every route, payload shape, and
 * error contract. Deployed profiles therefore opt in via `SWAGGER_ENABLED`
 * rather than serving them by default. Disabling the mount costs nothing
 * offline — `api:export` and `api:check` use {@link buildOpenApiDocument},
 * which never mounts.
 */
export function setupSwagger(app: INestApplication): OpenAPIObject | undefined {
  if (!app.get(AppConfigService).app.swaggerEnabled) {
    return undefined;
  }

  const document = buildOpenApiDocument(app);
  SwaggerModule.setup(SWAGGER_PATH, app, document);
  return document;
}
