import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
} from "@nestjs/terminus";

import { Public } from "../../common/decorators/public.decorator";
import { ChainHealthIndicator } from "./indicators/chain.health";
import { ConfigHealthIndicator } from "./indicators/config.health";
import { ContractRegistryHealthIndicator } from "./indicators/contract-registry.health";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly registryIndicator: ContractRegistryHealthIndicator,
    private readonly configIndicator: ConfigHealthIndicator,
    private readonly chainIndicator: ChainHealthIndicator,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: "Liveness probe",
    description: "Returns ok when the process is running and able to respond.",
  })
  liveness(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  @Public()
  @Get("ready")
  @HealthCheck()
  @ApiOperation({
    summary: "Readiness probe",
    description:
      "Verifies the runtime dependencies this service needs to serve traffic: " +
      "validated configuration, loaded on-chain integration metadata, and a " +
      "reachable chain. Returns 503 with diagnostics when a dependency is " +
      "unhealthy.",
  })
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.configIndicator.isHealthy("config"),
      () => this.registryIndicator.isHealthy("contract-registry"),
      () => this.chainIndicator.isHealthy("chain"),
    ]);
  }
}
