# Brain backups

`brain-v22-2026-11-22.json`: the radar page's "Copy brain" backup from Nov 22, 2026 (2:12 PM CT),
from when the paper trading was winning.

What it shows (61 paper auto-trades, Nov 20-22):

| Trade type | Trades | Won | P&L (cents/contract) |
|---|---|---|---|
| rocket | 9 | 9 | +158.5 |
| dip | 13 | 10 | +111.4 |
| ai | 9 | 5 | +12.7 |
| flip | 8 | 4 | -63.2 |
| older/untyped | 22 | 7 | -111.3 |

- Rocket and dip trades **sold early into strength**. On the 8 trades with both numbers saved,
  the bot's early exits made +88¢ total; holding the same trades to the end would have made +18¢.
- Paper account: $30 -> $33.83, 11 of 15 won.
- Flip watch alerts: 74 of 186 hit (40%).
- Flip learner: honest at low readings, overconfident at high ones (says 90%+, actually ~55%).
- Every scalp backtest it ran was negative.

Small sample: 2 days. Treat it as a lead, not proof.
