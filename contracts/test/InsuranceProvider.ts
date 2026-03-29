import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const POLICY_STATUS = {
  Created: 0n,
  Active: 1n,
  Triggered: 2n,
  PaidOut: 3n,
  Expired: 4n,
} as const;

describe("InsuranceProvider", function () {
  async function deployFixture() {
    const [owner, insured] = await ethers.getSigners();

    const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
    const oracle = await oracleFactory.deploy(owner.address);
    await oracle.waitForDeployment();

    const providerFactory = await ethers.getContractFactory("InsuranceProvider");
    const provider = await providerFactory.deploy(owner.address, await oracle.getAddress());
    await provider.waitForDeployment();

    await provider.fundCoverageReserve({ value: ethers.parseEther("5") });

    return { owner, insured, oracle, provider };
  }

  async function createPolicyForInsured(
    provider: Awaited<ReturnType<typeof deployFixture>>["provider"],
    insured: Awaited<ReturnType<typeof deployFixture>>["insured"],
    coverage: bigint,
    premium: bigint,
    threshold = 30,
    durationDays = 14,
  ) {
    await provider
      .connect(insured)
      .createPolicy(coverage, threshold, durationDays, { value: premium });

    const [policyAddress] = await provider.getPoliciesByInsured(insured.address);
    const policy = await ethers.getContractAt("InsurancePolicy", policyAddress);

    return { policyAddress, policy };
  }

  it("creates and tracks policy by insured account", async function () {
    const { insured, provider } = await deployFixture();

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");

    await expect(
      provider.connect(insured).createPolicy(coverage, 30, 14, { value: premium }),
    ).to.emit(provider, "PolicyCreated");

    const policies = await provider.getPoliciesByInsured(insured.address);
    expect(policies).to.have.length(1);

    const policy = await ethers.getContractAt("InsurancePolicy", policies[0]);

    expect(await policy.insured()).to.equal(insured.address);
    expect(await policy.status()).to.equal(POLICY_STATUS.Active);
    expect(await policy.premiumWei()).to.equal(premium);
    expect(await provider.coverageReserveWei()).to.equal(ethers.parseEther("4.0"));
    expect(await provider.premiumBalanceWei()).to.equal(0n);
  });

  it("executes payout after oracle threshold is met and books premium separately", async function () {
    const { owner, insured, oracle, provider } = await deployFixture();

    const premium = ethers.parseEther("0.15");
    const coverage = ethers.parseEther("1.5");
    const threshold = 50;

    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      threshold,
      20,
    );

    await oracle.pushWeatherData(policyAddress, threshold + 1);

    expect(await policy.conditionMet()).to.equal(true);
    expect(await policy.status()).to.equal(POLICY_STATUS.Triggered);

    const insuredBalanceBefore = await ethers.provider.getBalance(insured.address);

    const payoutTx = await provider.connect(owner).executePolicyPayout(policyAddress);
    await payoutTx.wait();

    const insuredBalanceAfter = await ethers.provider.getBalance(insured.address);

    expect(insuredBalanceAfter - insuredBalanceBefore).to.equal(coverage);
    expect(await policy.status()).to.equal(POLICY_STATUS.PaidOut);
    expect(await provider.coverageReserveWei()).to.equal(ethers.parseEther("3.5"));
    expect(await provider.premiumBalanceWei()).to.equal(ethers.parseEther("0.15"));
  });

  it("returns coverage to reserve and books premium separately when policy expires", async function () {
    const { insured, provider } = await deployFixture();

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");

    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      25,
      1,
    );

    expect(await provider.coverageReserveWei()).to.equal(ethers.parseEther("4.0"));

    const endTimestamp = await policy.endTimestamp();
    await time.increaseTo(Number(endTimestamp));

    await expect(provider.expirePolicy(policyAddress))
      .to.emit(provider, "PolicyExpired")
      .withArgs(policyAddress, coverage, premium);

    expect(await policy.status()).to.equal(POLICY_STATUS.Expired);
    expect(await provider.coverageReserveWei()).to.equal(ethers.parseEther("5.0"));
    expect(await provider.premiumBalanceWei()).to.equal(ethers.parseEther("0.10"));
    expect(await policy.getCurrentBalance()).to.equal(0n);
  });

  it("rejects policy creation when premium is below minimum ratio", async function () {
    const { insured, provider } = await deployFixture();

    const coverage = ethers.parseEther("1.0");
    const premiumBelowMinimum = ethers.parseEther("0.009");

    await expect(
      provider.connect(insured).createPolicy(coverage, 20, 10, { value: premiumBelowMinimum }),
    ).to.be.revertedWithCustomError(provider, "PremiumBelowMinimum");
  });

  it("rejects policy creation when duration exceeds configured maximum", async function () {
    const { insured, provider } = await deployFixture();

    const coverage = ethers.parseEther("1.0");
    const premium = ethers.parseEther("0.10");
    const maxDurationDays = await provider.MAX_DURATION_DAYS();

    await expect(
      provider.connect(insured).createPolicy(coverage, 20, Number(maxDurationDays) + 1, {
        value: premium,
      }),
    ).to.be.revertedWithCustomError(provider, "DurationDaysExceedsMaximum");
  });

  it("withdraws premium balance without affecting coverage reserve", async function () {
    const { owner, insured, oracle, provider } = await deployFixture();

    const premium = ethers.parseEther("0.20");
    const coverage = ethers.parseEther("1.0");
    const threshold = 15;

    const { policyAddress } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      threshold,
      10,
    );

    await oracle.pushWeatherData(policyAddress, threshold + 1);
    await provider.connect(owner).executePolicyPayout(policyAddress);

    const reserveBeforeWithdraw = await provider.coverageReserveWei();
    const insuredBalanceBefore = await ethers.provider.getBalance(insured.address);

    await provider.withdrawPremiumBalance(premium, insured.address);

    const insuredBalanceAfter = await ethers.provider.getBalance(insured.address);

    expect(insuredBalanceAfter - insuredBalanceBefore).to.equal(premium);
    expect(await provider.premiumBalanceWei()).to.equal(0n);
    expect(await provider.coverageReserveWei()).to.equal(reserveBeforeWithdraw);
  });

  it("rejects policy creation when reserve is insufficient", async function () {
    const { insured, provider } = await deployFixture();

    const premium = ethers.parseEther("0.2");
    const requestedCoverage = ethers.parseEther("9");

    await expect(
      provider.connect(insured).createPolicy(requestedCoverage, 20, 10, { value: premium }),
    ).to.be.revertedWithCustomError(provider, "InsufficientCoverageReserve");
  });

  it("rejects duplicate payout attempts", async function () {
    const { owner, insured, oracle, provider } = await deployFixture();

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");
    const threshold = 10;

    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      threshold,
      10,
    );

    await oracle.pushWeatherData(policyAddress, threshold + 1);
    await provider.connect(owner).executePolicyPayout(policyAddress);

    await expect(
      provider.connect(owner).executePolicyPayout(policyAddress),
    ).to.be.revertedWithCustomError(provider, "PolicyAlreadySettledInProvider");
  });

  it("rejects unauthorized policy and oracle actions", async function () {
    const { insured, oracle, provider } = await deployFixture();

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");
    const { policyAddress } = await createPolicyForInsured(provider, insured, coverage, premium);

    await expect(
      provider.connect(insured).requestPolicyWeatherData(policyAddress),
    ).to.be.revertedWithCustomError(provider, "OwnableUnauthorizedAccount");

    await expect(
      oracle.connect(insured).pushWeatherData(policyAddress, 45),
    ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
  });

  it("rejects oracle pushes to non-policy addresses", async function () {
    const { insured, oracle } = await deployFixture();

    await expect(oracle.pushWeatherData(insured.address, 42)).to.be.revertedWithCustomError(
      oracle,
      "InvalidPolicyAddress",
    );
  });

  it("rejects weather updates and requests outside policy window", async function () {
    const { insured, oracle, provider } = await deployFixture();

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");
    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      15,
      1,
    );

    const endTimestamp = await policy.endTimestamp();
    await time.increaseTo(Number(endTimestamp));

    await expect(oracle.pushWeatherData(policyAddress, 50)).to.be.revertedWithCustomError(
      policy,
      "PolicyOutsideWeatherWindow",
    );

    await expect(provider.requestPolicyWeatherData(policyAddress)).to.be.revertedWithCustomError(
      policy,
      "PolicyOutsideWeatherWindow",
    );
  });

  it("rejects expiring a policy before end timestamp", async function () {
    const { insured, provider } = await deployFixture();

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");
    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      30,
      10,
    );

    await expect(provider.expirePolicy(policyAddress)).to.be.revertedWithCustomError(
      policy,
      "PolicyNotEnded",
    );
  });

  it("rejects weather request on unknown policy", async function () {
    const { provider } = await deployFixture();

    await expect(
      provider.requestPolicyWeatherData(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(provider, "UnknownPolicyAddress");
  });

  it("rejects out-of-range policy index lookups", async function () {
    const { provider } = await deployFixture();

    await expect(provider.getPolicyAt(0)).to.be.revertedWithCustomError(
      provider,
      "PolicyIndexOutOfBounds",
    );
  });
});
