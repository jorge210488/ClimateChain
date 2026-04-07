import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const POLICY_STATUS = {
  Active: 1n,
  Triggered: 2n,
  PaidOut: 3n,
  Expired: 4n,
} as const;

type SettlementPath = "payout" | "expiry";

interface PolicySpec {
  coverageWei: bigint;
  thresholdMm: number;
  durationDays: number;
  premiumMarginWei: bigint;
  settlement: SettlementPath;
}

interface CreatedPolicy {
  policyAddress: string;
  policy: Awaited<ReturnType<typeof ethers.getContractAt>>;
  premiumWei: bigint;
  coverageWei: bigint;
  thresholdMm: number;
  settlement: SettlementPath;
}

interface CoverageAccountingSnapshot {
  unsettledCoverageWei: bigint;
  payoutCoverageWei: bigint;
  expiredCoverageWei: bigint;
  totalCoverageWei: bigint;
}

describe("InsuranceProvider invariants", function () {
  async function deployFixture() {
    const [owner, insuredA, insuredB] = await ethers.getSigners();

    const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
    const oracle = await oracleFactory.deploy(owner.address);
    await oracle.waitForDeployment();

    const providerFactory = await ethers.getContractFactory("InsuranceProvider");
    const provider = await providerFactory.deploy(owner.address, await oracle.getAddress());
    await provider.waitForDeployment();

    await oracle.setPolicyRegistry(await provider.getAddress());
    await provider.fundCoverageReserve({ value: ethers.parseEther("12") });

    return { owner, insuredA, insuredB, oracle, provider };
  }

  async function moveToAtLeast(targetTimestamp: bigint) {
    const currentTimestamp = await time.latest();
    if (currentTimestamp < Number(targetTimestamp)) {
      await time.increaseTo(Number(targetTimestamp));
    }
  }

  async function computeMinimumPremiumWei(
    provider: Awaited<ReturnType<typeof deployFixture>>["provider"],
    coverageWei: bigint,
  ) {
    const minPremiumBps = await provider.MIN_PREMIUM_BPS();
    const bpsDenominator = await provider.BASIS_POINTS_DENOMINATOR();

    return (coverageWei * minPremiumBps + bpsDenominator - 1n) / bpsDenominator;
  }

  async function createPolicyBySpec(
    provider: Awaited<ReturnType<typeof deployFixture>>["provider"],
    insured: Awaited<ReturnType<typeof deployFixture>>["insuredA"],
    spec: PolicySpec,
  ): Promise<CreatedPolicy> {
    const minimumPremiumWei = await computeMinimumPremiumWei(provider, spec.coverageWei);
    const premiumWei = minimumPremiumWei + spec.premiumMarginWei;

    await provider
      .connect(insured)
      .createPolicy(spec.coverageWei, spec.thresholdMm, spec.durationDays, { value: premiumWei });

    const policies = await provider.getPoliciesByInsured(insured.address);
    const policyAddress = policies[policies.length - 1];
    const policy = await ethers.getContractAt("InsurancePolicy", policyAddress);

    return {
      policyAddress,
      policy,
      premiumWei,
      coverageWei: spec.coverageWei,
      thresholdMm: spec.thresholdMm,
      settlement: spec.settlement,
    };
  }

  async function createPolicyBySpecWithMetadata(
    provider: Awaited<ReturnType<typeof deployFixture>>["provider"],
    insured: Awaited<ReturnType<typeof deployFixture>>["insuredA"],
    spec: PolicySpec,
    metadataLabel: string,
  ): Promise<CreatedPolicy> {
    const minimumPremiumWei = await computeMinimumPremiumWei(provider, spec.coverageWei);
    const premiumWei = minimumPremiumWei + spec.premiumMarginWei;

    const currentTimestamp = await time.latest();
    const leadTimeSeconds = await provider.MIN_POLICY_START_LEAD_TIME_SECONDS();
    const requestedStartTimestamp = BigInt(currentTimestamp) + leadTimeSeconds + 120n;
    const regionCode = ethers.encodeBytes32String(metadataLabel);

    await provider
      .connect(insured)
      .createPolicyWithMetadata(
        spec.coverageWei,
        spec.thresholdMm,
        spec.durationDays,
        regionCode,
        requestedStartTimestamp,
        { value: premiumWei },
      );

    const policies = await provider.getPoliciesByInsured(insured.address);
    const policyAddress = policies[policies.length - 1];
    const policy = await ethers.getContractAt("InsurancePolicy", policyAddress);

    const [storedRegionCode, storedRequestedStartTimestamp] =
      await provider.getPolicyMetadata(policyAddress);
    expect(storedRegionCode).to.equal(regionCode);
    expect(storedRequestedStartTimestamp).to.equal(requestedStartTimestamp);
    expect(await policy.regionCode()).to.equal(regionCode);

    return {
      policyAddress,
      policy,
      premiumWei,
      coverageWei: spec.coverageWei,
      thresholdMm: spec.thresholdMm,
      settlement: spec.settlement,
    };
  }

  async function assertAccountingInvariant(
    provider: Awaited<ReturnType<typeof deployFixture>>["provider"],
  ) {
    const reserveWei = await provider.coverageReserveWei();
    const premiumWei = await provider.premiumBalanceWei();
    const trackedWei = await provider.getTrackedBalance();
    const deficitWei = await provider.getBalanceDeficit();
    const untrackedWei = await provider.getUntrackedBalance();
    const onChainBalanceWei = await ethers.provider.getBalance(await provider.getAddress());

    expect(trackedWei).to.equal(reserveWei + premiumWei);
    expect(deficitWei).to.equal(0n);
    expect(onChainBalanceWei).to.equal(trackedWei + untrackedWei);
  }

  async function snapshotCoverageAccounting(
    provider: Awaited<ReturnType<typeof deployFixture>>["provider"],
  ): Promise<CoverageAccountingSnapshot> {
    const totalPolicies = await provider.getAllPoliciesCount();
    let unsettledCoverageWei = 0n;
    let payoutCoverageWei = 0n;
    let expiredCoverageWei = 0n;
    let totalCoverageWei = 0n;

    for (let index = 0n; index < totalPolicies; index += 1n) {
      const policyAddress = await provider.getPolicyAt(index);
      const [coverageWei, , settled] = await provider.getPolicyFinancials(policyAddress);
      const [settlementType, settledAt] = await provider.getPolicySettlementInfo(policyAddress);

      totalCoverageWei += coverageWei;

      if (settlementType == 0n) {
        expect(settled).to.equal(false);
        expect(settledAt).to.equal(0n);
        unsettledCoverageWei += coverageWei;
      } else if (settlementType == 1n) {
        expect(settled).to.equal(true);
        expect(settledAt).to.be.gt(0n);
        payoutCoverageWei += coverageWei;
      } else {
        expect(settlementType).to.equal(2n);
        expect(settled).to.equal(true);
        expect(settledAt).to.be.gt(0n);
        expiredCoverageWei += coverageWei;
      }
    }

    return {
      unsettledCoverageWei,
      payoutCoverageWei,
      expiredCoverageWei,
      totalCoverageWei,
    };
  }

  async function assertReserveCoverageCrossAccountingInvariant(
    provider: Awaited<ReturnType<typeof deployFixture>>["provider"],
    initialReserveWei: bigint,
  ) {
    const reserveWei = await provider.coverageReserveWei();
    const coverageSnapshot = await snapshotCoverageAccounting(provider);

    expect(initialReserveWei - reserveWei).to.equal(
      coverageSnapshot.unsettledCoverageWei + coverageSnapshot.payoutCoverageWei,
    );
    expect(coverageSnapshot.totalCoverageWei).to.equal(
      coverageSnapshot.unsettledCoverageWei +
        coverageSnapshot.payoutCoverageWei +
        coverageSnapshot.expiredCoverageWei,
    );
  }

  it("preserves reserve and registration invariants across creation matrix", async function () {
    const { insuredA, insuredB, provider } = await loadFixture(deployFixture);

    const creationSpecs: PolicySpec[] = [
      {
        coverageWei: ethers.parseEther("0.40"),
        thresholdMm: 16,
        durationDays: 7,
        premiumMarginWei: 11n,
        settlement: "payout",
      },
      {
        coverageWei: ethers.parseEther("0.85"),
        thresholdMm: 28,
        durationDays: 14,
        premiumMarginWei: 17n,
        settlement: "expiry",
      },
      {
        coverageWei: ethers.parseEther("1.20"),
        thresholdMm: 35,
        durationDays: 21,
        premiumMarginWei: 23n,
        settlement: "payout",
      },
      {
        coverageWei: ethers.parseEther("0.65"),
        thresholdMm: 22,
        durationDays: 5,
        premiumMarginWei: 31n,
        settlement: "expiry",
      },
    ];

    const initialReserveWei = await provider.coverageReserveWei();
    let expectedReserveWei = initialReserveWei;

    for (let i = 0; i < creationSpecs.length; i += 1) {
      const insured = i % 2 === 0 ? insuredA : insuredB;
      const created = await createPolicyBySpec(provider, insured, creationSpecs[i]);
      expectedReserveWei -= created.coverageWei;

      expect(await provider.isPolicyCreated(created.policyAddress)).to.equal(true);
      expect(await created.policy.status()).to.equal(POLICY_STATUS.Active);
      expect(await provider.getAllPoliciesCount()).to.equal(BigInt(i + 1));
      expect(await provider.coverageReserveWei()).to.equal(expectedReserveWei);
      expect(await provider.premiumBalanceWei()).to.equal(0n);

      await assertAccountingInvariant(provider);
      await assertReserveCoverageCrossAccountingInvariant(provider, initialReserveWei);
    }
  });

  it("preserves reserve and registration invariants across metadata creation matrix", async function () {
    const { insuredA, insuredB, provider } = await loadFixture(deployFixture);

    const metadataCreationSpecs: PolicySpec[] = [
      {
        coverageWei: ethers.parseEther("0.55"),
        thresholdMm: 18,
        durationDays: 9,
        premiumMarginWei: 13n,
        settlement: "payout",
      },
      {
        coverageWei: ethers.parseEther("0.95"),
        thresholdMm: 30,
        durationDays: 15,
        premiumMarginWei: 21n,
        settlement: "expiry",
      },
      {
        coverageWei: ethers.parseEther("0.75"),
        thresholdMm: 27,
        durationDays: 6,
        premiumMarginWei: 35n,
        settlement: "payout",
      },
    ];

    const initialReserveWei = await provider.coverageReserveWei();
    let expectedReserveWei = initialReserveWei;

    for (let i = 0; i < metadataCreationSpecs.length; i += 1) {
      const insured = i % 2 === 0 ? insuredA : insuredB;
      const created = await createPolicyBySpecWithMetadata(
        provider,
        insured,
        metadataCreationSpecs[i],
        `INV_META_${i}`,
      );
      expectedReserveWei -= created.coverageWei;

      expect(await provider.isPolicyCreated(created.policyAddress)).to.equal(true);
      expect(await created.policy.status()).to.equal(POLICY_STATUS.Active);
      expect(await created.policy.getStatus()).to.be.lte(4n);
      expect(await provider.getAllPoliciesCount()).to.equal(BigInt(i + 1));
      expect(await provider.coverageReserveWei()).to.equal(expectedReserveWei);
      expect(await provider.premiumBalanceWei()).to.equal(0n);

      await assertAccountingInvariant(provider);
      await assertReserveCoverageCrossAccountingInvariant(provider, initialReserveWei);
    }
  });

  it("preserves settlement accounting invariants across payout and expiry matrix", async function () {
    const { owner, insuredA, insuredB, oracle, provider } = await loadFixture(deployFixture);

    const settlementSpecs: PolicySpec[] = [
      {
        coverageWei: ethers.parseEther("0.70"),
        thresholdMm: 19,
        durationDays: 8,
        premiumMarginWei: 13n,
        settlement: "payout",
      },
      {
        coverageWei: ethers.parseEther("1.10"),
        thresholdMm: 26,
        durationDays: 12,
        premiumMarginWei: 29n,
        settlement: "payout",
      },
      {
        coverageWei: ethers.parseEther("0.50"),
        thresholdMm: 40,
        durationDays: 1,
        premiumMarginWei: 19n,
        settlement: "expiry",
      },
      {
        coverageWei: ethers.parseEther("0.90"),
        thresholdMm: 33,
        durationDays: 1,
        premiumMarginWei: 37n,
        settlement: "expiry",
      },
    ];

    const createdPolicies: CreatedPolicy[] = [];
    const initialReserveWei = await provider.coverageReserveWei();
    let expectedReserveWei = initialReserveWei;
    let expectedPremiumBalanceWei = 0n;

    for (let i = 0; i < settlementSpecs.length; i += 1) {
      const insured = i % 2 === 0 ? insuredA : insuredB;
      const created = await createPolicyBySpec(provider, insured, settlementSpecs[i]);
      createdPolicies.push(created);
      expectedReserveWei -= created.coverageWei;
    }

    expect(await provider.coverageReserveWei()).to.equal(expectedReserveWei);
    await assertAccountingInvariant(provider);
    await assertReserveCoverageCrossAccountingInvariant(provider, initialReserveWei);

    for (const created of createdPolicies) {
      if (created.settlement === "payout") {
        await moveToAtLeast(await created.policy.startTimestamp());
        await oracle.pushWeatherData(created.policyAddress, created.thresholdMm + 1);

        expect(await created.policy.status()).to.equal(POLICY_STATUS.Triggered);

        await provider.connect(owner).executePolicyPayout(created.policyAddress);

        expectedPremiumBalanceWei += created.premiumWei;
        expect(await created.policy.status()).to.equal(POLICY_STATUS.PaidOut);

        const [settlementType, settledAt] = await provider.getPolicySettlementInfo(
          created.policyAddress,
        );
        expect(settlementType).to.equal(1n);
        expect(settledAt).to.be.gt(0n);
      } else {
        await moveToAtLeast(await created.policy.endTimestamp());
        await provider.connect(owner).expirePolicy(created.policyAddress);

        expectedReserveWei += created.coverageWei;
        expectedPremiumBalanceWei += created.premiumWei;
        expect(await created.policy.status()).to.equal(POLICY_STATUS.Expired);

        const [settlementType, settledAt] = await provider.getPolicySettlementInfo(
          created.policyAddress,
        );
        expect(settlementType).to.equal(2n);
        expect(settledAt).to.be.gt(0n);
      }

      const [coverageWei, premiumWei, settled] = await provider.getPolicyFinancials(
        created.policyAddress,
      );
      expect(coverageWei).to.equal(created.coverageWei);
      expect(premiumWei).to.equal(created.premiumWei);
      expect(settled).to.equal(true);

      expect(await provider.coverageReserveWei()).to.equal(expectedReserveWei);
      expect(await provider.premiumBalanceWei()).to.equal(expectedPremiumBalanceWei);
      await assertAccountingInvariant(provider);
      await assertReserveCoverageCrossAccountingInvariant(provider, initialReserveWei);
    }
  });
});
