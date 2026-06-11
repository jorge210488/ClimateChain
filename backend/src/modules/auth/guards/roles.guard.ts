import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ROLES_KEY } from "../../../common/constants";
import { AppRole } from "../../../common/decorators/roles.decorator";
import { AuthenticatedUser } from "../auth.types";

/**
 * Global authorization guard. Enforces `@Roles(...)` requirements against the
 * authenticated principal. Routes without role metadata are unaffected.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AppRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const roles = request.user?.roles ?? [];
    const authorized = roles.some((role) => requiredRoles.includes(role));

    if (!authorized) {
      throw new ForbiddenException(
        `Requires one of the following roles: ${requiredRoles.join(", ")}`,
      );
    }

    return true;
  }
}
