import { CustomDecorator, SetMetadata } from "@nestjs/common";

import { IS_PUBLIC_KEY } from "../constants";

/**
 * Marks a route handler (or controller) as public so the global JWT guard
 * allows unauthenticated access.
 */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);
