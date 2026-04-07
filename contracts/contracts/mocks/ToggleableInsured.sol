// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {IInsurancePolicy} from "../interfaces/IInsurancePolicy.sol";
import {IInsuranceProviderCreatePolicy} from "../interfaces/IInsuranceProviderCreatePolicy.sol";

/// @title ToggleableInsured
/// @notice Helper mock that can toggle ETH receivability to test deferred payout claim flows.
/// @author ClimateChain
contract ToggleableInsured {
  /// @notice True when contract accepts incoming ETH transfers.
  bool public acceptEther;

  /// @notice Emitted when ETH receivability mode is updated.
  /// @param enabled True when ETH transfers are accepted.
  event AcceptEtherUpdated(bool enabled);

  error EtherReceptionDisabled();

  /// @notice Receives ETH only when receivability mode is enabled.
  receive() external payable {
    if (!acceptEther) revert EtherReceptionDisabled();
  }

  /// @notice Updates ETH receivability behavior for incoming transfers.
  /// @param enabled True to accept ETH, false to reject ETH.
  function setAcceptEther(bool enabled) external {
    acceptEther = enabled;
    emit AcceptEtherUpdated(enabled);
  }

  /// @notice Creates a policy through provider using legacy createPolicy path.
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
  /// @return policyAddress Newly created policy address.
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
        requestedStartTimestamp
      );
  }

  /// @notice Claims deferred payout from a policy where this contract is the insured account.
  /// @param policyAddress Target policy address.
  function claimPendingPayout(address policyAddress) external {
    IInsurancePolicy(policyAddress).claimPendingPayout();
  }
}
