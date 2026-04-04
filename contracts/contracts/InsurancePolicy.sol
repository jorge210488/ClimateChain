// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInsurancePolicy} from "./interfaces/IInsurancePolicy.sol";

/// @title InsurancePolicy
/// @notice Represents one parametric policy lifecycle managed by InsuranceProvider.
/// @author ClimateChain
contract InsurancePolicy is Ownable, ReentrancyGuard, IInsurancePolicy {
  /// @notice Policy lifecycle status used by provider/oracle flows.
  enum PolicyStatus {
    /// @notice Policy deployed but not activated with premium.
    Created,
    /// @notice Policy activated and weather window checks are allowed.
    Active,
    /// @notice Trigger condition met and payout path is enabled.
    Triggered,
    /// @notice Coverage payout executed successfully.
    PaidOut,
    /// @notice Policy expired without payout execution.
    Expired
  }

  /// @notice Address that receives coverage payout when policy is triggered.
  address payable public insured;
  /// @notice Authorized oracle address that can fulfill weather data.
  address public oracle;
  /// @notice Premium amount required for policy activation.
  uint256 public premiumWei;
  /// @notice Coverage amount reserved for payout.
  uint256 public coverageWei;
  /// @notice Rainfall trigger threshold in millimeters.
  uint256 public rainfallThresholdMm;
  /// @notice Policy weather window start timestamp.
  uint64 public startTimestamp;
  /// @notice Policy weather window end timestamp.
  uint64 public endTimestamp;
  /// @notice Timestamp of latest oracle update.
  uint64 public lastOracleUpdateTimestamp;
  /// @notice Latest rainfall value submitted by oracle.
  uint256 public latestRainfallMm;
  /// @notice True when rainfall threshold has been met.
  bool public conditionMet;
  /// @notice Current policy status.
  PolicyStatus public status;

  error InvalidInsuredAddress();
  error InvalidPolicyWindow(uint64 startTimestamp, uint64 endTimestamp);
  error InvalidCoverageAmount();
  error InvalidPremiumAmount();
  error InvalidRainfallThreshold();
  error InvalidOracleAddress();
  error CoverageReserveMismatch(uint256 expected, uint256 received);
  error PremiumMismatch(uint256 expected, uint256 received);
  error OracleOnly(address caller);
  error InvalidStatus(uint8 expected, uint8 actual);
  error PolicyNotActivated();
  error PolicyAlreadySettled();
  error PolicyNotEnded(uint64 currentTimestamp, uint64 endTimestamp);
  error PolicyOutsideWeatherWindow(
    uint64 currentTimestamp,
    uint64 startTimestamp,
    uint64 endTimestamp
  );
  error TriggeredPolicyRequiresPayout();
  error EthTransferFailed();

  modifier onlyOracle() {
    if (msg.sender != oracle) revert OracleOnly(msg.sender);
    _;
  }

  /// @notice Deploys a new policy with immutable core parameters and locked coverage reserve.
  /// @param policyOwner Provider contract that controls lifecycle transitions.
  /// @param insuredAddress Recipient of payout when trigger condition is met.
  /// @param oracleAddress Authorized weather oracle address for updates.
  /// @param premiumAmountWei Premium amount required to activate policy.
  /// @param coverageAmountWei Coverage amount reserved for payout.
  /// @param rainfallThresholdMm_ Trigger threshold in millimeters.
  /// @param startTimestamp_ Policy window start timestamp.
  /// @param endTimestamp_ Policy window end timestamp.
  constructor(
    address policyOwner,
    address payable insuredAddress,
    address oracleAddress,
    uint256 premiumAmountWei,
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm_,
    uint64 startTimestamp_,
    uint64 endTimestamp_
  ) payable Ownable(policyOwner) {
    if (insuredAddress == address(0)) revert InvalidInsuredAddress();
    if (oracleAddress == address(0) || oracleAddress.code.length == 0)
      revert InvalidOracleAddress();
    if (coverageAmountWei == 0) revert InvalidCoverageAmount();
    if (premiumAmountWei == 0) revert InvalidPremiumAmount();
    if (rainfallThresholdMm_ == 0) revert InvalidRainfallThreshold();
    // solhint-disable-next-line gas-strict-inequalities
    if (startTimestamp_ >= endTimestamp_)
      revert InvalidPolicyWindow(startTimestamp_, endTimestamp_);
    if (msg.value != coverageAmountWei)
      revert CoverageReserveMismatch(coverageAmountWei, msg.value);

    insured = insuredAddress;
    oracle = oracleAddress;
    premiumWei = premiumAmountWei;
    coverageWei = coverageAmountWei;
    rainfallThresholdMm = rainfallThresholdMm_;
    startTimestamp = startTimestamp_;
    endTimestamp = endTimestamp_;
    status = PolicyStatus.Created;
  }

  /// @notice Activates policy after receiving exact premium amount.
  function activate() external payable onlyOwner {
    _requireStatus(PolicyStatus.Created);
    if (msg.value != premiumWei) revert PremiumMismatch(premiumWei, msg.value);

    _transitionTo(PolicyStatus.Active);
    emit PolicyActivated(insured, premiumWei, coverageWei);
  }

  /// @notice Emits weather request event while policy remains inside active window.
  function requestWeatherData() external onlyOwner {
    _requireStatus(PolicyStatus.Active);
    _requireWeatherWindowOpen();
    emit WeatherDataRequested(address(this), uint64(block.timestamp));
  }

  /// @notice Stores oracle weather input and marks policy as triggered when threshold is met.
  /// @param rainfallMm Observed rainfall value in millimeters.
  function fulfillWeatherData(uint256 rainfallMm) external onlyOracle {
    _requireStatus(PolicyStatus.Active);
    _requireWeatherWindowOpen();

    latestRainfallMm = rainfallMm;
    lastOracleUpdateTimestamp = uint64(block.timestamp);
    // solhint-disable-next-line gas-strict-inequalities
    conditionMet = rainfallMm >= rainfallThresholdMm;

    if (conditionMet) {
      _transitionTo(PolicyStatus.Triggered);
    }

    emit WeatherDataFulfilled(rainfallMm, conditionMet, lastOracleUpdateTimestamp);
  }

  /// @notice Executes payout to insured and forwards any remaining balance to provider.
  function executePayout() external onlyOwner nonReentrant {
    _requireStatus(PolicyStatus.Triggered);

    _transitionTo(PolicyStatus.PaidOut);
    emit PayoutExecuted(insured, coverageWei, uint64(block.timestamp));

    (bool success, ) = insured.call{value: coverageWei}("");
    if (!success) revert EthTransferFailed();

    _forwardBalanceToOwner();
  }

  /// @notice Expires policy after end timestamp and forwards all remaining funds to provider.
  function expirePolicy() external onlyOwner nonReentrant {
    uint64 currentTimestamp = uint64(block.timestamp);

    if (status == PolicyStatus.Created) revert PolicyNotActivated();
    if (status == PolicyStatus.PaidOut || status == PolicyStatus.Expired)
      revert PolicyAlreadySettled();
    if (status == PolicyStatus.Triggered) revert TriggeredPolicyRequiresPayout();
    if (currentTimestamp < endTimestamp) revert PolicyNotEnded(currentTimestamp, endTimestamp);

    _transitionTo(PolicyStatus.Expired);
    emit PolicyExpired(insured, currentTimestamp);
    _forwardBalanceToOwner();
  }

  /// @notice Returns current ETH balance held by this policy contract.
  /// @return Current on-chain balance in wei.
  function getCurrentBalance() external view returns (uint256) {
    return address(this).balance;
  }

  /// @notice Returns current policy status as uint8 for interface compatibility.
  /// @return Current status encoded as uint8.
  function getStatus() external view returns (uint8) {
    return uint8(status);
  }

  /// @notice Returns true when policy can be settled via payout execution.
  /// @return True when status is Triggered.
  function isPayoutEligible() external view returns (bool) {
    return status == PolicyStatus.Triggered;
  }

  /// @notice Returns true when policy can be settled via expiry path.
  /// @return True when policy is active and end timestamp has been reached.
  function isExpiryEligible() external view returns (bool) {
    // solhint-disable-next-line gas-strict-inequalities
    return status == PolicyStatus.Active && block.timestamp >= endTimestamp;
  }

  /// @notice Returns true when weather requests and fulfills are allowed.
  /// @return True when current timestamp is inside inclusive-start and exclusive-end window.
  function isWeatherWindowOpen() external view returns (bool) {
    return status == PolicyStatus.Active && _isWeatherWindowOpenAt(uint64(block.timestamp));
  }

  /// @notice Applies status transition and emits a canonical transition event.
  /// @param newStatus New status to set.
  function _transitionTo(PolicyStatus newStatus) private {
    uint8 previousStatus = uint8(status);
    status = newStatus;
    emit PolicyStatusTransitioned(previousStatus, uint8(newStatus), uint64(block.timestamp));
  }

  /// @notice Forwards any remaining policy ETH balance to provider owner.
  function _forwardBalanceToOwner() private {
    uint256 amountWei = address(this).balance;
    if (amountWei == 0) return;

    (bool success, ) = owner().call{value: amountWei}("");
    if (!success) revert EthTransferFailed();
  }

  /// @notice Ensures policy is currently in the expected status.
  /// @param expectedStatus Required current status.
  function _requireStatus(PolicyStatus expectedStatus) private view {
    if (status != expectedStatus) revert InvalidStatus(uint8(expectedStatus), uint8(status));
  }

  /// @notice Ensures weather operations happen within [startTimestamp, endTimestamp).
  function _requireWeatherWindowOpen() private view {
    uint64 currentTimestamp = uint64(block.timestamp);

    if (!_isWeatherWindowOpenAt(currentTimestamp)) {
      revert PolicyOutsideWeatherWindow(currentTimestamp, startTimestamp, endTimestamp);
    }
  }

  /// @notice Returns true when timestamp is within policy weather window bounds.
  /// @param currentTimestamp Timestamp candidate in unix seconds.
  /// @return True when inside [startTimestamp, endTimestamp).
  function _isWeatherWindowOpenAt(uint64 currentTimestamp) private view returns (bool) {
    // solhint-disable-next-line gas-strict-inequalities
    return currentTimestamp >= startTimestamp && currentTimestamp < endTimestamp;
  }
}
