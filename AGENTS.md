# ai-wallet-trace: instructions for AI assistants

You (Claude, Codex, DeepSeek, Grok, any AI with a shell) can answer "who is behind this .ai wallet, and are they any
good?" for any Binance Agent ID wallet on BSC with the `aitrace` command. It only reads public chain data. It never
signs, never moves money and needs no wallet, key or login.

Reply to the user in their language. Keep it short: who it is, how many wallets, profit, the evidence.

## Setup (once)

```bash
npm install -g ai-wallet-trace
aitrace doctor
```

That is enough: without a node, `aitrace` asks agentidlive.ai, which already tracks every .ai wallet.

To trace any address (not only .ai wallets), or to check the numbers yourself, the user needs their own BSC
**archive** node that can read old logs (`eth_getLogs` over past blocks) and old balances. Free public nodes can't;
a free key from NodeReal, Chainstack, QuickNode or Ankr usually can. Ask the user for the URL and run:

```bash
aitrace config set rpc <url>
aitrace doctor      # must show: BSC mainnet, archive balances, history logs
```

Node URLs often contain a key. Don't repeat the URL back in chat; `aitrace` only ever prints its host.

## Commands

| What the user says | Run |
|---|---|
| "Who is behind abc.ai?" / "is this one person?" / "find their main wallet" | `aitrace who abc.ai` |
| "Is abc.ai any good?" / "how much did they make?" | `aitrace pnl abc.ai` |
| Same, but only that one wallet | `aitrace pnl abc.ai --solo` |
| Any 0x address (needs the user's node) | `aitrace who 0x…`, `aitrace pnl 0x…` |

Add `--json` for machine-readable output, `--trades 30` for more trades, `--site` to use agentidlive.ai even when a
node is set. A first local run reads about a million blocks per wallet and takes 1–3 minutes; later runs only read
new blocks.

## How wallets are tied (tell the user this when they ask "how do you know")

A .ai wallet is usually a side wallet: BNB or USDT comes in from the person's main wallet or an exchange, and coins
and profit go back to be sold there. Another wallet counts as the same person when any one of these is true:

- it paid the .ai wallet its **first BNB**
- **real money** moved between them, $20 or more either way (USDT, USDC, FDUSD, USD1, U, WBNB; in local mode plain
  BNB sends from a tied wallet count too)
- the .ai wallet sent it **2+ transfers of coins it really bought** (address-poisoning spam uses fake coins the
  wallet never bought, so it can't tie anyone)

Never tied: contracts (DEXes, launchpads, bridges), exchanges and other very busy addresses, burn addresses, trading
bots (5000+ trades) and any wallet shared by more than 6 .ai wallets (a faucet or service, not one person). EIP-7702
smart wallets are people and do count. Other .ai wallets that share the same main wallet join the person.

## Profit (how `pnl` counts)

- Realized profit only, average cost, in USD at the time of each trade.
- A coin that arrived free (airdrop, a transfer from someone) has no cost, so selling it is not counted as profit.
- Trades paid in plain BNB leave no token log. `aitrace` reads the wallet's BNB change over that block and counts the
  trade only if nothing else moved its BNB in that block and the amount appears in the trade's own receipt.
- Coin-for-coin swaps (e.g. a Flap pool priced in another token) are priced from the person's own trades within two
  hours; with no price they are left out. `--json` lists every move that was not counted and why.

## Rules you must follow

1. Say what the evidence is ("its first BNB came from 0x…", "sent it $3,241"). Never present a tie as certain
   identity of a real-world person; it is "the same wallet owner, by these transfers".
2. Don't guess beyond the output. If `who` finds no tied wallet, say so.
3. Numbers are realized profit since 2026-10-20 (the first .ai claim), unless `--since` was used. Say that when
   comparing people.
4. This is research, not advice. Copying someone's trades can lose money.
