// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IInsurancePolicy} from "../interfaces/IInsurancePolicy.sol";
import {IInsuranceProviderRegistry} from "../interfaces/IInsuranceProviderRegistry.sol";
import {IWeatherOracleAdapter} from "../interfaces/IWeatherOracleAdapter.sol";

/// @title MockWeatherOracle
/// @notice Local oracle mock used to push weather updates in test and local development flows.
/// @author ClimateChain
contract MockWeatherOracle is Ownable, IWeatherOracleAdapter {
  // 4 maps to InsurancePolicy.PolicyStatus.Expired (max valid status value).
  uint8 private constant MAX_POLICY_STATUS = 4;

  /// @notice Last rainfall value stored per policy by this mock.
  mapping(address => uint256) public lastRainfallMmByPolicy;
  /// @notice Last update timestamp stored per policy by this mock.
  mapping(address => uint64) public lastUpdatedAtByPolicy;
  /// @notice Optional provider registry used to assert that policies were created by trusted provider.
  address public policyRegistry;

  /// @notice Emitted when mock pushes weather data to policy.
  /// @param policyAddress Target policy address.
  /// @param rainfallMm Rainfall value pushed in millimeters.
  /// @param pushedAt Timestamp when weather data was pushed.
  event WeatherDataPushed(address indexed policyAddress, uint256 rainfallMm, uint64 pushedAt);
  /// @notice Emitted when trusted policy registry is updated.
  /// @param previousRegistry Previous registry address.
  /// @param newRegistry New registry address.
  event PolicyRegistryUpdated(address indexed previousRegistry, address indexed newRegistry);

  error InvalidPolicyAddress(address policyAddress);
  error InvalidPolicyRegistry(address registryAddress);

  /// @notice Creates mock oracle with explicit owner.
  /// @param initialOwner Address receiving oracle admin permissions.
  constructor(address initialOwner) Ownable(initialOwner) {}

  /// @notice Pushes rainfall data to policy and records local mock snapshot.
  /// @param policyAddress Target policy contract address.
  /// @param rainfallMm Rainfall value in millimeters.
  function pushWeatherData(address policyAddress, uint256 rainfallMm) external onlyOwner {
    _assertValidPolicyAddress(policyAddress);

    // Execute policy transition first; if policy rejects update, local snapshot must remain unchanged.
    // This is safe in mock context: onlyOwner call, no ETH transfer, and no trusted callback path into oracle.
    IInsurancePolicy(policyAddress).fulfillWeatherData(rainfallMm);

    lastRainfallMmByPolicy[policyAddress] = rainfallMm;
    lastUpdatedAtByPolicy[policyAddress] = uint64(block.timestamp);

    emit WeatherDataPushed(policyAddress, rainfallMm, uint64(block.timestamp));
  }

  /// @notice Sets optional provider registry to validate policy provenance.
  /// @param newPolicyRegistry Provider contract exposing isPolicyCreated(address).
  function setPolicyRegistry(address newPolicyRegistry) external onlyOwner {
    if (newPolicyRegistry != address(0) && newPolicyRegistry.code.length == 0) {
      revert InvalidPolicyRegistry(newPolicyRegistry);
    }

    address previousRegistry = policyRegistry;
    policyRegistry = newPolicyRegistry;

    emit PolicyRegistryUpdated(previousRegistry, newPolicyRegistry);
  }

  /// @notice Validates candidate policy shape, oracle binding, and optional registry provenance.
  /// @param policyAddress Candidate policy contract address.
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
    // Shape validation only; values are intentionally discarded.
    _readSelectorResponse(policyAddress, IInsurancePolicy.premiumWei.selector);
    // Shape validation only; values are intentionally discarded.
    _readSelectorResponse(policyAddress, IInsurancePolicy.coverageWei.selector);
    bytes memory startResponse = _readSelectorResponse(
      policyAddress,
      IInsurancePolicy.startTimestamp.selector
    );
    bytes memory endResponse = _readSelectorResponse(
      policyAddress,
      IInsurancePolicy.endTimestamp.selector
    );
    // Shape validation only; values are intentionally discarded.
    _readSelectorResponse(policyAddress, IInsurancePolicy.conditionMet.selector);

    uint8 policyStatus = abi.decode(statusResponse, (uint8));
    address policyOracle = abi.decode(oracleResponse, (address));
    uint64 startTimestamp = abi.decode(startResponse, (uint64));
    uint64 endTimestamp = abi.decode(endResponse, (uint64));

    if (policyRegistry != address(0) && !_isKnownPolicy(policyAddress)) {
      revert InvalidPolicyAddress(policyAddress);
    }

    // This validates status enum range only; active-state enforcement is delegated to policy guards.
    if (
      policyStatus > MAX_POLICY_STATUS ||
      policyOracle != address(this) ||
      // solhint-disable-next-line gas-strict-inequalities
      startTimestamp >= endTimestamp
    ) {
      revert InvalidPolicyAddress(policyAddress);
    }
  }

  /// @notice Checks whether policy is registered in configured provider registry.
  /// @param policyAddress Candidate policy contract address.
  /// @return True when provider registry reports policy as created.
  function _isKnownPolicy(address policyAddress) private view returns (bool) {
    (bool success, bytes memory response) = policyRegistry.staticcall(
      abi.encodeCall(IInsuranceProviderRegistry.isPolicyCreated, (policyAddress))
    );

    if (!success || response.length != 32) return false;

    return abi.decode(response, (bool));
  }

  /// @notice Reads one selector response from target policy and enforces 32-byte ABI return shape.
  /// @param policyAddress Target policy address.
  /// @param selector Function selector to read with staticcall.
  /// @return response Raw returned data from selector call.
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
