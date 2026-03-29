// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

/// @title IInsuranceProviderRegistry
/// @notice Minimal provider registry interface used by mock oracle provenance checks.
/// @author ClimateChain
interface IInsuranceProviderRegistry {
  /// @notice Returns whether policy address was created by provider instance.
  /// @param policyAddress Candidate policy contract address.
  /// @return True when policy is known in provider registry.
  function isPolicyCreated(address policyAddress) external view returns (bool);
}
