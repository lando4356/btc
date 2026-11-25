KALSHI REAL-MONEY BOT — setup on your MacBook
==============================================

WHAT CHANGED IN v47.3
- Kalshi's live prices now show right in the main box, under the % line: "Kalshi: Up 47¢ · Down 55¢"
  (what it costs to buy each side right now). Before, they were only under "details".
- For your phone: upload the cloudflare-upload folder to Cloudflare Pages again so pages.dev gets this.

WHAT CHANGED IN v47.2 (Kalshi live price on the Mac)
- The bot now gets Kalshi's live prices WITH your API key (it used to ask without it), and retries when Kalshi
  says "too many requests". Before, that made prices drop out.
- It no longer sends the page the window that just closed (that made the page say "Kalshi offline" at rollovers).
- It asks Kalshi at most once every 0.8s for prices, however often the page asks.
- The Terminal now prints "Kalshi live prices: connected" or the exact problem (at most once a minute).

KALSHI PRICE NOT SHOWING? (v47.1)
The box now says why, e.g. "Kalshi offline (relay not set up: tap details)". Tap "details" for the full reason.
- On the Mac: open http://localhost:8787 (from the bot), not a saved file. The page uses the bot's own relay.
- On your phone (pages.dev): Cloudflare has to serve the relay too. In your Cloudflare Pages project, upload
  ONLY the "cloudflare-upload" folder from this zip (it has index.html + _worker.js). Nothing else.
  !! NEVER upload the Mac bot folder to Cloudflare: it contains your Kalshi key (kalshi-key.pem). !!
- "relay not set up": the site sent back a web page instead of prices, so _worker.js isn't deployed. Re-upload
  the cloudflare-upload folder.
- "Kalshi refused the relay": Cloudflare reached Kalshi but Kalshi said no (for example 403). Use the Mac
  page (http://localhost:8787) instead; the bot asks Kalshi from your own internet connection.
- "relay unreachable": the URL in the details box is wrong or the site is down. If a saved URL keeps
  failing, the page now switches to its own relay by itself.
- Right at :00/:15/:30/:45 it can drop out for a few seconds while Kalshi opens the next window. Normal.

WHAT CHANGED IN v47 (learns from order flow and the chart, but only what proves itself)
- At 10, 5, 2 and 1 minute left the scorecard now also saves 9 signals: trade flow (60s and 5s), order book,
  futures lead, options flow, the chart brain, 1-minute momentum, big trades and the flip learner.
- Once it has 150 windows (about 1.5 days), after every window it tests each signal on windows it DIDN'T learn
  from (5 separate tests). A signal joins the Up/Down call only if it improves the score in at least 3 of the 5.
  Signals that don't help stay out, and a signal that stops helping drops out again by itself.
- The learned call also corrects the model's own over- or under-confidence and re-weighs Kalshi's price.
- It only replaces the simple v46 blend if it scores better on unseen windows. The scorecard shows which signals
  passed (✅) or failed (✗), and whether the call beats Kalshi, is about even, or loses to it.
- Real-money rules are unchanged from v45/v46 (no flip, AI or hold bets unless you turn hold bets on).

WHAT CHANGED IN v46
- Kalshi's live price is back in the Up/Down call, and the page tunes how much to trust it BY ITSELF:
  after every window it checks which mix of model and Kalshi price would have scored best and uses that
  (one mix each for 10, 5, 2 and 1 minute left). It starts at 40% Kalshi (same as v44) and moves only as
  data proves it, about halfway after 50 windows. The scorecard shows the mix it's using.

WHAT CHANGED IN v45 (accuracy fixes)
- Volatility: now from the last hour of 1-minute moves (refreshed every minute) blended with 10-second moves,
  instead of the larger of a 1-second number and a candle number fetched only once when the page loaded.
- Last minute: removed the floor that made the model ~2x too unsure at 30s left and ~6x at 10s.
- The Up/Down call no longer has the trade-flow / futures / options / order-book /
  flip-learner nudges. Those were never tested; the scorecard will show whether any of them should come back.
- Flip and AI trades are off (paper and real). Real money only goes on dip buys and takeoffs.
- Hold bets are OFF for real money until the scorecard proves the model. To turn them on, add
  "allowHoldBets": true  to config.json.
- NEW scorecard on the main box: at 10, 5, 2 and 1 minute left it saves the model's chance and Kalshi's price,
  then scores both when the window ends (lower = better). When run from the bot on the Mac it checks each
  window against Kalshi's official result. After 100+ windows it says "model better", "about even" or
  "Kalshi better". Tap "Copy scorecard" to send the data for analysis.
- Your saved brain, paper record and settings carry over; nothing to redo.

WHAT IT DOES
The radar page runs on your Mac. The bot makes two kinds of REAL Kalshi trades:
1. Hold bets: when the hold model finds a bet (8c+ edge, price 20-50c, 4-9 min left, AND
   Flip watch + flip learner both 70%+ pointing the same way) it buys and holds to the end.
2. Box trades: every trade the box makes (dip buys, 🚀 takeoffs, AI), the same ones the paper
   account copies. It buys when the box buys (10-85c, 1+ min left) and sells when the box says
   SELL (retries every 3 seconds until it's all sold), or holds to the end like the paper account.

HARD LIMITS (built into the bot, the page can't change them)
- 25% of your Kalshi balance max per bet
- Stops for good if your balance drops under $15 (delete bot-state.json to restart)
- At most 2 buys per 15-minute window, one position open at a time
- Hold bets never in the last 2 minutes, box trades never in the last minute
- Won't pay more than 1c above the price the page saw
- Orders fill right away or cancel; nothing is left sitting on the book

ONE-TIME SETUP
1. Unzip this folder somewhere easy, like your Desktop.
2. Put your Kalshi private key file in this folder and name it  kalshi-key.pem
   (or put its full path in config.json under "privateKeyPath").
3. Open config.json in TextEdit and paste your Kalshi API Key ID where it says
   PASTE-YOUR-KALSHI-API-KEY-ID-HERE. Save.
4. Check Node is installed: open Terminal, type   node -v   and press Enter.
   If it says "command not found", install the LTS version from nodejs.org, then reopen Terminal.

TEST IT (places no orders)
   cd ~/Desktop/kalshi-bot
   node kalshi-bot.mjs check
You should see your real Kalshi balance and the current BTC market.

START IT (real money)
   node kalshi-bot.mjs
Then open  http://localhost:8787  in Chrome on the Mac and leave that tab open and visible.
The box shows "Real money ON" with your Kalshi balance.

MOVE YOUR TRAINED BRAIN OVER (do this once)
On your Mac, open btc-radar-live.pages.dev, tap "Copy brain (backup)".
Then on http://localhost:8787 tap "Paste brain (restore)". Otherwise the flip learner starts fresh.

STOP IT
- Press Ctrl+C in the Terminal window, OR
- Create a file named STOP in this folder (bot refuses every new BUY until you delete it;
  it still sells an open position when the box says SELL, since selling only lowers risk).

RECORDS
trades.log in this folder lists every order sent to Kalshi and what filled.
Your Kalshi app/website is the final word on positions and balance.

PHONE ALERTS
When the bot starts it prints a private name like kbot-1a2b3c... (also saved in notify.txt).
Install the free "ntfy" app on your iPhone, tap +, and subscribe to that exact name.
You'll get a notification for every buy, sell, miss and error, plus an hourly "Bot is running" check-in.

TEST REAL TRADE
On the page, the money line has a "test real trade" link. It buys 1 contract (under $1) and sells it right back,
to prove buying and selling work. Costs a few cents at most.
