/**
 * Fails if the committed OpenAPI document is out of date relative to the current
 * controllers/DTOs. Run as part of the local Stage 05 gate so it is equivalent
 * to CI. Comparison is line-ending tolerant (CRLF normalized to LF).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "../src/app.module";
import { buildOpenApiDocument } from "../src/app-setup";

async function main(): Promise<void> {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    await app.init();
    const document = buildOpenApiDocument(app);
    const generated = `${JSON.stringify(document, null, 2)}\n`;

    const file = resolve(
      process.cwd(),
      "..",
      "docs",
      "api",
      "backend-openapi.json",
    );
    const committed = readFileSync(file, "utf-8").replace(/\r\n/g, "\n");

    if (committed !== generated) {
      throw new Error(
        "OpenAPI drift detected: docs/api/backend-openapi.json is out of date. " +
          "Run 'npm run api:export' and commit the result.",
      );
    }

    console.log("api:check OK: OpenAPI document is up to date");
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      "api:check FAILED:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
