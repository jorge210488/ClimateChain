// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {InsurancePolicy} from "./InsurancePolicy.sol";
import {IInsurancePolicy} from "./interfaces/IInsurancePolicy.sol";
import {IInsuranceProviderCreatePolicy} from "./interfaces/IInsuranceProviderCreatePolicy.sol";
import {IInsuranceProviderRegistry} from "./interfaces/IInsuranceProviderRegistry.sol";
import {IWeatherOracleAdapter} from "./interfaces/IWeatherOracleAdapter.sol";

/// @title InsuranceProvider
/// @notice Manages policy creation, weather requests, and treasury accounting for coverage and premiums.
/// @author ClimateChain
contract InsuranceProvider is
  Ownable,
  ReentrancyGuard,
  IInsuranceProviderRegistry,
  IInsuranceProviderCreatePolicy
{
  /// @notice Provider-side settlement stage for one policy.
  enum SettlementType {
    /// @notice Policy has not been settled in provider storage.
    None,
    /// @notice Policy settled through payout execution.
    Payout,
    /// @notice Policy settled through expiry flow.
    Expiry
  }

  // solhint-disable-next-line gas-struct-packing
  struct PolicyFinancials {
    uint256 coverageWei;
    uint256 premiumWei;
    uint64 settledAt;
    SettlementType settlementType;
  }

  struct PolicyMetadata {
    bytes32 regionCode;
    uint64 requestedStartTimestamp;
  }

  /// @notice Denominator for basis-points calculations.
  uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;
  /// @notice Minimum premium ratio in basis points relative to coverage amount.
  uint256 public constant MIN_PREMIUM_BPS = 100;
  /// @notice Maximum allowed policy duration in days.
  uint32 public constant MAX_DURATION_DAYS = 365;
  /// @notice Minimum delay applied between policy creation and weather-window start.
  uint64 public constant MIN_POLICY_START_LEAD_TIME_SECONDS = 60;
  /// @notice Region code used by legacy createPolicy overload when explicit metadata is not provided.
  bytes32 public constant LEGACY_REGION_CODE = keccak256("LEGACY_UNSPECIFIED");

  /// @notice Oracle adapter assigned to newly created policies.
  IWeatherOracleAdapter public weatherOracle;
  /// @notice Coverage reserve available for new policies and reserve withdrawals.
  uint256 public coverageReserveWei;
  /// @notice Premium balance available for premium withdrawals.
  uint256 public premiumBalanceWei;

  address[] private allPolicies;
  mapping(address => address[]) private policiesByInsured;
  /// @notice Indicates whether policy address was created by this provider.
  mapping(address => bool) public isPolicyCreated;
  mapping(address => PolicyFinancials) private policyFinancialsByPolicy;
  mapping(address => PolicyMetadata) private policyMetadataByPolicy;

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
  /// @dev Event applies only to policies created after this update.
  event WeatherOracleUpdated(address indexed previousOracle, address indexed newOracle);
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
  /// @notice Emitted when provider stores policy metadata for backend/indexer compatibility.
  /// @param policyAddress Target policy address.
  /// @param regionCode Region/risk-bucket code for policy.
  /// @param requestedStartTimestamp Requested policy start timestamp.
  event PolicyMetadataRegistered(
    address indexed policyAddress,
    bytes32 indexed regionCode,
    uint64 requestedStartTimestamp
  );
  /// @notice Emitted when provider requests weather update for one policy.
  /// @param policyAddress Target policy address.
  event PolicyWeatherDataRequested(address indexed policyAddress);
  /// @notice Emitted when provider obtains canonical weather request id from policy.
  /// @param policyAddress Target policy address.
  /// @param requestId Canonical request id expected on oracle fulfill.
  event PolicyWeatherDataRequestTracked(address indexed policyAddress, bytes32 indexed requestId);
  /// @notice Emitted when payout execution books recovered premium.
  /// @param policyAddress Target policy address.
  /// @param coveragePaidWei Coverage amount paid to insured during settlement.
  /// @param premiumRecoveredWei Premium amount booked after payout execution.
  event PolicyPayoutExecuted(
    address indexed policyAddress,
    uint256 coveragePaidWei,
    uint256 premiumRecoveredWei
  );
  /// @notice Emitted when policy expiry books recovered coverage and premium.
  /// @param policyAddress Target policy address.
  /// @param coverageRecoveredWei Coverage amount returned to reserve.
  /// @param premiumRecoveredWei Premium amount returned to premium balance.
  event PolicyExpired(
    address indexed policyAddress,
    uint256 coverageRecoveredWei,
    uint256 premiumRecoveredWei
  );
  /// @notice Emitted when provider marks policy settlement metadata.
  /// @param policyAddress Target policy address.
  /// @param settlementType Settlement type encoded as uint8 (1 = payout, 2 = expiry).
  /// @param settledAt Timestamp when provider marked settlement.
  /// @param coverageWei Coverage amount stored for policy.
  /// @param premiumWei Premium amount stored for policy.
  event PolicySettled(
    address indexed policyAddress,
    uint8 settlementType,
    uint64 settledAt,
    uint256 coverageWei,
    uint256 premiumWei
  );

  error InvalidOracleAddress();
  error SameOracleAddress(address oracleAddress);
  error InvalidCoverageAmount();
  error InvalidDurationDays();
  error DurationDaysExceedsMaximum(uint32 providedDays, uint32 maxDays);
  error InvalidPolicyWindowComputation(uint64 requestedStartTimestamp, uint32 durationDays);
  error InvalidRainfallThreshold();
  error InvalidRegionCode();
  error InvalidRequestedStartTimestamp(uint64 minimumAllowed, uint64 providedStart);
  error PremiumMustBePositive();
  error PremiumBelowMinimum(uint256 minimumWei, uint256 providedWei);
  error InsufficientCoverageReserve(uint256 available, uint256 requiredAmount);
  error UnknownPolicyAddress(address policyAddress);
  error PolicyIndexOutOfBounds(uint256 index, uint256 totalPolicies);
  error PolicyAlreadySettledInProvider(address policyAddress);
  error InvalidWithdrawalAmount();
  error InvalidRecipientAddress();
  error InsufficientPremiumBalance(uint256 available, uint256 requiredAmount);
  error InsufficientUntrackedBalance(uint256 available, uint256 requiredAmount);
  error TrackedBalanceDeficit(uint256 trackedWei, uint256 currentBalanceWei);
  error EthTransferFailed();

  /// @notice Creates provider with owner and initial oracle configuration.
  /// @param initialOwner Address with administrative permissions.
  /// @param oracleAddress Initial weather oracle used for newly created policies.
  constructor(address initialOwner, address oracleAddress) Ownable(initialOwner) {
    if (oracleAddress == address(0) || oracleAddress.code.length == 0)
      revert InvalidOracleAddress();
    weatherOracle = IWeatherOracleAdapter(oracleAddress);
  }

  /// @notice Accepts ETH transfers from policy settlements and fallback transfers.
  receive() external payable {}

  /// @notice Updates oracle address for future policy deployments.
  /// @param newOracle Address of new weather oracle.
  function setWeatherOracle(address newOracle) external onlyOwner {
    if (newOracle == address(0) || newOracle.code.length == 0) revert InvalidOracleAddress();
    if (newOracle == address(weatherOracle)) revert SameOracleAddress(newOracle);

    address previousOracle = address(weatherOracle);
    weatherOracle = IWeatherOracleAdapter(newOracle);

    // Existing deployed policies keep their constructor oracle address.
    emit WeatherOracleUpdated(previousOracle, newOracle);
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
    if (amountWei == 0) revert InvalidWithdrawalAmount();
    if (recipient == address(0)) revert InvalidRecipientAddress();
    _assertNoTrackedBalanceDeficit();
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
    if (amountWei == 0) revert InvalidWithdrawalAmount();
    if (recipient == address(0)) revert InvalidRecipientAddress();
    _assertNoTrackedBalanceDeficit();
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
    if (amountWei == 0) revert InvalidWithdrawalAmount();
    if (recipient == address(0)) revert InvalidRecipientAddress();
    _assertNoTrackedBalanceDeficit();

    uint256 untrackedWei = _untrackedBalance();
    if (amountWei > untrackedWei) revert InsufficientUntrackedBalance(untrackedWei, amountWei);
    uint256 remainingUntrackedWei = untrackedWei - amountWei;

    // No ledger entry exists for untracked ETH; nonReentrant is the protection for this transfer.
    (bool success, ) = recipient.call{value: amountWei}("");
    if (!success) revert EthTransferFailed();

    emit UntrackedBalanceWithdrawn(recipient, amountWei, remainingUntrackedWei);
  }

  /// @notice Creates and activates a new policy for caller using provided premium and reserve-backed coverage.
  /// @param coverageAmountWei Coverage amount in wei.
  /// @param rainfallThresholdMm Trigger threshold in millimeters.
  /// @param durationDays Policy duration in days.
  /// @return Address of newly deployed policy contract.
  function createPolicy(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays
  ) external payable nonReentrant returns (address) {
    uint64 requestedStartTimestamp = uint64(block.timestamp + MIN_POLICY_START_LEAD_TIME_SECONDS);

    return
      _createPolicy(
        coverageAmountWei,
        rainfallThresholdMm,
        durationDays,
        LEGACY_REGION_CODE,
        requestedStartTimestamp
      );
  }

  /// @notice Creates and activates a new policy with explicit region and requested-start metadata.
  /// @param coverageAmountWei Coverage amount in wei.
  /// @param rainfallThresholdMm Trigger threshold in millimeters.
  /// @param durationDays Policy duration in days.
  /// @param regionCode Region/risk-bucket code used by downstream consumers.
  /// @param requestedStartTimestamp Requested start timestamp for policy window.
  /// @return Address of newly deployed policy contract.
  function createPolicyWithMetadata(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays,
    bytes32 regionCode,
    uint64 requestedStartTimestamp
  ) external payable nonReentrant returns (address) {
    return
      _createPolicy(
        coverageAmountWei,
        rainfallThresholdMm,
        durationDays,
        regionCode,
        requestedStartTimestamp
      );
  }

  /// @notice Requests weather data update for a known policy.
  /// @param policyAddress Target policy address.
  /// @return requestId Canonical request id expected on oracle fulfill.
  function requestPolicyWeatherData(address policyAddress) external onlyOwner returns (bytes32) {
    _assertKnownPolicy(policyAddress);
    bytes32 requestId = IInsurancePolicy(policyAddress).requestWeatherData();
    emit PolicyWeatherDataRequested(policyAddress);
    emit PolicyWeatherDataRequestTracked(policyAddress, requestId);

    return requestId;
  }

  /// @notice Executes payout flow on triggered policy and books premium recovery.
  /// @param policyAddress Target policy address.
  function executePolicyPayout(address policyAddress) external onlyOwner nonReentrant {
    _assertKnownPolicy(policyAddress);
    _assertNoTrackedBalanceDeficit();

    PolicyFinancials storage policyFinancials = policyFinancialsByPolicy[policyAddress];
    if (policyFinancials.settlementType != SettlementType.None)
      revert PolicyAlreadySettledInProvider(policyAddress);
    uint256 coveragePaidWei = policyFinancials.coverageWei;
    uint256 premiumRecoveredWei = policyFinancials.premiumWei;
    uint64 settledAt = uint64(block.timestamp);

    // Apply all state effects before external interaction to preserve CEI ordering.
    policyFinancials.settlementType = SettlementType.Payout;
    policyFinancials.settledAt = settledAt;
    premiumBalanceWei += premiumRecoveredWei;

    IInsurancePolicy(policyAddress).executePayout();

    // Settlement accounting is deterministic for current synchronous close flow.
    // If close flow becomes asynchronous, move to explicit callback reconciliation.
    emit PolicyPayoutExecuted(policyAddress, coveragePaidWei, premiumRecoveredWei);
    emit PolicySettled(
      policyAddress,
      uint8(SettlementType.Payout),
      settledAt,
      coveragePaidWei,
      premiumRecoveredWei
    );
  }

  /// @notice Expires an eligible policy and books recovered coverage and premium balances.
  /// @param policyAddress Target policy address.
  function expirePolicy(address policyAddress) external onlyOwner nonReentrant {
    _assertKnownPolicy(policyAddress);
    _assertNoTrackedBalanceDeficit();

    PolicyFinancials storage policyFinancials = policyFinancialsByPolicy[policyAddress];
    if (policyFinancials.settlementType != SettlementType.None)
      revert PolicyAlreadySettledInProvider(policyAddress);
    uint256 coverageRecoveredWei = policyFinancials.coverageWei;
    uint256 premiumRecoveredWei = policyFinancials.premiumWei;
    uint64 settledAt = uint64(block.timestamp);

    // Apply all state effects before external interaction to preserve CEI ordering.
    policyFinancials.settlementType = SettlementType.Expiry;
    policyFinancials.settledAt = settledAt;
    coverageReserveWei += coverageRecoveredWei;
    premiumBalanceWei += premiumRecoveredWei;

    IInsurancePolicy(policyAddress).expirePolicy();

    emit PolicyExpired(policyAddress, coverageRecoveredWei, premiumRecoveredWei);
    emit PolicySettled(
      policyAddress,
      uint8(SettlementType.Expiry),
      settledAt,
      coverageRecoveredWei,
      premiumRecoveredWei
    );
  }

  /// @notice Returns all policy addresses created by one insured account.
  /// @param insured Insured account address.
  /// @return Array of policy addresses linked to insured account.
  function getPoliciesByInsured(address insured) external view returns (address[] memory) {
    return policiesByInsured[insured];
  }

  /// @notice Returns one page of policy addresses linked to insured account.
  /// @param insured Insured account address.
  /// @param offset Zero-based start index inside insured policy array.
  /// @param limit Maximum number of policy addresses to return.
  /// @return policiesPage Page of policy addresses.
  /// @return totalPoliciesForInsured Total number of policies linked to insured account.
  function getPoliciesByInsuredPage(
    address insured,
    uint256 offset,
    uint256 limit
  ) external view returns (address[] memory policiesPage, uint256 totalPoliciesForInsured) {
    return _paginatePolicies(policiesByInsured[insured], offset, limit);
  }

  /// @notice Returns total number of policies created in provider.
  /// @return Total policy count.
  function getAllPoliciesCount() external view returns (uint256) {
    return allPolicies.length;
  }

  /// @notice Returns one page of policy addresses from global policy list.
  /// @param offset Zero-based start index inside global policy array.
  /// @param limit Maximum number of policy addresses to return.
  /// @return policiesPage Page of policy addresses.
  /// @return totalPolicies Total number of policies in global list.
  function getAllPoliciesPage(
    uint256 offset,
    uint256 limit
  ) external view returns (address[] memory policiesPage, uint256 totalPolicies) {
    return _paginatePolicies(allPolicies, offset, limit);
  }

  /// @notice Returns policy address at index in global policy list.
  /// @param index Zero-based index in all policy array.
  /// @return Policy address at requested index.
  function getPolicyAt(uint256 index) external view returns (address) {
    uint256 totalPolicies = allPolicies.length;
    // solhint-disable-next-line gas-strict-inequalities
    if (index >= totalPolicies) revert PolicyIndexOutOfBounds(index, totalPolicies);

    return allPolicies[index];
  }

  /// @notice Returns provider-side financial snapshot for a known policy.
  /// @param policyAddress Target policy address.
  /// @return coverageWei Recorded coverage amount in wei.
  /// @return premiumWei Recorded premium amount in wei.
  /// @return isSettled True when provider has settled policy through payout or expiry.
  function getPolicyFinancials(
    address policyAddress
  ) external view returns (uint256 coverageWei, uint256 premiumWei, bool isSettled) {
    _assertKnownPolicy(policyAddress);
    PolicyFinancials memory policyFinancials = policyFinancialsByPolicy[policyAddress];

    return (
      policyFinancials.coverageWei,
      policyFinancials.premiumWei,
      policyFinancials.settlementType != SettlementType.None
    );
  }

  /// @notice Returns provider-side settlement metadata for a known policy.
  /// @param policyAddress Target policy address.
  /// @return settlementType Settlement type encoded as uint8 (0 = none, 1 = payout, 2 = expiry).
  /// @return settledAt Timestamp when provider marked settlement, or zero if unsettled.
  function getPolicySettlementInfo(
    address policyAddress
  ) external view returns (uint8 settlementType, uint64 settledAt) {
    _assertKnownPolicy(policyAddress);
    PolicyFinancials memory policyFinancials = policyFinancialsByPolicy[policyAddress];

    return (uint8(policyFinancials.settlementType), policyFinancials.settledAt);
  }

  /// @notice Returns provider-side metadata for one known policy.
  /// @param policyAddress Target policy address.
  /// @return regionCode Region/risk-bucket code associated with policy.
  /// @return requestedStartTimestamp Requested policy start timestamp.
  function getPolicyMetadata(
    address policyAddress
  ) external view returns (bytes32 regionCode, uint64 requestedStartTimestamp) {
    _assertKnownPolicy(policyAddress);
    PolicyMetadata memory metadata = policyMetadataByPolicy[policyAddress];

    return (metadata.regionCode, metadata.requestedStartTimestamp);
  }

  /// @notice Returns current untracked ETH balance not represented in reserve/premium ledgers.
  /// @return Untracked ETH amount in wei.
  function getUntrackedBalance() external view returns (uint256) {
    return _untrackedBalance();
  }

  /// @notice Returns tracked balance represented in reserve and premium ledgers.
  /// @return Tracked balance in wei.
  function getTrackedBalance() external view returns (uint256) {
    return _trackedBalance();
  }

  /// @notice Returns tracked-balance deficit when tracked amount exceeds real contract balance.
  /// @return Balance deficit in wei.
  function getBalanceDeficit() external view returns (uint256) {
    return _balanceDeficit();
  }

  /// @notice Creates and activates one policy after validating accounting and metadata constraints.
  /// @param coverageAmountWei Coverage amount in wei.
  /// @param rainfallThresholdMm Trigger threshold in millimeters.
  /// @param durationDays Policy duration in days.
  /// @param regionCode Region/risk-bucket code used by downstream consumers.
  /// @param requestedStartTimestamp Requested policy start timestamp.
  /// @return policyAddress Newly created policy address.
  function _createPolicy(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays,
    bytes32 regionCode,
    uint64 requestedStartTimestamp
  ) private returns (address policyAddress) {
    _validatePolicyCreationInputs(
      coverageAmountWei,
      rainfallThresholdMm,
      durationDays,
      msg.value,
      regionCode,
      requestedStartTimestamp
    );
    _assertNoTrackedBalanceDeficitExcludingIncomingValue(msg.value);

    (uint64 startTimestamp, uint64 endTimestamp) = _computePolicyWindow(
      requestedStartTimestamp,
      durationDays
    );

    coverageReserveWei -= coverageAmountWei;

    policyAddress = _deployAndRegisterPolicy(
      coverageAmountWei,
      rainfallThresholdMm,
      regionCode,
      requestedStartTimestamp,
      startTimestamp,
      endTimestamp
    );

    // Policy activation remains an external call, but provider indexing is already registered.
    IInsurancePolicy(policyAddress).activate{value: msg.value}();

    _emitPolicyCreationEvents(
      policyAddress,
      coverageAmountWei,
      rainfallThresholdMm,
      regionCode,
      requestedStartTimestamp,
      startTimestamp,
      endTimestamp
    );
  }

  /// @notice Deploys one policy and registers all provider-side indexes and accounting metadata.
  /// @dev Reads msg.value as premium amount from the calling payable context.
  /// @param coverageAmountWei Coverage amount in wei.
  /// @param rainfallThresholdMm Trigger threshold in millimeters.
  /// @param regionCode Region/risk-bucket code used by downstream consumers.
  /// @param requestedStartTimestamp Requested policy start timestamp.
  /// @param startTimestamp Computed policy weather-window start timestamp.
  /// @param endTimestamp Computed policy weather-window end timestamp.
  /// @return policyAddress Newly deployed policy address.
  function _deployAndRegisterPolicy(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    bytes32 regionCode,
    uint64 requestedStartTimestamp,
    uint64 startTimestamp,
    uint64 endTimestamp
  ) private returns (address policyAddress) {
    // CREATE deployment is unavoidable before indexing; full pre-call indexing requires CREATE2 precomputation.
    InsurancePolicy policy = new InsurancePolicy{value: coverageAmountWei}(
      address(this),
      payable(msg.sender),
      address(weatherOracle),
      msg.value,
      coverageAmountWei,
      rainfallThresholdMm,
      regionCode,
      startTimestamp,
      endTimestamp
    );
    policyAddress = address(policy);

    allPolicies.push(policyAddress);
    policiesByInsured[msg.sender].push(policyAddress);
    isPolicyCreated[policyAddress] = true;
    policyFinancialsByPolicy[policyAddress] = PolicyFinancials({
      coverageWei: coverageAmountWei,
      premiumWei: msg.value,
      settlementType: SettlementType.None,
      settledAt: 0
    });
    policyMetadataByPolicy[policyAddress] = PolicyMetadata({
      regionCode: regionCode,
      requestedStartTimestamp: requestedStartTimestamp
    });
  }

  /// @notice Emits canonical provider events after policy deployment and activation.
  /// @param policyAddress Newly created policy address.
  /// @param coverageAmountWei Coverage amount in wei.
  /// @param rainfallThresholdMm Trigger threshold in millimeters.
  /// @param regionCode Region/risk-bucket code used by downstream consumers.
  /// @param requestedStartTimestamp Requested policy start timestamp.
  /// @param startTimestamp Computed policy weather-window start timestamp.
  /// @param endTimestamp Computed policy weather-window end timestamp.
  function _emitPolicyCreationEvents(
    address policyAddress,
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    bytes32 regionCode,
    uint64 requestedStartTimestamp,
    uint64 startTimestamp,
    uint64 endTimestamp
  ) private {
    emit PolicyCreated(
      msg.sender,
      policyAddress,
      msg.value,
      coverageAmountWei,
      rainfallThresholdMm,
      startTimestamp,
      endTimestamp
    );
    emit PolicyMetadataRegistered(policyAddress, regionCode, requestedStartTimestamp);
  }

  /// @notice Validates policy creation inputs before reserve mutation or deployment.
  /// @param coverageAmountWei Requested coverage amount in wei.
  /// @param rainfallThresholdMm Requested rainfall trigger threshold.
  /// @param durationDays Requested policy duration in days.
  /// @param premiumWei Premium payment sent by insured.
  /// @param regionCode Requested region/risk-bucket code.
  /// @param requestedStartTimestamp Requested start timestamp for policy window.
  function _validatePolicyCreationInputs(
    uint256 coverageAmountWei,
    uint256 rainfallThresholdMm,
    uint32 durationDays,
    uint256 premiumWei,
    bytes32 regionCode,
    uint64 requestedStartTimestamp
  ) private view {
    if (coverageAmountWei == 0) revert InvalidCoverageAmount();
    if (rainfallThresholdMm == 0) revert InvalidRainfallThreshold();
    if (durationDays == 0) revert InvalidDurationDays();
    if (durationDays > MAX_DURATION_DAYS)
      revert DurationDaysExceedsMaximum(durationDays, MAX_DURATION_DAYS);
    if (premiumWei == 0) revert PremiumMustBePositive();
    if (regionCode == bytes32(0)) revert InvalidRegionCode();

    uint64 minimumAllowedStartTimestamp = uint64(
      block.timestamp + MIN_POLICY_START_LEAD_TIME_SECONDS
    );
    if (requestedStartTimestamp < minimumAllowedStartTimestamp) {
      revert InvalidRequestedStartTimestamp(minimumAllowedStartTimestamp, requestedStartTimestamp);
    }

    if (coverageReserveWei < coverageAmountWei) {
      revert InsufficientCoverageReserve(coverageReserveWei, coverageAmountWei);
    }

    uint256 minimumPremiumWei = _computeMinimumPremiumWei(coverageAmountWei);
    if (premiumWei < minimumPremiumWei) revert PremiumBelowMinimum(minimumPremiumWei, premiumWei);
  }

  /// @notice Reverts when policy address is unknown to provider storage.
  /// @param policyAddress Candidate policy address.
  function _assertKnownPolicy(address policyAddress) private view {
    if (!isPolicyCreated[policyAddress]) revert UnknownPolicyAddress(policyAddress);
  }

  /// @notice Returns one page of policy addresses from storage array.
  /// @param source Storage array containing policy addresses.
  /// @param offset Zero-based start index.
  /// @param limit Maximum number of addresses to copy.
  /// @return page Requested page of addresses.
  /// @return total Total number of addresses in source array.
  function _paginatePolicies(
    address[] storage source,
    uint256 offset,
    uint256 limit
  ) private view returns (address[] memory page, uint256 total) {
    total = source.length;
    // solhint-disable-next-line gas-strict-inequalities
    if (offset >= total || limit == 0) return (new address[](0), total);

    uint256 endExclusive = offset + limit;
    if (endExclusive > total || endExclusive < offset) {
      endExclusive = total;
    }

    uint256 pageLength = endExclusive - offset;
    page = new address[](pageLength);

    for (uint256 i = 0; i < pageLength; ++i) {
      page[i] = source[offset + i];
    }
  }

  /// @notice Computes on-chain ETH balance not represented in reserve and premium ledgers.
  /// @return Untracked balance in wei.
  function _untrackedBalance() private view returns (uint256) {
    uint256 trackedWei = _trackedBalance();
    uint256 currentBalanceWei = address(this).balance;

    if (currentBalanceWei > trackedWei) return currentBalanceWei - trackedWei;

    return 0;
  }

  /// @notice Computes tracked balance represented by reserve and premium ledgers.
  /// @return Tracked balance in wei.
  function _trackedBalance() private view returns (uint256) {
    return coverageReserveWei + premiumBalanceWei;
  }

  /// @notice Computes tracked-balance deficit when tracked amount exceeds current ETH balance.
  /// @return Balance deficit in wei.
  function _balanceDeficit() private view returns (uint256) {
    uint256 trackedWei = _trackedBalance();
    uint256 currentBalanceWei = address(this).balance;

    if (trackedWei > currentBalanceWei) return trackedWei - currentBalanceWei;

    return 0;
  }

  /// @notice Reverts when tracked balances exceed actual on-chain contract balance.
  function _assertNoTrackedBalanceDeficit() private view {
    _assertNoTrackedBalanceDeficitWithCurrentBalance(address(this).balance);
  }

  /// @notice Reverts when tracked balances exceed current balance excluding incoming call value.
  /// @param incomingValueWei Incoming payable value to exclude from current-balance check.
  function _assertNoTrackedBalanceDeficitExcludingIncomingValue(
    uint256 incomingValueWei
  ) private view {
    _assertNoTrackedBalanceDeficitWithCurrentBalance(address(this).balance - incomingValueWei);
  }

  /// @notice Reverts when tracked balances exceed provided current balance snapshot.
  /// @param currentBalanceWei Current balance snapshot used for deficit comparison.
  function _assertNoTrackedBalanceDeficitWithCurrentBalance(
    uint256 currentBalanceWei
  ) private view {
    uint256 trackedWei = _trackedBalance();

    if (trackedWei > currentBalanceWei) {
      revert TrackedBalanceDeficit(trackedWei, currentBalanceWei);
    }
  }

  /// @notice Computes policy weather-window bounds from requested start and duration.
  /// @param requestedStartTimestamp Requested start timestamp as unix seconds.
  /// @param durationDays Policy duration in days.
  /// @return startTimestamp Computed start timestamp as unix seconds.
  /// @return endTimestamp Computed end timestamp as unix seconds.
  function _computePolicyWindow(
    uint64 requestedStartTimestamp,
    uint32 durationDays
  ) private pure returns (uint64 startTimestamp, uint64 endTimestamp) {
    startTimestamp = requestedStartTimestamp;
    uint256 endTimestampRaw = uint256(startTimestamp) + uint256(durationDays) * 1 days;

    if (endTimestampRaw > type(uint64).max) {
      revert InvalidPolicyWindowComputation(startTimestamp, durationDays);
    }

    endTimestamp = uint64(endTimestampRaw);
  }

  /// @notice Computes minimum premium amount from configured basis-point ratio.
  /// @param coverageAmountWei Coverage amount used as premium base.
  /// @return Minimum premium amount in wei rounded up.
  function _computeMinimumPremiumWei(uint256 coverageAmountWei) private pure returns (uint256) {
    return
      Math.mulDiv(coverageAmountWei, MIN_PREMIUM_BPS, BASIS_POINTS_DENOMINATOR, Math.Rounding.Ceil);
  }
}
