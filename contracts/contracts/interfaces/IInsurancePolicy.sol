// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

/// @title IInsurancePolicy
/// @notice Interface for provider and oracle interactions with policy contracts.
/// @author ClimateChain
interface IInsurancePolicy {
  /// @notice Activates policy with exact premium payment.
  function activate() external payable;

  /// @notice Requests weather data update while policy window is open.
  function requestWeatherData() external;

  /// @notice Pushes weather data into policy state.
  /// @param rainfallMm Observed rainfall amount in millimeters.
  function fulfillWeatherData(uint256 rainfallMm) external;

  /// @notice Executes payout when policy has been triggered.
  function executePayout() external;

  /// @notice Expires policy after policy window end.
  function expirePolicy() external;

  /// @notice Returns current policy status encoded as uint8.
  /// @return Current status value.
  function getStatus() external view returns (uint8);

  /// @notice Returns oracle address authorized to fulfill weather data.
  /// @return Oracle account address.
  function oracle() external view returns (address);

  /// @notice Indicates whether trigger condition has been met.
  /// @return True when rainfall threshold condition has been met.
  function conditionMet() external view returns (bool);

  /// @notice Returns policy premium amount.
  /// @return Premium amount in wei.
  function premiumWei() external view returns (uint256);

  /// @notice Returns policy coverage amount.
  /// @return Coverage amount in wei.
  function coverageWei() external view returns (uint256);

  /// @notice Returns policy start timestamp.
  /// @return Start timestamp as unix seconds.
  function startTimestamp() external view returns (uint64);

  /// @notice Returns policy end timestamp.
  /// @return End timestamp as unix seconds.
  function endTimestamp() external view returns (uint64);
}
