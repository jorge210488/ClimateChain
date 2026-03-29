// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {InsurancePolicy} from "./InsurancePolicy.sol";
import {IInsurancePolicy} from "./interfaces/IInsurancePolicy.sol";

/// @title InsuranceProvider
/// @notice Manages policy creation, weather requests, and treasury accounting for coverage and premiums.
/// @author ClimateChain
contract InsuranceProvider is Ownable, ReentrancyGuard {
  struct PolicyFinancials {
    uint256 coverageWei;
    uint256 premiumWei;
    bool settled;
  }

  /// @notice Denominator for basis-points calculations.
  uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;
  /// @notice Minimum premium ratio in basis points relative to coverage amount.
  uint256 public constant MIN_PREMIUM_BPS = 100;
  /// @notice Maximum allowed policy duration in days.
  uint32 public constant MAX_DURATION_DAYS = 365;

  /// @notice Oracle address assigned to newly created policies.
  address public weatherOracle;
  /// @notice Coverage reserve available for new policies and reserve withdrawals.
  uint256 public coverageReserveWei;
  /// @notice Premium balance available for premium withdrawals.
  uint256 public premiumBalanceWei;

  address[] private allPolicies;
  mapping(address => address[]) private policiesByInsured;
  /// @notice Indicates whether policy address was created by this provider.
  mapping(address => bool) public isPolicyCreated;
  mapping(address => PolicyFinancials) private policyFinancialsByPolicy;

  /// @notice Emitted when owner adds funds to coverage reserve.
  /// @param funder Account that provided reserve funds.
  /// @param amountWei Added amount in wei.
  /// @param newReserveWei Updated reserve balance.
  event CoverageReserveFunded(address indexed funder, uint256 amountWei, uint256 newReserveWei);
  /// @notice Emitted when owner withdraws coverage reserve.
  /// @param recipient Receiver of withdrawn reserve.
  /// @param amountWei Withdrawn amount in wei.
  /// @param newReserveWei Updated reserve balance.
  event CoverageReserveWithdrawn(
    address indexed recipient,
    uint256 amountWei,
    uint256 newReserveWei
  );
  /// @notice Emitted when owner withdraws premium balance.
  /// @param recipient Receiver of withdrawn premiums.
  /// @param amountWei Withdrawn amount in wei.
  /// @param newPremiumBalanceWei Updated premium balance.
  event PremiumBalanceWithdrawn(
    address indexed recipient,
    uint256 amountWei,
    uint256 newPremiumBalanceWei
  );
  /// @notice Emitted when owner withdraws untracked ETH balance.
  /// @param recipient Receiver of withdrawn untracked ETH.
  /// @param amountWei Withdrawn amount in wei.
  /// @param remainingUntrackedWei Remaining untracked ETH after withdrawal.
  event UntrackedBalanceWithdrawn(
    address indexed recipient,
    uint256 amountWei,
    uint256 remainingUntrackedWei
  );
  /// @notice Emitted when provider oracle address is updated for future policies.
  /// @param previousOracle Oracle used before update.
  /// @param newOracle Oracle used after update.
  /// @param appliesToExistingPolicies Whether update applies to already deployed policies.
  event WeatherOracleUpdated(
    address indexed previousOracle,
    address indexed newOracle,
    bool appliesToExistingPolicies
  );
  /// @notice Emitted when a new policy is created and activated.
  /// @param insured Insured account that created policy.
  /// @param policyAddress Deployed policy contract address.
  /// @param premiumWei Paid premium amount in wei.
  /// @param coverageWei Reserved coverage amount in wei.
  /// @param rainfallThresholdMm Trigger threshold in millimeters.
  /// @param startTimestamp Policy start timestamp.
  /// @param endTimestamp Policy end timestamp.
  event PolicyCreated(
    address indexed insured,
    address indexed policyAddress,
    uint256 premiumWei,
    uint256 coverageWei,
    uint256 rainfallThresholdMm,
    uint64 startTimestamp,
    uint64 endTimestamp
  );
  /// @notice Emitted when provider requests weather update for one policy.
  /// @param policyAddress Target policy address.
  event PolicyWeatherDataRequested(address indexed policyAddress);
  /// @notice Emitted when payout execution books recovered premium.
  /// @param policyAddress Target policy address.
  /// @param premiumRecoveredWei Premium amount booked after payout execution.
  event PolicyPayoutExecuted(address indexed policyAddress, uint256 premiumRecoveredWei);
  /// @notice Emitted when policy expiry books recovered coverage and premium.
  /// @param policyAddress Target policy address.
  /// @param coverageRecoveredWei Coverage amount returned to reserve.
  /// @param premiumRecoveredWei Premium amount returned to premium balance.
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
  error InsufficientUntrackedBalance(uint256 available, uint256 requiredAmount);
  error EthTransferFailed();

  /// @notice Creates provider with owner and initial oracle configuration.
  /// @param initialOwner Address with administrative permissions.
  /// @param oracleAddress Initial weather oracle used for newly created policies.
  constructor(address initialOwner, address oracleAddress) Ownable(initialOwner) {
    if (oracleAddress == address(0)) revert InvalidOracleAddress();
    weatherOracle = oracleAddress;
  }

  /// @notice Accepts ETH transfers from policy settlements and fallback transfers.
  receive() external payable {}

  /// @notice Updates oracle address for future policy deployments.
  /// @param newOracle Address of new weather oracle.
  function setWeatherOracle(address newOracle) external onlyOwner {
    if (newOracle == address(0)) revert InvalidOracleAddress();

    address previousOracle = weatherOracle;
    weatherOracle = newOracle;

    // Existing deployed policies keep their constructor oracle address.
    emit WeatherOracleUpdated(previousOracle, newOracle, false);
  }

  /// @notice Adds owner funds to coverage reserve.
  function fundCoverageReserve() external payable onlyOwner {
    if (msg.value == 0) revert InvalidCoverageAmount();
    coverageReserveWei += msg.value;

    emit CoverageReserveFunded(msg.sender, msg.value, coverageReserveWei);
  }

  /// @notice Withdraws available coverage reserve to target recipient.
  /// @param amountWei Amount to withdraw in wei.
  /// @param recipient Recipient address for reserve withdrawal.
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

  /// @notice Withdraws available premium balance to target recipient.
  /// @param amountWei Amount to withdraw in wei.
  /// @param recipient Recipient address for premium withdrawal.
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

  /// @notice Withdraws ETH that is present on-chain but not represented in tracked reserve/premium balances.
  /// @param amountWei Amount of untracked ETH to withdraw in wei.
  /// @param recipient Recipient address for untracked balance withdrawal.
  function withdrawUntrackedBalance(
    uint256 amountWei,
    address payable recipient
  ) external onlyOwner nonReentrant {
    if (recipient == address(0)) revert InvalidRecipientAddress();

    uint256 untrackedWei = _untrackedBalance();
    if (amountWei > untrackedWei) revert InsufficientUntrackedBalance(untrackedWei, amountWei);

    (bool success, ) = recipient.call{value: amountWei}("");
    if (!success) revert EthTransferFailed();

    emit UntrackedBalanceWithdrawn(recipient, amountWei, _untrackedBalance());
  }

  /// @notice Creates and activates a new policy for caller using provided premium and reserve-backed coverage.
  /// @param coverageAmountWei Coverage amount in wei.
  /// @param rainfallThresholdMm Trigger threshold in millimeters.
  /// @param durationDays Policy duration in days.
  /// @return policyAddress Address of newly deployed policy contract.
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

  /// @notice Requests weather data update for a known policy.
  /// @param policyAddress Target policy address.
  function requestPolicyWeatherData(address policyAddress) external onlyOwner {
    _assertKnownPolicy(policyAddress);
    IInsurancePolicy(policyAddress).requestWeatherData();
    emit PolicyWeatherDataRequested(policyAddress);
  }

  /// @notice Executes payout flow on triggered policy and books premium recovery.
  /// @param policyAddress Target policy address.
  function executePolicyPayout(address policyAddress) external onlyOwner nonReentrant {
    _assertKnownPolicy(policyAddress);

    PolicyFinancials storage policyFinancials = policyFinancialsByPolicy[policyAddress];
    if (policyFinancials.settled) revert PolicyAlreadySettledInProvider(policyAddress);
    uint256 premiumRecoveredWei = policyFinancials.premiumWei;

    // Apply all state effects before external interaction to preserve CEI ordering.
    policyFinancials.settled = true;
    premiumBalanceWei += premiumRecoveredWei;

    IInsurancePolicy(policyAddress).executePayout();

    // Settlement accounting is deterministic for current synchronous close flow.
    // If close flow becomes asynchronous, move to explicit callback reconciliation.
    emit PolicyPayoutExecuted(policyAddress, premiumRecoveredWei);
  }

  /// @notice Expires an eligible policy and books recovered coverage and premium balances.
  /// @param policyAddress Target policy address.
  function expirePolicy(address policyAddress) external onlyOwner nonReentrant {
    _assertKnownPolicy(policyAddress);

    PolicyFinancials storage policyFinancials = policyFinancialsByPolicy[policyAddress];
    if (policyFinancials.settled) revert PolicyAlreadySettledInProvider(policyAddress);
    uint256 coverageRecoveredWei = policyFinancials.coverageWei;
    uint256 premiumRecoveredWei = policyFinancials.premiumWei;

    // Apply all state effects before external interaction to preserve CEI ordering.
    policyFinancials.settled = true;
    coverageReserveWei += coverageRecoveredWei;
    premiumBalanceWei += premiumRecoveredWei;

    IInsurancePolicy(policyAddress).expirePolicy();

    emit PolicyExpired(policyAddress, coverageRecoveredWei, premiumRecoveredWei);
  }

  /// @notice Returns all policy addresses created by one insured account.
  /// @param insured Insured account address.
  /// @return Array of policy addresses linked to insured account.
  function getPoliciesByInsured(address insured) external view returns (address[] memory) {
    return policiesByInsured[insured];
  }

  /// @notice Returns total number of policies created in provider.
  /// @return Total policy count.
  function getAllPoliciesCount() external view returns (uint256) {
    return allPolicies.length;
  }

  /// @notice Returns policy address at index in global policy list.
  /// @param index Zero-based index in all policy array.
  /// @return Policy address at requested index.
  function getPolicyAt(uint256 index) external view returns (address) {
    uint256 totalPolicies = allPolicies.length;
    if (!(index < totalPolicies)) revert PolicyIndexOutOfBounds(index, totalPolicies);

    return allPolicies[index];
  }

  /// @notice Returns current untracked ETH balance not represented in reserve/premium ledgers.
  /// @return Untracked ETH amount in wei.
  function getUntrackedBalance() external view returns (uint256) {
    return _untrackedBalance();
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

    if (coverageReserveWei < coverageAmountWei) {
      revert InsufficientCoverageReserve(coverageReserveWei, coverageAmountWei);
    }

    uint256 minimumPremiumWei = _computeMinimumPremiumWei(coverageAmountWei);
    if (premiumWei < minimumPremiumWei) revert PremiumBelowMinimum(minimumPremiumWei, premiumWei);
  }

  function _assertKnownPolicy(address policyAddress) private view {
    if (!isPolicyCreated[policyAddress]) revert UnknownPolicyAddress(policyAddress);
  }

  function _untrackedBalance() private view returns (uint256) {
    uint256 trackedWei = coverageReserveWei + premiumBalanceWei;
    uint256 currentBalanceWei = address(this).balance;

    if (currentBalanceWei > trackedWei) return currentBalanceWei - trackedWei;

    return 0;
  }

  function _computeMinimumPremiumWei(uint256 coverageAmountWei) private pure returns (uint256) {
    return
      Math.mulDiv(coverageAmountWei, MIN_PREMIUM_BPS, BASIS_POINTS_DENOMINATOR, Math.Rounding.Ceil);
  }
}
