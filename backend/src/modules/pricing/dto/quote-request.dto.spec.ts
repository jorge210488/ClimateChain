import { readFileSync } from "node:fs";
import { join } from "node:path";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

import { QuoteRequestDto } from "./quote-request.dto";

/**
 * Runs the shared pricing-request vectors against this DTO.
 *
 * The ML service runs the identical file. Field names and published limits
 * already matched while the two disagreed on whether a timestamp is a date and
 * on whether a padded region is the same region — agreement on shape is not
 * agreement on behaviour, and only the second one keeps a quote usable.
 *
 * A rule changed on one side and not the other fails here and there.
 */

interface Vector {
  name: string;
  override: Record<string, unknown>;
  expect: "accept" | "reject";
  why?: string;
}

interface VectorDocument {
  base: Record<string, unknown>;
  vectors: Vector[];
}

const VECTORS_PATH = join(
  __dirname,
  "../../../../../shared/contracts/pricing-request-vectors.json",
);

const { base, vectors }: VectorDocument = JSON.parse(
  readFileSync(VECTORS_PATH, "utf8"),
) as VectorDocument;

function validationErrorsFor(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(QuoteRequestDto, payload);
  return validateSync(dto as object).map((error) =>
    JSON.stringify(error.constraints ?? {}),
  );
}

describe("QuoteRequestDto against the shared contract", () => {
  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      const payload = { ...base, ...vector.override };
      const errors = validationErrorsFor(payload);
      const accepted = errors.length === 0;

      expect({ accepted, name: vector.name }).toEqual({
        accepted: vector.expect === "accept",
        name: vector.name,
      });
    },
  );

  it("keeps the region exactly as sent", () => {
    // The region is encoded into a bytes32 code from this value, so trimming it
    // would insure a different region than the one quoted.
    const dto = plainToInstance(QuoteRequestDto, {
      ...base,
      region: "  Valencia  ",
    });

    expect(validateSync(dto as object)).toHaveLength(0);
    expect(dto.region).toBe("  Valencia  ");
  });

  it("exercises the whole vector file", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(25);
    expect(new Set(vectors.map((vector) => vector.expect))).toEqual(
      new Set(["accept", "reject"]),
    );
  });
});
