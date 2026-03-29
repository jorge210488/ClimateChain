// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

interface IInsurancePolicy {
  function activate() external payable;

  function requestWeatherData() external;

  function fulfillWeatherData(uint256 rainfallMm) external;

  function executePayout() external;

  function expirePolicy() external;

  function getStatus() external view returns (uint8);

  function conditionMet() external view returns (bool);

  function premiumWei() external view returns (uint256);

  function coverageWei() external view returns (uint256);

  function startTimestamp() external view returns (uint64);

  function endTimestamp() external view returns (uint64);
}
