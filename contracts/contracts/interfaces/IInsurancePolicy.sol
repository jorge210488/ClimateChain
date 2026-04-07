// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

/// @title IInsurancePolicy
/// @notice Interface for provider and oracle interactions with policy contracts.
/// @author ClimateChain
interface IInsurancePolicy {
  /// @notice Emitted whenever policy status transitions to a new lifecycle state.
  /// @param previousStatus Previous status encoded as uint8.
  /// @param newStatus New status encoded as uint8.
  /// @param transitionedAt Timestamp when transition was applied.
  event PolicyStatusTransitioned(
    uint8 indexed previousStatus,
    uint8 indexed newStatus,
    uint64 transitionedAt
  );

  /// @notice Emitted when policy is activated.
  /// @param insured Insured account address.
  /// @param premiumWei Activated premium amount.
  /// @param coverageWei Reserved coverage amount.
  event PolicyActivated(address indexed insured, uint256 premiumWei, uint256 coverageWei);

  /// @notice Emitted when provider requests weather update.
  /// @param policy Policy contract address.
  /// @param requestedAt Timestamp when request was emitted.
  event WeatherDataRequested(address indexed policy, uint64 requestedAt);

  /// @notice Emitted when policy registers or reuses a request id for oracle fulfillment.
  /// @param requestId Canonical request identifier expected on oracle callback.
  /// @param requestedAt Timestamp when request id was (re)announced.
  event WeatherDataRequestTracked(bytes32 indexed requestId, uint64 requestedAt);

  /// @notice Emitted when oracle fulfills weather data.
  /// @param rainfallMm Rainfall value provided by oracle.
  /// @param conditionMet Whether trigger condition is met after update.
  /// @param updatedAt Timestamp when weather data was applied.
  event WeatherDataFulfilled(uint256 rainfallMm, bool conditionMet, uint64 updatedAt);

  /// @notice Emitted when policy consumes a tracked request id on successful oracle callback.
  /// @param requestId Canonical request identifier consumed by fulfillment.
  /// @param fulfilledAt Timestamp when request id was fulfilled.
  event WeatherDataFulfillmentTracked(bytes32 indexed requestId, uint64 fulfilledAt);

  /// @notice Emitted when payout is executed to insured.
  /// @param insured Insured account receiving payout.
  /// @param amountWei Coverage amount paid out.
  /// @param paidAt Timestamp when payout was executed.
  event PayoutExecuted(address indexed insured, uint256 amountWei, uint64 paidAt);

  /// @notice Emitted when immediate payout transfer fails and insured must claim later.
  /// @param insured Insured account entitled to claim.
  /// @param amountWei Coverage amount made claimable.
  /// @param createdAt Timestamp when claimable payout was created.
  event PayoutClaimCreated(address indexed insured, uint256 amountWei, uint64 createdAt);

  /// @notice Emitted when insured successfully claims deferred payout.
  /// @param insured Insured account that claimed deferred payout.
  /// @param amountWei Claimed amount in wei.
  /// @param claimedAt Timestamp when claim was executed.
  event PayoutClaimed(address indexed insured, uint256 amountWei, uint64 claimedAt);

  /// @notice Emitted when policy expires without payout.
  /// @param insured Insured account linked to expired policy.
  /// @param expiredAt Timestamp when policy status became expired.
  event PolicyExpired(address indexed insured, uint64 expiredAt);

  /// @notice Activates policy with exact premium payment.
  function activate() external payable;

  /// @notice Requests weather data update while policy window is open.
  /// @return requestId Canonical request id expected on oracle callback.
  function requestWeatherData() external returns (bytes32 requestId);

  /// @notice Pushes weather data into policy state.
  /// @param rainfallMm Observed rainfall amount in millimeters.
  function fulfillWeatherData(uint256 rainfallMm) external;

  /// @notice Pushes weather data into policy state using an explicit tracked request id.
  /// @param requestId Canonical request identifier expected by policy.
  /// @param rainfallMm Observed rainfall amount in millimeters.
  function fulfillWeatherData(bytes32 requestId, uint256 rainfallMm) external;

  /// @notice Executes payout when policy has been triggered.
  function executePayout() external;

  /// @notice Claims deferred payout when immediate insured transfer failed in executePayout.
  function claimPendingPayout() external;

  /// @notice Expires policy after policy window end.
  function expirePolicy() external;

  /// @notice Returns current ETH balance held by policy contract.
  /// @return Current on-chain balance in wei.
  function getCurrentBalance() external view returns (uint256);

  /// @notice Returns current policy status encoded as uint8.
  /// @return Current status value.
  function getStatus() external view returns (uint8);

  /// @notice Returns currently pending weather request id expected on oracle fulfill.
  /// @return Pending request id or bytes32(0) when no request is pending.
  function pendingWeatherRequestId() external view returns (bytes32);

  /// @notice Returns timestamp for currently pending weather request id.
  /// @return Timestamp when pending request was registered, or zero if none pending.
  function pendingWeatherRequestTimestamp() external view returns (uint64);

  /// @notice Returns deferred payout amount still claimable by insured.
  /// @return Pending payout amount in wei.
  function pendingPayoutWei() external view returns (uint256);

  /// @notice Returns whether payout execution is currently allowed.
  /// @return True when policy is in Triggered status.
  function isPayoutEligible() external view returns (bool);

  /// @notice Returns whether expiry execution is currently allowed.
  /// @return True when policy is active and end timestamp has been reached.
  function isExpiryEligible() external view returns (bool);

  /// @notice Returns whether current timestamp is within weather request/fulfill window.
  /// @return True when current time is inside [startTimestamp, endTimestamp).
  function isWeatherWindowOpen() external view returns (bool);

  /// @notice Returns oracle address authorized to fulfill weather data.
  /// @return Oracle account address.
  function oracle() external view returns (address);

  /// @notice Returns insured account that receives payout on trigger.
  /// @return insuredAddress Insured account address.
  function insured() external view returns (address payable insuredAddress);

  /// @notice Indicates whether trigger condition has been met.
  /// @return True when rainfall threshold condition has been met.
  function conditionMet() external view returns (bool);

  /// @notice Returns policy premium amount.
  /// @return Premium amount in wei.
  function premiumWei() external view returns (uint256);

  /// @notice Returns region code associated with policy risk bucket.
  /// @return Region code as bytes32 identifier.
  function regionCode() external view returns (bytes32);

  /// @notice Returns policy coverage amount.
  /// @return Coverage amount in wei.
  function coverageWei() external view returns (uint256);

  /// @notice Returns rainfall trigger threshold configured for this policy.
  /// @return Trigger threshold in millimeters.
  function rainfallThresholdMm() external view returns (uint256);

  /// @notice Returns latest rainfall observed by oracle.
  /// @return Last fulfilled rainfall value in millimeters.
  function latestRainfallMm() external view returns (uint256);

  /// @notice Returns timestamp of latest oracle update.
  /// @return Last oracle update timestamp as unix seconds.
  function lastOracleUpdateTimestamp() external view returns (uint64);

  /// @notice Returns policy start timestamp.
  /// @return Start timestamp as unix seconds.
  function startTimestamp() external view returns (uint64);

  /// @notice Returns policy end timestamp.
  /// @return End timestamp as unix seconds.
  function endTimestamp() external view returns (uint64);
}
