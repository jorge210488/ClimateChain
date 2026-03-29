// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IInsurancePolicy} from "../interfaces/IInsurancePolicy.sol";

/// @title MockWeatherOracle
/// @notice Local oracle mock used to push weather updates in test and local development flows.
/// @author ClimateChain
contract MockWeatherOracle is Ownable {
  /// @notice Last rainfall value stored per policy by this mock.
  mapping(address => uint256) public lastRainfallMmByPolicy;
  /// @notice Last update timestamp stored per policy by this mock.
  mapping(address => uint64) public lastUpdatedAtByPolicy;

  /// @notice Emitted when mock pushes weather data to policy.
  /// @param policyAddress Target policy address.
  /// @param rainfallMm Rainfall value pushed in millimeters.
  /// @param pushedAt Timestamp when weather data was pushed.
  event WeatherDataPushed(address indexed policyAddress, uint256 rainfallMm, uint64 pushedAt);

  error InvalidPolicyAddress(address policyAddress);

  /// @notice Creates mock oracle with explicit owner.
  /// @param initialOwner Address receiving oracle admin permissions.
  constructor(address initialOwner) Ownable(initialOwner) {}

  /// @notice Pushes rainfall data to policy and records local mock snapshot.
  /// @param policyAddress Target policy contract address.
  /// @param rainfallMm Rainfall value in millimeters.
  function pushWeatherData(address policyAddress, uint256 rainfallMm) external onlyOwner {
    _assertValidPolicyAddress(policyAddress);
    IInsurancePolicy(policyAddress).fulfillWeatherData(rainfallMm);

    lastRainfallMmByPolicy[policyAddress] = rainfallMm;
    lastUpdatedAtByPolicy[policyAddress] = uint64(block.timestamp);

    emit WeatherDataPushed(policyAddress, rainfallMm, uint64(block.timestamp));
  }

  function _assertValidPolicyAddress(address policyAddress) private view {
    if (policyAddress == address(0) || policyAddress.code.length == 0) {
      revert InvalidPolicyAddress(policyAddress);
    }

    bytes memory statusResponse = _readSelectorResponse(
      policyAddress,
      IInsurancePolicy.getStatus.selector
    );
    bytes memory oracleResponse = _readSelectorResponse(
      policyAddress,
      IInsurancePolicy.oracle.selector
    );
    _readSelectorResponse(policyAddress, IInsurancePolicy.premiumWei.selector);
    _readSelectorResponse(policyAddress, IInsurancePolicy.coverageWei.selector);
    bytes memory startResponse = _readSelectorResponse(
      policyAddress,
      IInsurancePolicy.startTimestamp.selector
    );
    bytes memory endResponse = _readSelectorResponse(
      policyAddress,
      IInsurancePolicy.endTimestamp.selector
    );
    _readSelectorResponse(policyAddress, IInsurancePolicy.conditionMet.selector);

    uint8 policyStatus = abi.decode(statusResponse, (uint8));
    address policyOracle = abi.decode(oracleResponse, (address));
    uint64 startTimestamp = abi.decode(startResponse, (uint64));
    uint64 endTimestamp = abi.decode(endResponse, (uint64));

    if (policyStatus > 4 || policyOracle != address(this) || !(startTimestamp < endTimestamp)) {
      revert InvalidPolicyAddress(policyAddress);
    }
  }

  function _readSelectorResponse(
    address policyAddress,
    bytes4 selector
  ) private view returns (bytes memory response) {
    (bool success, bytes memory returnedData) = policyAddress.staticcall(
      abi.encodeWithSelector(selector)
    );

    if (!success || returnedData.length != 32) {
      revert InvalidPolicyAddress(policyAddress);
    }

    return returnedData;
  }
}
