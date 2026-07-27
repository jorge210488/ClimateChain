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
  /// @return Newly created policy address.
  function createPolicy(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays
  ) external payable returns (address);

  /// @notice Creates a policy with explicit risk-bucket metadata, requested start, and beneficiary.
  /// @param coverageAmountWei Coverage amount requested.
  /// @param rainfallThresholdMm Rainfall trigger threshold.
  /// @param durationDays Policy duration in days.
  /// @param regionCode Region/risk-bucket code used by downstream off-chain systems.
  /// @param requestedStartTimestamp Requested policy start timestamp.
  /// @param insuredAddress Account that receives payout, which need not be the caller.
  /// @return Newly created policy address.
  function createPolicyWithMetadata(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays,
    bytes32 regionCode,
    uint64 requestedStartTimestamp,
    address insuredAddress
  ) external payable returns (address);
}
