from decimal import Decimal, localcontext

from ..models.domain import DomainError, instant_ms


def fixed_scale_map(domain, intervals, map_id, serialize):
    if not isinstance(intervals, list) or len(intervals) > 32:
        raise DomainError("invalid_scale", "At most 32 magnified intervals are supported.")
    start, end = instant_ms(domain["from"]), instant_ms(domain["to"])
    spans = []
    for interval in intervals:
        if not isinstance(interval, dict) or set(interval) != {"from", "to", "ratio"}:
            raise DomainError("invalid_scale", "Invalid magnified interval.")
        a, b, ratio = instant_ms(interval["from"]), instant_ms(interval["to"]), interval["ratio"]
        if a >= b or type(ratio) not in (int, float) or not 1 <= ratio <= 10000:
            raise DomainError("invalid_scale", "Invalid magnified interval bounds or ratio.")
        spans.append((a, b, ratio))
    boundaries = sorted({start, end, *(t for span in spans for t in span[:2] if start < t < end)})
    with localcontext() as context:
        context.prec = 50
        masses = [Decimal(boundaries[i + 1] - a) * Decimal(str(max([1, *(ratio for left, right, ratio in spans if left <= a < right)]))) for i, a in enumerate(boundaries[:-1])]
        total, cumulative, knots = sum(masses), Decimal(0), []
        for time, mass in zip(boundaries, masses):
            knots.append({"timeMs": time, "u": serialize(cumulative / total)})
            cumulative += mass
        knots.append({"timeMs": end, "u": "1"})
    return {"mapId": map_id, "domain": domain, "knots": knots, "mode": "fixed" if intervals else "uniform", "ratio": max([1, *(span[2] for span in spans)])}
