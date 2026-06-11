import { createParamDecorator, ExecutionContext } from "@nestjs/common";

import { AuthenticatedUser } from "./auth.types";

/** Injects the authenticated principal attached by the JWT strategy. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
