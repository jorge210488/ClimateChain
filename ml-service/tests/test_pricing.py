"""
Pricing arithmetic and the invariants a quote has to satisfy.

The one that matters most: a quote must be creatable. A premium the provider
would reject is worse than no quote, because the caller only finds out after
paying gas.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.core.domain import minimum_premium_wei
from app.core.money import format_wei_to_eth, parse_eth_to_wei
from app.models.artifact import load_artifact
from app.models.baseline import PricingInputs, assess_risk, month_weights
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
        #
        # 120 mm in a day over one month: rare enough on the observed record
        # that the driest regions' expected loss sits well under 1% of cover.
        # The synthetic model floored these same regions at 50 mm over six
        # months; the observed one does not, because they genuinely differ
        # there — see test_a_wetter_region_is_dearer.
        def quote(region: str):
            return quote_premium(
                artifact=artifact,
                region=region,
                coverage_eth="1.0",
                rainfall_threshold_mm=120,
                start_date=date(2026, 1, 1),
                end_date=date(2026, 1, 31),
            )

        lima, sevilla = quote("lima"), quote("sevilla")

        assert lima.premium_wei == sevilla.premium_wei
        assert lima.floored_to_minimum and sevilla.floored_to_minimum
        # The risk estimates still differ; only the price is clamped.
        assert lima.trigger_probability < sevilla.trigger_probability

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
                    start_date=date(2026, 1, 1),
                ),
            )
            assert 0.0 < assessment.trigger_probability < 1.0

    def test_a_seasonal_model_needs_the_start_date(self, artifact) -> None:
        # Duration alone no longer identifies the risk; refusing here is what
        # stops a caller from silently getting the un-seasonal price.
        with pytest.raises(ValueError, match="start date"):
            assess_risk(
                artifact,
                PricingInputs(
                    region="sevilla", rainfall_threshold_mm=20, duration_days=30
                ),
            )


class TestSeasonality:
    """
    A product sold by dates must price the dates. Sevilla in April and Sevilla
    in November are different risks, and a model that charged the same for
    both would be bought only for the wet months.
    """

    def _quote(self, artifact, region: str, start: date, days: int, threshold: int):
        return quote_premium(
            artifact=artifact,
            region=region,
            coverage_eth="1.0",
            rainfall_threshold_mm=threshold,
            start_date=start,
            end_date=start + timedelta(days=days - 1),
        )

    def test_month_weights_follow_the_calendar(self) -> None:
        weights = month_weights(date(2026, 3, 20), 30)
        assert weights[2] == pytest.approx(12 / 30)  # 20..31 March
        assert weights[3] == pytest.approx(18 / 30)  # 1..18 April
        assert sum(weights) == pytest.approx(1.0)
        assert month_weights(date(2026, 1, 1), 365)[0] == pytest.approx(31 / 365)

    def test_the_wet_season_is_dearer_than_the_dry_one(self, artifact) -> None:
        # Sevilla: autumn rain, dry summers. Same product, same coverage, two
        # start dates.
        november = self._quote(artifact, "sevilla", date(2026, 11, 1), 30, 20)
        july = self._quote(artifact, "sevilla", date(2026, 7, 1), 30, 20)
        assert november.trigger_probability > july.trigger_probability
        assert november.premium_wei > july.premium_wei

    def test_a_full_year_is_nearly_season_free(self, artifact) -> None:
        # Twelve months touch every offset about equally, and the offsets are
        # centred, so the start date barely matters for an annual policy.
        january = self._quote(artifact, "sevilla", date(2026, 1, 1), 365, 120)
        july = self._quote(artifact, "sevilla", date(2026, 7, 1), 365, 120)
        assert abs(january.trigger_probability - july.trigger_probability) < 0.01

    def test_an_unknown_region_has_no_season(self, artifact) -> None:
        # Nothing the model can vouch for, so the typical-region price does not
        # pretend to know when it rains in Atlantis.
        january = self._quote(artifact, "Atlantis", date(2026, 1, 1), 30, 50)
        july = self._quote(artifact, "Atlantis", date(2026, 7, 1), 30, 50)
        assert january.premium_wei == july.premium_wei


class TestEvidenceFloor:
    """
    The record can prove more than a fitted slope can reach. A 30 mm day in
    Valencia within any given year is close to certain; the linear model says
    about half. The floor is the record's lower confidence bound, applied to
    every quote that dominates the cell it came from.
    """

    def _assess(self, artifact, region: str, threshold: int, days: int):
        return assess_risk(
            artifact,
            PricingInputs(
                region=region,
                rainfall_threshold_mm=threshold,
                duration_days=days,
                start_date=date(2026, 1, 1),
            ),
        )

    def test_the_record_sets_the_price_where_the_model_falls_short(
        self, artifact
    ) -> None:
        assessment = self._assess(artifact, "valencia", 30, 365)
        bound = max(
            p
            for d, th, p in artifact.evidence_floor["valencia"]
            if d <= 365 and th >= 30
        )
        assert assessment.priced_from_evidence is True
        assert assessment.trigger_probability == bound > assessment.model_probability
        # What 24 training years prove at 95%, not the holdout's six-of-six:
        # the bound is deliberately what the record can stand behind.
        assert bound > 0.3

    def test_the_floor_only_uses_cells_the_quote_dominates(self, artifact) -> None:
        # A shorter window at a higher threshold is a smaller risk than every
        # cell with a longer window and a lower threshold; nothing it does not
        # dominate may raise its price.
        assessment = self._assess(artifact, "valencia", 300, 7)
        dominated = [
            p
            for d, th, p in artifact.evidence_floor.get("valencia", ())
            if d <= 7 and th >= 300
        ]
        assert assessment.evidence_floor == (max(dominated) if dominated else 0.0)

    def test_the_price_stays_monotone_with_the_floor(self, artifact) -> None:
        longer = self._assess(artifact, "valencia", 30, 365).trigger_probability
        shorter = self._assess(artifact, "valencia", 30, 180).trigger_probability
        lower_threshold = self._assess(
            artifact, "valencia", 20, 365
        ).trigger_probability
        assert longer >= shorter
        assert lower_threshold >= longer

    def test_a_dry_quote_is_priced_by_the_model(self, artifact) -> None:
        assessment = self._assess(artifact, "lima", 300, 7)
        assert assessment.priced_from_evidence is False
        assert assessment.trigger_probability == assessment.model_probability

    def test_the_quote_reports_it(self, artifact) -> None:
        quote = quote_premium(
            artifact=artifact,
            region="valencia",
            coverage_eth="1.0",
            rainfall_threshold_mm=30,
            start_date=date(2026, 1, 1),
            end_date=date(2026, 12, 31),
        )
        assert quote.priced_from_evidence is True
        assert quote.extrapolated is False


class TestTrainedDomain:
    """
    The API accepts windows from one day and thresholds from 1 mm; the model
    was measured on 7..365 days and 10..300 mm. Outside that it extrapolates
    its functional form, and the quote says so rather than looking measured.
    """

    def _quote(self, artifact, threshold: int, days: int):
        start = date(2026, 1, 1)
        return quote_premium(
            artifact=artifact,
            region="valencia",
            coverage_eth="1.0",
            rainfall_threshold_mm=threshold,
            start_date=start,
            end_date=start + timedelta(days=days - 1),
        )

    @pytest.mark.parametrize(("threshold", "days"), [(50, 30), (10, 7), (300, 365)])
    def test_inside_the_grid_is_measured(self, artifact, threshold, days) -> None:
        assert self._quote(artifact, threshold, days).extrapolated is False

    @pytest.mark.parametrize(
        ("threshold", "days"),
        [(50, 1), (50, 6), (9, 30), (301, 30), (2**53 - 1, 30)],
    )
    def test_outside_the_grid_is_flagged(self, artifact, threshold, days) -> None:
        quote = self._quote(artifact, threshold, days)
        assert quote.extrapolated is True
        # Still a quote: flagged, not refused.
        assert quote.premium_wei > 0
