import { CustomDecorator, SetMetadata } from "@nestjs/common";

import { ROLES_KEY } from "../constants";

/** Roles recognized by the platform. Extended as administrative scopes grow. */
export type AppRole = "admin";

/** Restricts a route to principals holding at least one of the given roles. */
export const Roles = (...roles: AppRole[]): CustomDecorator =>
  SetMetadata(ROLES_KEY, roles);
