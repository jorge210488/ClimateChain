// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IInsurancePolicy} from "../interfaces/IInsurancePolicy.sol";

contract MockWeatherOracle is Ownable {
  mapping(address => uint256) public lastRainfallMmByPolicy;
  mapping(address => uint64) public lastUpdatedAtByPolicy;

  event WeatherDataPushed(address indexed policyAddress, uint256 rainfallMm, uint64 pushedAt);

  error InvalidPolicyAddress(address policyAddress);

  constructor(address initialOwner) Ownable(initialOwner) {}

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

    (bool success, bytes memory response) = policyAddress.staticcall(
      abi.encodeWithSelector(IInsurancePolicy.getStatus.selector)
    );

    if (!success || response.length != 32) {
      revert InvalidPolicyAddress(policyAddress);
    }
  }
}
