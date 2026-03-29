// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {InsurancePolicy} from "./InsurancePolicy.sol";
import {IInsurancePolicy} from "./interfaces/IInsurancePolicy.sol";

contract InsuranceProvider is Ownable, ReentrancyGuard {
  struct PolicyFinancials {
    uint256 coverageWei;
    uint256 premiumWei;
    bool settled;
  }

  uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;
  uint256 public constant MIN_PREMIUM_BPS = 100;
  uint32 public constant MAX_DURATION_DAYS = 365;

  address public weatherOracle;
  uint256 public coverageReserveWei;
  uint256 public premiumBalanceWei;

  address[] private allPolicies;
  mapping(address => address[]) private policiesByInsured;
  mapping(address => bool) public isPolicyCreated;
  mapping(address => PolicyFinancials) private policyFinancialsByPolicy;

  event CoverageReserveFunded(address indexed funder, uint256 amountWei, uint256 newReserveWei);
  event CoverageReserveWithdrawn(
    address indexed recipient,
    uint256 amountWei,
    uint256 newReserveWei
  );
  event PremiumBalanceWithdrawn(
    address indexed recipient,
    uint256 amountWei,
    uint256 newPremiumBalanceWei
  );
  event WeatherOracleUpdated(
    address indexed previousOracle,
    address indexed newOracle,
    bool appliesToExistingPolicies
  );
  event PolicyCreated(
    address indexed insured,
    address indexed policyAddress,
    uint256 premiumWei,
    uint256 coverageWei,
    uint256 rainfallThresholdMm,
    uint64 startTimestamp,
    uint64 endTimestamp
  );
  event PolicyWeatherDataRequested(address indexed policyAddress);
  event PolicyPayoutExecuted(address indexed policyAddress, uint256 premiumRecoveredWei);
  event PolicyExpired(
    address indexed policyAddress,
    uint256 coverageRecoveredWei,
    uint256 premiumRecoveredWei
  );

  error InvalidOracleAddress();
  error InvalidCoverageAmount();
  error InvalidDurationDays();
  error DurationDaysExceedsMaximum(uint32 providedDays, uint32 maxDays);
  error InvalidRainfallThreshold();
  error PremiumMustBePositive();
  error PremiumBelowMinimum(uint256 minimumWei, uint256 providedWei);
  error InsufficientCoverageReserve(uint256 available, uint256 requiredAmount);
  error UnknownPolicyAddress(address policyAddress);
  error PolicyIndexOutOfBounds(uint256 index, uint256 totalPolicies);
  error PolicyAlreadySettledInProvider(address policyAddress);
  error InvalidRecipientAddress();
  error InsufficientPremiumBalance(uint256 available, uint256 requiredAmount);
  error EthTransferFailed();

  constructor(address initialOwner, address oracleAddress) Ownable(initialOwner) {
    if (oracleAddress == address(0)) revert InvalidOracleAddress();
    weatherOracle = oracleAddress;
  }

  receive() external payable {}

  function setWeatherOracle(address newOracle) external onlyOwner {
    if (newOracle == address(0)) revert InvalidOracleAddress();

    address previousOracle = weatherOracle;
    weatherOracle = newOracle;

    // Existing deployed policies keep their constructor oracle address.
    emit WeatherOracleUpdated(previousOracle, newOracle, false);
  }

  function fundCoverageReserve() external payable onlyOwner {
    if (msg.value == 0) revert InvalidCoverageAmount();
    coverageReserveWei += msg.value;

    emit CoverageReserveFunded(msg.sender, msg.value, coverageReserveWei);
  }

  function withdrawCoverageReserve(
    uint256 amountWei,
    address payable recipient
  ) external onlyOwner nonReentrant {
    if (recipient == address(0)) revert InvalidRecipientAddress();
    if (amountWei > coverageReserveWei)
      revert InsufficientCoverageReserve(coverageReserveWei, amountWei);

    coverageReserveWei -= amountWei;
    (bool success, ) = recipient.call{value: amountWei}("");
    if (!success) revert EthTransferFailed();

    emit CoverageReserveWithdrawn(recipient, amountWei, coverageReserveWei);
  }

  function withdrawPremiumBalance(
    uint256 amountWei,
    address payable recipient
  ) external onlyOwner nonReentrant {
    if (recipient == address(0)) revert InvalidRecipientAddress();
    if (amountWei > premiumBalanceWei)
      revert InsufficientPremiumBalance(premiumBalanceWei, amountWei);

    premiumBalanceWei -= amountWei;
    (bool success, ) = recipient.call{value: amountWei}("");
    if (!success) revert EthTransferFailed();

    emit PremiumBalanceWithdrawn(recipient, amountWei, premiumBalanceWei);
  }

  function createPolicy(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays
  ) external payable nonReentrant returns (address policyAddress) {
    _validatePolicyCreationInputs(coverageAmountWei, rainfallThresholdMm, durationDays, msg.value);

    uint64 startTimestamp = uint64(block.timestamp);
    uint64 endTimestamp = uint64(block.timestamp + uint256(durationDays) * 1 days);

    coverageReserveWei -= coverageAmountWei;

    InsurancePolicy policy = new InsurancePolicy{value: coverageAmountWei}(
      address(this),
      payable(msg.sender),
      weatherOracle,
      msg.value,
      coverageAmountWei,
      rainfallThresholdMm,
      startTimestamp,
      endTimestamp
    );

    policy.activate{value: msg.value}();

    policyAddress = address(policy);
    allPolicies.push(policyAddress);
    policiesByInsured[msg.sender].push(policyAddress);
    isPolicyCreated[policyAddress] = true;
    policyFinancialsByPolicy[policyAddress] = PolicyFinancials({
      coverageWei: coverageAmountWei,
      premiumWei: msg.value,
      settled: false
    });

    emit PolicyCreated(
      msg.sender,
      policyAddress,
      msg.value,
      coverageAmountWei,
      rainfallThresholdMm,
      startTimestamp,
      endTimestamp
    );
  }

  function requestPolicyWeatherData(address policyAddress) external onlyOwner {
    _assertKnownPolicy(policyAddress);
    IInsurancePolicy(policyAddress).requestWeatherData();
    emit PolicyWeatherDataRequested(policyAddress);
  }

  function executePolicyPayout(address policyAddress) external onlyOwner {
    _assertKnownPolicy(policyAddress);

    PolicyFinancials storage policyFinancials = policyFinancialsByPolicy[policyAddress];
    if (policyFinancials.settled) revert PolicyAlreadySettledInProvider(policyAddress);

    IInsurancePolicy(policyAddress).executePayout();

    // Settlement accounting is deterministic for current synchronous close flow.
    // If close flow becomes asynchronous, move to explicit callback reconciliation.
    uint256 premiumRecoveredWei = policyFinancials.premiumWei;

    premiumBalanceWei += premiumRecoveredWei;
    policyFinancials.settled = true;

    emit PolicyPayoutExecuted(policyAddress, premiumRecoveredWei);
  }

  function expirePolicy(address policyAddress) external onlyOwner {
    _assertKnownPolicy(policyAddress);

    PolicyFinancials storage policyFinancials = policyFinancialsByPolicy[policyAddress];
    if (policyFinancials.settled) revert PolicyAlreadySettledInProvider(policyAddress);

    IInsurancePolicy(policyAddress).expirePolicy();

    uint256 coverageRecoveredWei = policyFinancials.coverageWei;
    uint256 premiumRecoveredWei = policyFinancials.premiumWei;

    coverageReserveWei += coverageRecoveredWei;
    premiumBalanceWei += premiumRecoveredWei;
    policyFinancials.settled = true;

    emit PolicyExpired(policyAddress, coverageRecoveredWei, premiumRecoveredWei);
  }

  function getPoliciesByInsured(address insured) external view returns (address[] memory) {
    return policiesByInsured[insured];
  }

  function getAllPoliciesCount() external view returns (uint256) {
    return allPolicies.length;
  }

  function getPolicyAt(uint256 index) external view returns (address) {
    uint256 totalPolicies = allPolicies.length;
    if (index > totalPolicies || index == totalPolicies)
      revert PolicyIndexOutOfBounds(index, totalPolicies);

    return allPolicies[index];
  }

  function _validatePolicyCreationInputs(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays,
    uint256 premiumWei
  ) private view {
    if (coverageAmountWei == 0) revert InvalidCoverageAmount();
    if (rainfallThresholdMm == 0) revert InvalidRainfallThreshold();
    if (durationDays == 0) revert InvalidDurationDays();
    if (durationDays > MAX_DURATION_DAYS)
      revert DurationDaysExceedsMaximum(durationDays, MAX_DURATION_DAYS);
    if (premiumWei == 0) revert PremiumMustBePositive();

    uint256 minimumPremiumWei = _computeMinimumPremiumWei(coverageAmountWei);
    if (premiumWei < minimumPremiumWei) revert PremiumBelowMinimum(minimumPremiumWei, premiumWei);

    if (coverageReserveWei < coverageAmountWei) {
      revert InsufficientCoverageReserve(coverageReserveWei, coverageAmountWei);
    }
  }

  function _assertKnownPolicy(address policyAddress) private view {
    if (!isPolicyCreated[policyAddress]) revert UnknownPolicyAddress(policyAddress);
  }

  function _computeMinimumPremiumWei(uint256 coverageAmountWei) private pure returns (uint256) {
    return
      (coverageAmountWei * MIN_PREMIUM_BPS + BASIS_POINTS_DENOMINATOR - 1) /
      BASIS_POINTS_DENOMINATOR;
  }
}
