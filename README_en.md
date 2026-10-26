# ai-wallet-trace

Who is behind a Binance Agent ID (.ai) wallet, and do they actually make money?

Binance gave AI wallets an on-chain identity on BSC, and more than 99,000 `.ai` names were claimed in the first five
days. Launchpads (Four.meme, Flap, GANG) immediately opened coins only these wallets can buy. A `.ai` wallet is
usually a side wallet, though: the money comes from the owner's main wallet, and profits go back there. Looking at
the `.ai` wallet alone misses most of the story.

`aitrace` follows the money back: it finds the person's other wallets, tells you why each one is tied, and adds up
realized profit across all of them, trade by trade. Read-only. No wallet, no key, no login.

[中文说明](https://github.com/jacke-pp/ai-wallet-trace/blob/main/README_zh.md)

```
$ aitrace who acclo.ai

acclo.ai  0x96a7…9147
first BNB: 1.1 BNB from 0x6297…d690  2026-10-21 06:08 UTC

one person, 6 wallets (5 .ai):
  [.ai] acclo.ai  0x96a7…9147        the wallet you asked about
        0x6297…d690                  paid its first BNB
  [.ai] exeo.ai  0xc26e…956c         0x6297cb… sent it $1487 (incl. plain BNB)
  [.ai] zed099.ai  0x48dc…f224       0x6297cb… sent it $1487 (incl. plain BNB)
  ...

$ aitrace pnl acclo.ai

acclo.ai  (one person, 6 wallets)
realized $8,760 on $14,391 cost (+60.88%), 43/61 sells in profit
by coin:
  GANG      $7,515  on $1,178
  ...
```

## Start

Node.js 18+.

```bash
npm install -g ai-wallet-trace
aitrace who czheyi.ai
aitrace pnl czheyi.ai
```

Or tell your AI (Claude, Codex, anything with a shell): "run `aitrace agents`, read it, then tell me who is behind
czheyi.ai".

## Two ways to run

**No setup (default).** `aitrace` asks [agentidlive.ai](https://agentidlive.ai), which scans every `.ai` wallet on
BSC and keeps a live board of the best traders, grouped by person. Works for `.ai` wallets only.

**Your own node.** Everything is read from the chain on your machine, for any address:

```bash
aitrace config set rpc https://your-bsc-archive-node/...
aitrace doctor
```

It needs a BSC **archive** node that can read old logs and old balances. Free public endpoints can't (they cap log
ranges at a few dozen blocks or need a key); a free key from NodeReal, Chainstack, QuickNode or Ankr usually works.
A first run takes 1–3 minutes per person; everything read is cached in `~/.ai-wallet-trace`, so later runs only read
new blocks.

## How wallets are tied

Another wallet counts as the same person when any one of these is true:

- it paid the `.ai` wallet its **first BNB**
- **real money** moved between them, $20+ either way (stablecoins, WBNB, and in local mode plain BNB too)
- the `.ai` wallet sent it **2+ transfers of coins it really bought**. Address-poisoning spam uses fake coins the
  wallet never bought, so it can't tie anyone.

Never tied: contracts (DEXes, launchpads, bridges), exchanges and very busy addresses, burn addresses, bots (5000+
trades) and wallets shared by more than 6 `.ai` wallets. EIP-7702 smart wallets are people and count. Other `.ai`
wallets that share the main wallet join the person.

## How profit is counted

Realized profit only, average cost, USD at the time of each trade (BNB priced by the minute from Binance's public
market data). A coin that arrived free has no cost, so selling it is not profit. Trades paid in plain BNB leave no
token log: `aitrace` reads the wallet's BNB change over that block and counts the trade only when nothing else moved
its BNB in that block and the amount shows up in the trade's own receipt. Anything it could not price is listed with
the reason in `--json`, never guessed.

## Commands

```
aitrace who <name.ai | 0x…>     the person: their other wallets, and why each one is tied
aitrace pnl <name.ai | 0x…>     realized profit, coin by coin and trade by trade (--solo: one wallet)
aitrace doctor                  check the connection
aitrace agents                  instructions for AI assistants
aitrace config set rpc <url>    your own archive node (also rps, window)
  --json  --site  --since <block>  --trades <n>  --bnb-cap <n>
```

Zero dependencies. MIT licensed. Reads public data only; this is research, not financial advice.
