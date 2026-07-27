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

  /// @notice Creates a policy with explicit region and requested-start metadata.
  /// @param providerAddress Provider contract address.
  /// @param coverageAmountWei Coverage amount requested.
  /// @param rainfallThresholdMm Rainfall trigger threshold.
  /// @param durationDays Policy duration in days.
  /// @param regionCode Region/risk-bucket code used by downstream consumers.
  /// @param requestedStartTimestamp Requested policy start timestamp.
  /// @return policyAddress Newly created policy address, insured by this contract.
  function createPolicyWithMetadata(
    address providerAddress,
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays,
    bytes32 regionCode,
    uint64 requestedStartTimestamp
  ) external payable returns (address policyAddress) {
    return
      IInsuranceProviderCreatePolicy(providerAddress).createPolicyWithMetadata{value: msg.value}(
        coverageAmountWei,
        rainfallThresholdMm,
        durationDays,
        regionCode,
        requestedStartTimestamp,
        // This contract names itself: these mocks exist to exercise a policy
        // whose beneficiary cannot receive ETH, which only works if the
        // beneficiary is the mock rather than the account driving the test.
        address(this)
      );
  }
}
