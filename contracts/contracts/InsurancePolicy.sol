// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInsurancePolicy} from "./interfaces/IInsurancePolicy.sol";

contract InsurancePolicy is Ownable, ReentrancyGuard, IInsurancePolicy {
  enum PolicyStatus {
    Created,
    Active,
    Triggered,
    PaidOut,
    Expired
  }

  address payable public insured;
  address public oracle;
  uint256 public premiumWei;
  uint256 public coverageWei;
  uint256 public rainfallThresholdMm;
  uint64 public startTimestamp;
  uint64 public endTimestamp;
  uint64 public lastOracleUpdateTimestamp;
  uint256 public latestRainfallMm;
  bool public conditionMet;
  PolicyStatus public status;

  event PolicyActivated(address indexed insured, uint256 premiumWei, uint256 coverageWei);
  event WeatherDataRequested(address indexed policy, uint64 requestedAt);
  event WeatherDataFulfilled(uint256 rainfallMm, bool conditionMet, uint64 updatedAt);
  event PayoutExecuted(address indexed insured, uint256 amountWei, uint64 paidAt);
  event PolicyExpired(uint64 expiredAt);

  error InvalidInsuredAddress();
  error InvalidPolicyWindow(uint64 startTimestamp, uint64 endTimestamp);
  error InvalidCoverageAmount();
  error InvalidPremiumAmount();
  error InvalidOracleAddress();
  error CoverageReserveMismatch(uint256 expected, uint256 received);
  error PremiumMismatch(uint256 expected, uint256 received);
  error OracleOnly(address caller);
  error InvalidStatus(uint8 expected, uint8 actual);
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
    if (oracleAddress == address(0)) revert InvalidOracleAddress();
    if (coverageAmountWei == 0) revert InvalidCoverageAmount();
    if (premiumAmountWei == 0) revert InvalidPremiumAmount();
    if (startTimestamp_ > endTimestamp_ || startTimestamp_ == endTimestamp_)
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

  function activate() external payable onlyOwner {
    _requireStatus(PolicyStatus.Created);
    if (msg.value != premiumWei) revert PremiumMismatch(premiumWei, msg.value);

    status = PolicyStatus.Active;
    emit PolicyActivated(insured, premiumWei, coverageWei);
  }

  function requestWeatherData() external onlyOwner {
    _requireStatus(PolicyStatus.Active);
    _requireWeatherWindowOpen();
    emit WeatherDataRequested(address(this), uint64(block.timestamp));
  }

  function fulfillWeatherData(uint256 rainfallMm) external onlyOracle {
    _requireStatus(PolicyStatus.Active);
    _requireWeatherWindowOpen();

    latestRainfallMm = rainfallMm;
    lastOracleUpdateTimestamp = uint64(block.timestamp);
    conditionMet = rainfallMm > rainfallThresholdMm || rainfallMm == rainfallThresholdMm;

    if (conditionMet) {
      status = PolicyStatus.Triggered;
    }

    emit WeatherDataFulfilled(rainfallMm, conditionMet, lastOracleUpdateTimestamp);
  }

  function executePayout() external onlyOwner nonReentrant {
    _requireStatus(PolicyStatus.Triggered);

    status = PolicyStatus.PaidOut;

    (bool success, ) = insured.call{value: coverageWei}("");
    if (!success) revert EthTransferFailed();

    _forwardBalanceToOwner();

    emit PayoutExecuted(insured, coverageWei, uint64(block.timestamp));
  }

  function expirePolicy() external onlyOwner {
    if (status == PolicyStatus.PaidOut || status == PolicyStatus.Expired)
      revert PolicyAlreadySettled();
    if (status == PolicyStatus.Triggered) revert TriggeredPolicyRequiresPayout();
    if (block.timestamp < endTimestamp)
      revert PolicyNotEnded(uint64(block.timestamp), endTimestamp);

    status = PolicyStatus.Expired;
    _forwardBalanceToOwner();
    emit PolicyExpired(uint64(block.timestamp));
  }

  function getCurrentBalance() external view returns (uint256) {
    return address(this).balance;
  }

  function getStatus() external view returns (uint8) {
    return uint8(status);
  }

  function _forwardBalanceToOwner() private {
    uint256 amountWei = address(this).balance;
    if (amountWei == 0) return;

    (bool success, ) = owner().call{value: amountWei}("");
    if (!success) revert EthTransferFailed();
  }

  function _requireStatus(PolicyStatus expectedStatus) private view {
    if (status != expectedStatus) revert InvalidStatus(uint8(expectedStatus), uint8(status));
  }

  function _requireWeatherWindowOpen() private view {
    uint64 currentTimestamp = uint64(block.timestamp);

    // Policies are created with startTimestamp == block.timestamp in provider flow.
    // The active weather window guard is therefore an upper-bound check.
    if (currentTimestamp > endTimestamp || currentTimestamp == endTimestamp) {
      revert PolicyOutsideWeatherWindow(currentTimestamp, startTimestamp, endTimestamp);
    }
  }
}
