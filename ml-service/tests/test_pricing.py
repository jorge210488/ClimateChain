"""
Pricing arithmetic and the invariants a quote has to satisfy.

The one that matters most: a quote must be creatable. A premium the provider
would reject is worse than no quote, because the caller only finds out after
paying gas.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.core.domain import minimum_premium_wei
from app.core.money import format_wei_to_eth, parse_eth_to_wei
from app.models.artifact import load_artifact
from app.models.baseline import PricingInputs, assess_risk
from app.services.pricing import coverage_window_days, quote_premium
from tests.conftest_helpers import ARTIFACT_PATH


@pytest.fixture(scope="module")
def artifact():
    return load_artifact(ARTIFACT_PATH)


class TestCoverageWindow:
    def test_counts_both_endpoints(self) -> None:
        # A policy covering only the first of April covers one day, not zero.
        assert coverage_window_days(date(2026, 4, 1), date(2026, 4, 1)) == 1

    def test_spans_a_calendar_month(self) -> None:
        assert coverage_window_days(date(2026, 4, 1), date(2026, 4, 30)) == 30


class TestPremiumFloor:
    def test_never_quotes_below_the_on_chain_minimum(self, artifact) -> None:
        # The cheapest case the API accepts: driest region, highest threshold,
        # shortest window. Expected loss here is far under 1% of coverage, so
        # the floor is what stops the quote being uninsurable.
        quote = quote_premium(
            artifact=artifact,
            region="lima",
            coverage_eth="1.0",
            rainfall_threshold_mm=300,
            start_date=date(2026, 4, 1),
            end_date=date(2026, 4, 1),
        )

        floor = minimum_premium_wei(parse_eth_to_wei("1.0"))
        assert quote.premium_wei >= floor
        assert quote.floored_to_minimum is True

    def test_reports_when_risk_exceeds_the_floor(self, artifact) -> None:
        # Wettest region, low threshold, full year: expected loss dominates and
        # the floor is not what sets the price.
        quote = quote_premium(
            artifact=artifact,
            region="medellin",
            coverage_eth="1.0",
            rainfall_threshold_mm=10,
            start_date=date(2026, 1, 1),
            end_date=date(2026, 12, 31),
        )

        assert quote.floored_to_minimum is False
        assert quote.premium_wei > minimum_premium_wei(parse_eth_to_wei("1.0"))

    @pytest.mark.parametrize(
        "coverage_eth",
        ["0.000000000000000001", "0.01", "1.0", "1000.0", "0.000000000000000007"],
    )
    def test_floor_holds_across_magnitudes(self, artifact, coverage_eth: str) -> None:
        # Including amounts small enough that ceiling division is the only thing
        # keeping the premium above the ratio.
        quote = quote_premium(
            artifact=artifact,
            region="valencia",
            coverage_eth=coverage_eth,
            rainfall_threshold_mm=200,
            start_date=date(2026, 4, 1),
            end_date=date(2026, 4, 10),
        )

        assert quote.premium_wei >= minimum_premium_wei(parse_eth_to_wei(coverage_eth))


class TestPricingBehaviour:
    def test_is_deterministic(self, artifact) -> None:
        # Same inputs, same price. A quote that drifts between calls cannot be
        # honoured, and nothing here should depend on wall-clock or ordering.
        arguments = {
            "artifact": artifact,
            "region": "Valencia",
            "coverage_eth": "1.0",
            "rainfall_threshold_mm": 50,
            "start_date": date(2026, 4, 1),
            "end_date": date(2026, 4, 30),
        }

        first = quote_premium(**arguments)
        second = quote_premium(**arguments)

        assert first == second

    def test_a_higher_threshold_is_cheaper(self, artifact) -> None:
        # Harder to trigger means less expected loss. If this inverted, the model
        # would be pricing the risk backwards.
        def price(threshold: int) -> int:
            return quote_premium(
                artifact=artifact,
                region="bogota",
                coverage_eth="1.0",
                rainfall_threshold_mm=threshold,
                start_date=date(2026, 1, 1),
                end_date=date(2026, 6, 30),
            ).premium_wei

        assert price(200) < price(80) < price(20)

    def test_a_longer_window_is_dearer(self, artifact) -> None:
        def price(end: date) -> int:
            return quote_premium(
                artifact=artifact,
                region="bogota",
                coverage_eth="1.0",
                rainfall_threshold_mm=80,
                start_date=date(2026, 1, 1),
                end_date=end,
            ).premium_wei

        assert price(date(2026, 1, 31)) < price(date(2026, 6, 30))

    def test_a_wetter_region_is_dearer(self, artifact) -> None:
        # Threshold chosen so every region prices above the floor. At a higher
        # threshold the dry regions all sit on the minimum and compare equal,
        # which is the floor working rather than the ordering failing — see
        # test_the_floor_compresses_low_risk_quotes.
        def price(region: str) -> int:
            return quote_premium(
                artifact=artifact,
                region=region,
                coverage_eth="1.0",
                rainfall_threshold_mm=20,
                start_date=date(2026, 1, 1),
                end_date=date(2026, 6, 30),
            ).premium_wei

        assert price("lima") < price("valencia") < price("medellin")

    def test_the_floor_compresses_low_risk_quotes(self, artifact) -> None:
        # A consequence worth stating rather than discovering: below the
        # provider's minimum ratio every risk prices the same, so the service
        # cannot distinguish a dry region from a very dry one. That is inherent
        # to having a floor, and the flag is how a caller can tell the premium
        # reflects the minimum rather than the model.
        def quote(region: str):
            return quote_premium(
                artifact=artifact,
                region=region,
                coverage_eth="1.0",
                rainfall_threshold_mm=50,
                start_date=date(2026, 1, 1),
                end_date=date(2026, 6, 30),
            )

        lima, valencia = quote("lima"), quote("valencia")

        assert lima.premium_wei == valencia.premium_wei
        assert lima.floored_to_minimum and valencia.floored_to_minimum
        # The risk estimates still differ; only the price is clamped.
        assert lima.trigger_probability < valencia.trigger_probability

    def test_region_matching_ignores_case_and_padding(self, artifact) -> None:
        # The backend passes through whatever the caller typed; a region should
        # not become unknown because it arrived capitalised.
        spaced = quote_premium(
            artifact=artifact,
            region="  VALENCIA  ",
            coverage_eth="1.0",
            rainfall_threshold_mm=50,
            start_date=date(2026, 4, 1),
            end_date=date(2026, 4, 30),
        )

        assert spaced.region_known is True

    def test_an_unknown_region_is_priced_as_typical(self, artifact) -> None:
        # Neither free nor worst-case: an unpriceable region would make the
        # service refuse business it can reasonably quote.
        quote = quote_premium(
            artifact=artifact,
            region="Atlantis",
            coverage_eth="1.0",
            rainfall_threshold_mm=50,
            start_date=date(2026, 4, 1),
            end_date=date(2026, 4, 30),
        )

        assert quote.region_known is False
        assert quote.premium_wei > 0

    def test_premium_strings_round_trip_exactly(self, artifact) -> None:
        # The backend will feed premiumEth straight into policy creation, which
        # parses it back to wei. A lossy render would revert on the minimum.
        quote = quote_premium(
            artifact=artifact,
            region="Valencia",
            coverage_eth="3.7",
            rainfall_threshold_mm=45,
            start_date=date(2026, 4, 1),
            end_date=date(2026, 5, 15),
        )

        assert parse_eth_to_wei(quote.premium_eth) == quote.premium_wei
        assert format_wei_to_eth(quote.premium_wei) == quote.premium_eth


class TestRiskAssessment:
    def test_probability_stays_inside_bounds(self, artifact) -> None:
        # Extremes on both ends: a probability of 0 or 1 would price coverage as
        # free or as certain loss.
        for threshold, region in ((1, "medellin"), (10_000, "lima")):
            assessment = assess_risk(
                artifact,
                PricingInputs(
                    region=region,
                    rainfall_threshold_mm=threshold,
                    duration_days=365,
                ),
            )
            assert 0.0 < assessment.trigger_probability < 1.0
