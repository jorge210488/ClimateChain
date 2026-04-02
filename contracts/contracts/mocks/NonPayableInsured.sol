// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {IInsuranceProviderCreatePolicy} from "../interfaces/IInsuranceProviderCreatePolicy.sol";

/// @title NonPayableInsured
/// @notice Test helper that can buy policies but intentionally cannot receive plain ETH transfers.
/// @author ClimateChain
contract NonPayableInsured {
  /// @notice Creates a policy in provider using this contract as insured beneficiary.
  /// @param providerAddress Provider contract address.
  /// @param coverageAmountWei Coverage amount requested.
  /// @param rainfallThresholdMm Rainfall trigger threshold.
  /// @param durationDays Policy duration in days.
  /// @return policyAddress Newly created policy address.
  function createPolicy(
    address providerAddress,
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays
  ) external payable returns (address policyAddress) {
    return
      IInsuranceProviderCreatePolicy(providerAddress).createPolicy{value: msg.value}(
        coverageAmountWei,
        rainfallThresholdMm,
        durationDays
      );
  }
}
