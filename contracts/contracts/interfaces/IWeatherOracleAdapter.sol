// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

/// @title IWeatherOracleAdapter
/// @notice Interface boundary for oracle adapters that push weather data to policies.
/// @author ClimateChain
interface IWeatherOracleAdapter {
  /// @notice Pushes rainfall data for one policy.
  /// @param policyAddress Target policy contract address.
  /// @param rainfallMm Rainfall value in millimeters.
  function pushWeatherData(address policyAddress, uint256 rainfallMm) external;
}
