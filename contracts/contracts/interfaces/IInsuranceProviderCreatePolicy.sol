// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

/// @title IInsuranceProviderCreatePolicy
/// @notice Minimal provider interface for policy creation flows used by test helpers.
/// @author ClimateChain
interface IInsuranceProviderCreatePolicy {
  /// @notice Creates a policy using msg.sender as insured beneficiary.
  /// @param coverageAmountWei Coverage amount requested.
  /// @param rainfallThresholdMm Rainfall trigger threshold.
  /// @param durationDays Policy duration in days.
  /// @return policyAddress Newly created policy address.
  function createPolicy(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays
  ) external payable returns (address policyAddress);
}
