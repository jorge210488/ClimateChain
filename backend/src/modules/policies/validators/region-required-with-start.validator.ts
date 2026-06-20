import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

/**
 * Validates that whenever a `requestedStartTimestamp` is supplied, a non-empty
 * `region` is supplied too.
 *
 * The on-chain contract can only honor an explicit start through the
 * metadata-aware path (`createPolicyWithMetadata`), which requires a non-zero
 * region code. The legacy path (`createPolicy`) ignores any caller-provided
 * start and derives its own. So a start without a region cannot be executed
 * cleanly and is rejected at the HTTP boundary rather than silently dropped.
 */
export function RequiresRegion(
  regionProperty: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "requiresRegion",
      target: object.constructor,
      propertyName,
      constraints: [regionProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (value === undefined || value === null) {
            return true; // No explicit start requested -> coupling not required.
          }
          const [regionProp] = args.constraints as [string];
          const region = (args.object as Record<string, unknown>)[regionProp];
          return typeof region === "string" && region.trim().length > 0;
        },
        defaultMessage(args: ValidationArguments): string {
          const [regionProp] = args.constraints as [string];
          return (
            `requestedStartTimestamp requires ${regionProp} to be provided ` +
            `(an explicit start is only honored on the on-chain metadata path)`
          );
        },
      },
    });
  };
}
