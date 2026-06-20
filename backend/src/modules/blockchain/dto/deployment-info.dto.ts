import { ApiProperty } from "@nestjs/swagger";

import { ContractRegistrySnapshot } from "../contract-registry.types";

/**
 * Public, read-only view of the loaded on-chain integration metadata.
 * Filesystem paths from the internal snapshot are intentionally omitted.
 */
export class DeploymentInfoResponse {
  @ApiProperty({ example: "hardhat", description: "Target network key." })
  network!: string;

  @ApiProperty({ example: "31337", description: "Chain id from the manifest." })
  chainId!: string;

  @ApiProperty({
    example: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    description: "Provider/factory contract address.",
  })
  providerAddress!: string;

  @ApiProperty({
    required: false,
    enum: ["manifest", "config-override"],
    description:
      "Where the provider address was resolved from. Omitted on deployed " +
      "profiles (staging/testnet/production) as an internal provenance detail.",
  })
  providerAddressSource?: ContractRegistrySnapshot["providerAddressSource"];

  @ApiProperty({
    required: false,
    nullable: true,
    example: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    description:
      "Weather oracle adapter address, when present in the manifest.",
  })
  oracleAddress?: string;

  @ApiProperty({
    type: [String],
    example: ["InsuranceProvider", "InsurancePolicy"],
    description: "Contracts whose ABIs are loaded and available.",
  })
  loadedContracts!: string[];

  static fromSnapshot(
    snapshot: ContractRegistrySnapshot,
    options: { includeProviderAddressSource: boolean } = {
      includeProviderAddressSource: true,
    },
  ): DeploymentInfoResponse {
    const response: DeploymentInfoResponse = {
      network: snapshot.network,
      chainId: snapshot.chainId,
      providerAddress: snapshot.providerAddress,
      oracleAddress: snapshot.oracleAddress,
      loadedContracts: snapshot.loadedContracts,
    };
    if (options.includeProviderAddressSource) {
      response.providerAddressSource = snapshot.providerAddressSource;
    }
    return response;
  }
}
