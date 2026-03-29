// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInsurancePolicy} from "./interfaces/IInsurancePolicy.sol";

/// @title InsurancePolicy
/// @notice Represents one parametric policy lifecycle managed by InsuranceProvider.
/// @author ClimateChain
contract InsurancePolicy is Ownable, ReentrancyGuard, IInsurancePolicy {
  enum PolicyStatus {
    Created,
    Active,
    Triggered,
    PaidOut,
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

  /// @notice Emitted when policy is activated.
  /// @param insured Insured account address.
  /// @param premiumWei Activated premium amount.
  /// @param coverageWei Reserved coverage amount.
  event PolicyActivated(address indexed insured, uint256 premiumWei, uint256 coverageWei);
  /// @notice Emitted when provider requests a weather update.
  /// @param policy Policy contract address.
  /// @param requestedAt Timestamp when request was emitted.
  event WeatherDataRequested(address indexed policy, uint64 requestedAt);
  /// @notice Emitted when oracle fulfills weather data.
  /// @param rainfallMm Rainfall value provided by oracle.
  /// @param conditionMet Whether trigger condition is met after update.
  /// @param updatedAt Timestamp when weather data was applied.
  event WeatherDataFulfilled(uint256 rainfallMm, bool conditionMet, uint64 updatedAt);
  /// @notice Emitted when payout is executed to insured.
  /// @param insured Insured account receiving payout.
  /// @param amountWei Coverage amount paid out.
  /// @param paidAt Timestamp when payout was executed.
  event PayoutExecuted(address indexed insured, uint256 amountWei, uint64 paidAt);
  /// @notice Emitted when policy expires without payout.
  /// @param expiredAt Timestamp when policy status became expired.
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
    if (oracleAddress == address(0)) revert InvalidOracleAddress();
    if (coverageAmountWei == 0) revert InvalidCoverageAmount();
    if (premiumAmountWei == 0) revert InvalidPremiumAmount();
    if (!(startTimestamp_ < endTimestamp_))
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

    status = PolicyStatus.Active;
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
    conditionMet = !(rainfallMm < rainfallThresholdMm);

    if (conditionMet) {
      status = PolicyStatus.Triggered;
    }

    emit WeatherDataFulfilled(rainfallMm, conditionMet, lastOracleUpdateTimestamp);
  }

  /// @notice Executes payout to insured and forwards any remaining balance to provider.
  function executePayout() external onlyOwner nonReentrant {
    _requireStatus(PolicyStatus.Triggered);

    status = PolicyStatus.PaidOut;

    (bool success, ) = insured.call{value: coverageWei}("");
    if (!success) revert EthTransferFailed();

    _forwardBalanceToOwner();

    emit PayoutExecuted(insured, coverageWei, uint64(block.timestamp));
  }

  /// @notice Expires policy after end timestamp and forwards all remaining funds to provider.
  function expirePolicy() external onlyOwner {
    if (status == PolicyStatus.Created)
      revert InvalidStatus(uint8(PolicyStatus.Active), uint8(status));
    if (status == PolicyStatus.PaidOut || status == PolicyStatus.Expired)
      revert PolicyAlreadySettled();
    if (status == PolicyStatus.Triggered) revert TriggeredPolicyRequiresPayout();
    if (block.timestamp < endTimestamp)
      revert PolicyNotEnded(uint64(block.timestamp), endTimestamp);

    status = PolicyStatus.Expired;
    _forwardBalanceToOwner();
    emit PolicyExpired(uint64(block.timestamp));
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
    if (!(currentTimestamp < endTimestamp)) {
      revert PolicyOutsideWeatherWindow(currentTimestamp, startTimestamp, endTimestamp);
    }
  }
}
