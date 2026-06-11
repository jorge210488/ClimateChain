import { AppRole } from "../../common/decorators/roles.decorator";

/** Claims embedded in issued JWTs. */
export interface JwtPayload {
  sub: string;
  roles: AppRole[];
}

/** Authenticated principal attached to the request after JWT validation. */
export interface AuthenticatedUser {
  userId: string;
  roles: AppRole[];
}
