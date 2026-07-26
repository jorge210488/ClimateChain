import { Injectable } from "@nestjs/common";
import { Contract, Interface, InterfaceAbi } from "ethers";

import { ChainProviderService } from "./chain-provider.service";
import { ContractRegistryService } from "./contract-registry.service";

/** Contract names the registry guarantees are loaded. */
export const PROVIDER_CONTRACT = "InsuranceProvider";
export const POLICY_CONTRACT = "InsurancePolicy";

/**
 * Builds ethers `Contract` instances from the ABIs the registry validated at
 * boot, so the chain client and the Stage 04 artifacts cannot drift: there is
 * no second copy of an ABI anywhere in the backend.
 *
 * Read instances are bound to the provider and write instances to the signer.
 * Keeping them separate means a read path cannot accidentally acquire signing
 * capability by holding the wrong object.
 */
@Injectable()
export class ContractFactoryService {
  private readonly interfaces = new Map<string, Interface>();

  constructor(
    private readonly registry: ContractRegistryService,
    private readonly chain: ChainProviderService,
  ) {}

  /** Read-only provider contract at the address resolved from the manifest. */
  getProviderReader(): Contract {
    return new Contract(
      this.registry.getProviderAddress(),
      this.abi(PROVIDER_CONTRACT),
      this.chain.getProvider(),
    );
  }

  /** Provider contract bound to the signer; use only for writes. */
  getProviderWriter(): Contract {
    return new Contract(
      this.registry.getProviderAddress(),
      this.abi(PROVIDER_CONTRACT),
      this.chain.getSigner(),
    );
  }

  /** Read-only policy contract at an arbitrary deployed policy address. */
  getPolicyReader(address: string): Contract {
    return new Contract(
      address,
      this.abi(POLICY_CONTRACT),
      this.chain.getProvider(),
    );
  }

  /**
   * Returns the parsed interface for a contract, cached.
   *
   * Parsing an ABI is not free and revert decoding needs the interface on every
   * failed call, so caching keeps error handling from becoming the expensive
   * path.
   */
  getInterface(contractName: string): Interface {
    const cached = this.interfaces.get(contractName);
    if (cached) {
      return cached;
    }

    const parsed = new Interface(this.abi(contractName));
    this.interfaces.set(contractName, parsed);
    return parsed;
  }

  private abi(contractName: string): InterfaceAbi {
    return this.registry.getAbi(contractName) as unknown as InterfaceAbi;
  }
}
