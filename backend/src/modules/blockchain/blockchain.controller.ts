import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { ContractRegistryService } from "./contract-registry.service";
import { DeploymentInfoResponse } from "./dto/deployment-info.dto";

@ApiTags("blockchain")
@Controller("blockchain")
export class BlockchainController {
  constructor(private readonly registry: ContractRegistryService) {}

  @Public()
  @Get("deployment")
  @ApiOperation({
    summary: "Describe the loaded on-chain deployment metadata",
    description:
      "Returns the network, chain id, provider address, and loaded contract " +
      "ABIs resolved from the shared artifacts. Read-only; live RPC calls " +
      "are introduced in Stage 06.",
  })
  @ApiOkResponse({ type: DeploymentInfoResponse })
  getDeployment(): DeploymentInfoResponse {
    return DeploymentInfoResponse.fromSnapshot(this.registry.getSnapshot());
  }
}
