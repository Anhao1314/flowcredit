"""FlowCredit Quant — a private, deterministic-first quantitative research agent.

Three rules, enforced in code rather than in prose:

1. The LLM may propose hypotheses. It may never write orders, positions, limits,
   or risk decisions.
2. A number without an out-of-sample record is not evidence. The report says
   NOT_RUN where it has not run.
3. If the data is invalid, missing, or misaligned, the system fails closed and
   does not trade.

This package is a research and paper-trading harness. It is not a live trading
system and it does not claim a calibrated probability of profit.
"""

from .config import VERSION

__all__ = ["VERSION"]