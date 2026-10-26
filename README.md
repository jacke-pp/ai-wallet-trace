# ai-wallet-trace

这个 .ai 钱包背后是谁？他到底赚没赚钱？

币安在 BSC 上给 AI 钱包发了链上身份（Agent ID），前 5 天就领出去 9.9 万多个 `.ai` 名字，Four.meme、Flap、GANG
几个发射台马上开了只让这些钱包买的新币。但 `.ai` 钱包多半是小号：钱从主钱包打进来，赚了再打回去卖。只看 `.ai`
钱包本身，大部分故事都看不到。

`aitrace` 顺着钱往回扒：找出这个人的其他钱包，每个都说清凭什么算同一个人，再把所有钱包的已实现盈亏一笔笔加起来。
只读，不要钱包、不要私钥、不用登录。

[English](https://github.com/jacke-pp/ai-wallet-trace/blob/main/README_en.md)

## 现在谁在赚

[agentidlive.ai](https://agentidlive.ai) 用同一套规则扫了 48,390 个 `.ai` 钱包，认出 8,501 个其实是同一批人的小号，
合并成 6,554 个人排了榜。2026-10-26 的榜（从 10 月 20 日第一个 `.ai` 名字被领走算起，只算已实现盈亏）：

| | 谁 | 已实现盈亏 | 成本 | 卖出赚钱的次数 |
|---|---|---|---|---|
| 第 1 名 | afeng123.ai（2 个钱包） | **+$47,622** | $171,060 | 666 / 833 |
| 第 2 名 | czheyi.ai（5 个钱包） | **+$31,358**（+195%） | $16,096 | 97 / 126 |
| 第 3 名 | 1369.ai（26 个钱包） | **+$28,463**（+120%） | $23,808 | 155 / 256 |
| 倍数最高 | 榜上第 6 名 | $654 → **+$19,864**（+3,040%） | $654 | 5 / 5 |
| 亏最多 | honga.ai | **−$19,028**（−99.4%） | $19,150 | |

榜每几分钟刷新一次，上面是快照。想知道某个人怎么赚的、还有哪些小号：`aitrace who afeng123.ai`、`aitrace pnl afeng123.ai`。

```
$ aitrace who acclo.ai

acclo.ai  0x96a7…9147
first BNB: 1.1 BNB from 0x6297…d690  2026-10-21 06:08 UTC

one person, 6 wallets (5 .ai):
  [.ai] acclo.ai  0x96a7…9147        the wallet you asked about
        0x6297…d690                  paid its first BNB
  [.ai] exeo.ai  0xc26e…956c         0x6297cb… sent it $1487 (incl. plain BNB)
  ...

$ aitrace pnl acclo.ai
realized $8,760 on $14,391 cost (+60.88%), 43/61 sells in profit
```

## 开始

需要 Node.js 18 以上。

```bash
npm install -g ai-wallet-trace
aitrace who czheyi.ai
aitrace pnl czheyi.ai
```

也可以直接跟你的 AI（Claude、Codex，任何能跑命令的）说：“运行 `aitrace agents`，读完告诉我 czheyi.ai 背后是谁”。

## 两种用法

**不用配置（默认）**：`aitrace` 去问 [agentidlive.ai](https://agentidlive.ai)。这个网站扫着 BSC 上所有 `.ai`
钱包，按人合并后排了实时高手榜。只能查 `.ai` 钱包。

**用自己的节点**：所有数据在你自己电脑上从链上读，任何地址都能查：

```bash
aitrace config set rpc https://你的BSC归档节点/...
aitrace doctor
```

要 BSC **归档节点**，能查历史日志和历史余额。免费公共节点不行（日志只给查几十个块，或者要 key）；NodeReal、
Chainstack、QuickNode、Ankr 的免费 key 一般可以。第一次查一个人要 1–3 分钟，读过的都缓存在 `~/.ai-wallet-trace`，
以后只读新块。

## 怎么判断是同一个人

满足任意一条，就算同一个人的钱包：

- 给这个 `.ai` 钱包打了**第一笔 BNB**
- 两边之间有**真金白银**往来，任一方向 $20 以上（稳定币、WBNB；用自己节点时，直接转的 BNB 也算）
- `.ai` 钱包给它转过 **2 次以上自己真买过的币**。投毒骗局用的是钱包从没买过的假币，所以绑不上任何人。

不算的：合约（DEX、发射台、跨链桥）、交易所和特别忙的地址、销毁地址、机器人（5000 笔以上）、被 6 个以上 `.ai`
钱包共用的地址。EIP-7702 智能钱包是人，算。跟同一个主钱包有关系的其他 `.ai` 钱包，也并进这个人。

## 盈亏怎么算

只算已实现盈亏，平均成本法，按每笔成交当时的美元价（BNB 价格取币安公开行情的分钟线）。白拿的币（空投、别人转来的）
没有成本，卖掉不算赚钱。直接用 BNB 付的交易没有代币日志：`aitrace` 读这个钱包在那个块里的 BNB 变化，只有那个块里
没有别的东西动过它的 BNB、而且这个金额能在这笔交易自己的回执里对上，才算这笔交易。算不了价的都在 `--json`
里写明原因，不靠猜。

## 命令

```
aitrace who <名字.ai | 0x…>     这个人：其他钱包，每个凭什么算
aitrace pnl <名字.ai | 0x…>     已实现盈亏，按币、按笔（--solo：只算这一个钱包）
aitrace doctor                  检查连接
aitrace agents                  给 AI 看的说明
aitrace config set rpc <url>    自己的归档节点（还有 rps、window）
  --json  --site  --since <块号>  --trades <n>  --bnb-cap <n>
```

零依赖，MIT 许可。只读公开数据；这是研究工具，不是投资建议。
