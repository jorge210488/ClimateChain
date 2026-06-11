/**
 * Exports the backend OpenAPI document to `docs/api/backend-openapi.json`,
 * mirroring the contracts module's artifact-export pattern so downstream
 * consumers have a committed, reviewable API contract.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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

    const outDir = resolve(process.cwd(), "..", "docs", "api");
    mkdirSync(outDir, { recursive: true });
    const outFile = resolve(outDir, "backend-openapi.json");
    writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`, "utf-8");

    console.log(`OpenAPI document written to ${outFile}`);
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      "export-openapi FAILED:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
