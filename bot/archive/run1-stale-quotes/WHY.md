# Why this run doesn't count

This run (Nov 25, 08:58-14:43 UTC) showed takeoffs 16/16 and dip buys 14/15. But it read Kalshi prices
from the market LIST endpoint, whose prices only changed about once every 28 seconds (748 changes in
19,610 one-second ticks). So when BTC jumped, the bot "bought" at a Kalshi price that was up to ~30s old.
The real order book had usually already moved. The wins came from stale prices, not a real edge.

The radar page v32 uses the same endpoint, which likely explains why its paper results looked great
while real-money orders often didn't fill or lost.

From the next run on, the bot reads the live order book (`/markets/{ticker}/orderbook`) every second.
