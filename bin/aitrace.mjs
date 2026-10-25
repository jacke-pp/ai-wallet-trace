#!/usr/bin/env node
// aitrace: who is behind a Binance Agent ID (.ai) wallet on BSC, and do they make money.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRpc } from '../lib/rpc.mjs';
import { createTracer } from '../lib/trace.mjs';
import { createSite, SITE } from '../lib/site.mjs';
import { START } from '../lib/registry.mjs';

const HOME = process.env.AITRACE_HOME || path.join(os.homedir(), '.ai-wallet-trace');
const CONF = path.join(HOME, 'config.json');
const readConf = () => { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; } };
const writeConf = (c) => { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 }); };
// node URLs often carry a key in the path or query: never print one whole
const mask = (u) => { try { const x = new URL(u); return `${x.protocol}//${x.host}/…`; } catch { return '(set)'; } };

const HELP = `aitrace - who is behind a Binance Agent ID (.ai) wallet on BSC, and do they make money

  aitrace who <name.ai | 0x…>     the person: their other wallets, and why each one is tied
  aitrace pnl <name.ai | 0x…>     realized profit, coin by coin and trade by trade
  aitrace doctor                  check the node / site connection
  aitrace agents [--path]         instructions for your AI (read these first)
  aitrace config set rpc <url>    use your own BSC archive node (needs eth_getLogs + archive balances)
  aitrace config set rps <n>      requests per second for that node (default 10)
  aitrace config show

options
  --rpc <url>     use this node for one run (or env AITRACE_RPC)
  --site          ask ${SITE} even when a node is set
  --solo          pnl of this one wallet only, not the whole person
  --since <block> start reading here (default ${START}, the first .ai claim)
  --trades <n>    how many latest trades to list (default 15)
  --bnb-cap <n>   read plain BNB sends of tied wallets with up to n transactions (default 400)
  --json          machine-readable output

Without a node it asks ${SITE} (only .ai wallets). With your own node it reads the chain itself and works on any address.
Data is cached in ${HOME}.`;

function parse(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--json' || v === '--site' || v === '--solo' || v === '--path' || v === '-h' || v === '--help') a[v.replace(/^-+/, '')] = true;
    else if (v.startsWith('--')) a[v.slice(2)] = argv[++i];
    else a._.push(v);
  }
  return a;
}

const usd = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: v && Math.abs(v) < 10 ? 2 : 0 });
const when = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const label = (o, name) => name ? `${name}.ai  ${o}` : o;
const err = (m) => { process.stderr.write(m + '\n'); process.exitCode = 1; };

async function main() {
  const a = parse(process.argv.slice(2)), [cmd, arg, ...rest] = a._;
  if (!cmd || a.h || a.help) return console.log(HELP);
  if (cmd === 'agents') {
    const f = fileURLToPath(new URL('../AGENTS.md', import.meta.url));
    return console.log(a.path ? f : fs.readFileSync(f, 'utf8'));
  }
  const conf = readConf();
  if (cmd === 'config') {
    if (arg === 'set' && rest.length === 2) {
      const [k, v] = rest;
      if (!['rpc', 'rps', 'window'].includes(k)) return err(`unknown setting ${k} (rpc, rps, window)`);
      if (k === 'rpc' && !/^https?:\/\//.test(v)) return err('rpc must be an http(s) URL');
      conf[k] = k === 'rpc' ? v : Number(v); writeConf(conf);
      return console.log(`saved ${k} = ${k === 'rpc' ? mask(v) : v}`);
    }
    if (arg === 'unset' && rest.length === 1) { delete conf[rest[0]]; writeConf(conf); return console.log(`removed ${rest[0]}`); }
    return console.log(JSON.stringify({ ...conf, ...(conf.rpc ? { rpc: mask(conf.rpc) } : {}), home: HOME }, null, 2));
  }
  const rpcUrl = a.site ? null : a.rpc || process.env.AITRACE_RPC || conf.rpc;
  const tty = !a.json && process.stderr.isTTY;
  const log = tty ? (m) => process.stderr.write(`\r\x1b[2K${m}`) : () => {};
  const done = () => { if (tty) process.stderr.write('\r\x1b[2K'); };

  if (cmd === 'doctor') return doctor(rpcUrl, conf);
  if (!['who', 'pnl'].includes(cmd)) return err(`unknown command "${cmd}" (try aitrace --help)`);
  if (!arg) return err(`usage: aitrace ${cmd} <name.ai | 0x…>`);

  if (!rpcUrl) {
    const site = createSite();
    if (/^0x[0-9a-f]{40}$/i.test(arg) && cmd === 'who') log('no node set: asking agentidlive.ai (only .ai wallets)…');
    const [tr, pv] = await Promise.all([site.trader(arg).catch((e) => ({ error: e.message })),
      cmd === 'who' && /^[a-z0-9]{3,20}(\.ai)?$/i.test(arg) ? site.privacy(arg).catch(() => null) : null]);
    done();
    if (tr.error && !(pv && pv.c)) return err(tr.error);
    if (tr.error) { tr.found = true; tr.name = pv.name; tr.o = pv.address; tr.note = tr.error; }   // who still works from the privacy check
    if (!tr.found) return err(`${arg} is not a .ai wallet agentidlive.ai knows. For any other address use your own node: aitrace config set rpc <url>`);
    if (a.json) return console.log(JSON.stringify(cmd === 'who' ? { source: SITE, trader: tr, privacy: pv } : { source: SITE, ...tr }, null, 2));
    return cmd === 'who' ? printSiteWho(tr, pv) : printSitePnl(tr, +a.trades || 15);
  }

  const rpc = createRpc(rpcUrl, { rps: conf.rps || 10 });
  const tracer = createTracer(rpc, { dir: path.join(HOME, 'cache'), since: +a.since || START, window: conf.window || 10_000, log });
  try {
    const bnbCap = +a['bnb-cap'] || 400;
    const r = cmd === 'who' ? await tracer.who(arg, { bnbCap }) : await tracer.pnl(arg, { solo: !!a.solo, bnbCap });
    done();
    if (a.json) return console.log(JSON.stringify(r, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    return cmd === 'who' ? printWho(r) : printPnl(r, +a.trades || 15);
  } catch (e) { done(); err(e.message); }
}

function printWho(r) {
  const ais = r.wallets.filter((w) => w.ai), side = r.wallets.filter((w) => !w.ai);
  console.log(`\n${label(r.o, r.name)}`);
  console.log(`read ${r.transfers} transfers since block ${r.since}; ${r.trades} trades${r.spam ? `; ${r.spam} transfers of coins it never bought (spam, airdrops, address poisoning) ignored` : ''}`);
  if (r.funder) console.log(`first BNB: ${r.funder.from ? `${r.funder.bnb} BNB from ${r.funder.from}` : 'paid from inside a contract (exchange withdrawal or bridge)'}  ${when(r.funder.t)}`);
  console.log(`\none person, ${r.wallets.length} wallet${r.wallets.length > 1 ? 's' : ''} (${ais.length} .ai):`);
  for (const w of [...r.wallets].sort((x, y) => (y.o === r.o) - (x.o === r.o))) console.log(`  ${w.ai ? '[.ai]' : '     '} ${label(w.o, w.name)}${w.kind === '7702' ? '  (smart wallet)' : ''}\n         ${w.why.join('; ')}`);
  if (!side.length) console.log('  no other wallet is tied to it yet');
  if (r.dropped.length) {
    console.log('\nleft out (moved money with it, but not one person\'s wallet):');
    const names = { exchange: 'exchange or very busy service', contract: 'contract (a DEX, launchpad or bridge)', bot: 'trading bot', hub: `used by more than 6 .ai wallets`, burn: 'burn address' };
    for (const d of r.dropped) console.log(`  ${d.o}  ${names[d.kind] || d.kind}  (${d.why.join('; ')})`);
  }
  if (r.notWalked.length) console.log(`\nplain BNB sends not read for ${r.notWalked.join(', ')} (too many transactions; raise --bnb-cap to read them, ~13 node reads each)`);
  console.log(`\nprofit: aitrace pnl ${r.name ? r.name + '.ai' : r.o}`);
}

function printPnl(r, n) {
  console.log(`\n${label(r.o, r.name)}${r.wallets.length > 1 ? `  (one person, ${r.wallets.length} wallets)` : ''}`);
  if (!r.closes) console.log('no closed trade with a known cost yet');
  else console.log(`realized ${usd(r.pnl)} on ${usd(r.cost)} cost (${r.roi > 0 ? '+' : ''}${r.roi}%), ${r.wins}/${r.closes} sells in profit, ${r.buys} buys, ${r.sells} sells, ${usd(r.volume)} volume`);
  if (r.coins.length) {
    console.log('\nby coin:');
    for (const c of [...r.coins.slice(0, 5), ...r.coins.slice(5).filter((c) => c.pnl < 0).slice(-3)]) console.log(`  ${(c.sym || c.tok).padEnd(12)} ${usd(c.pnl).padStart(10)}  on ${usd(c.cost)}  ${c.tok}`);
  }
  if (r.open.length) console.log(`\nstill holding (at cost): ${r.open.slice(0, 6).map((p) => `${p.sym} ${usd(p.cost)}`).join(', ')}`);
  console.log(`\nlatest trades:`);
  for (const x of r.trades.slice(-n).reverse()) console.log(`  ${when(x.t)}  ${x.k.padEnd(4)} ${(x.sym || '').padEnd(12)} ${usd(x.usd).padStart(9)}${x.gain != null ? `  ${x.gain >= 0 ? '+' : ''}${usd(x.gain)}` : ''}  ${x.x}`);
  if (r.skipped.length) console.log(`\n${r.skipped.length} coin moves not counted as trades (no clean BNB amount, free coins, or swaps with no price): see --json`);
  console.log('\nRealized profit only, average cost. A coin that arrived free has no cost and its sale is not counted.');
}

function printSiteWho(tr, pv) {
  const name = tr.name, o = tr.o;
  console.log(`\n${label(o, name)}   (from ${SITE})`);
  if (pv?.fund?.funder) {
    const f = pv.fund.funder;
    console.log(`first BNB: ${pv.fund.bnb} BNB from ${f.a}${f.name ? ` (${f.name}.ai)` : ''}${f.type === 'busy' || f.type === 'exchange' ? ' (exchange or busy service)' : ''}  ${when(pv.fund.t)}`);
  }
  if (tr.note) console.log(`(tied wallets not available right now: ${tr.note})`);
  const tied = tr.tied || [];
  if (!tr.note) console.log(`\none person, ${tied.length + 1} wallet${tied.length ? 's' : ''}:`);
  if (!tr.note) console.log(`  ${label(o, name)}`);
  for (const w of tied) console.log(`  ${label(w.o, w.name)}`);
  if (pv?.moves?.peers?.length) {
    console.log('\nmoved coins with most:');
    for (const p of pv.moves.peers.slice(0, 8)) console.log(`  ${p.a}${p.name ? ` (${p.name}.ai)` : ''}  in ${p.in}, out ${p.out}${p.type ? `  ${p.type}` : ''}`);
  }
  if (pv?.moves?.spam) console.log(`${pv.moves.spam} spam / poisoning transfers ignored`);
  console.log(`\nprofit: aitrace pnl ${name ? name + '.ai' : o}    full page: ${SITE}`);
}

function printSitePnl(tr, n) {
  const name = tr.name, o = tr.o;
  console.log(`\n${label(o, name)}   (from ${SITE})`);
  if (tr.ranked) {
    console.log(`realized ${usd(tr.pnl)} on ${usd(tr.cost)} cost (${tr.roi > 0 ? '+' : ''}${tr.roi}%), ${tr.wins}/${tr.closes} sells in profit`);
    for (const [k, v] of Object.entries(tr.ranks || {})) if (v) console.log(`  ${k.padEnd(4)} rank ${v.rank} of ${v.of}  ${usd(v.pnl)}`);
    if (tr.best) console.log(`best coin: ${tr.best.sym} ${usd(tr.best.pnl)}`);
    if (tr.tied?.length) console.log(`counted as one person with ${tr.tied.length} more wallet${tr.tied.length > 1 ? 's' : ''} (aitrace who ${name || o})`);
  } else console.log('not on the board yet (too few closed trades)');
  if (tr.trades?.length) {
    console.log('\nlatest trades:');
    for (const x of tr.trades.slice(0, n)) console.log(`  ${when(x.t)}  ${x.k.padEnd(4)} ${(x.sym || '').padEnd(12)} ${usd(x.usd).padStart(9)}${x.gain != null ? `  ${x.gain >= 0 ? '+' : ''}${usd(x.gain)}` : ''}  ${x.x}`);
  }
}

async function doctor(rpcUrl, conf) {
  const ok = (m) => console.log(`ok    ${m}`), bad = (m) => { console.log(`FAIL  ${m}`); process.exitCode = 1; };
  console.log(`node -v ${process.version}${+process.versions.node.split('.')[0] >= 18 ? '' : '  (need 18+)'}`);
  try { const s = await createSite().state(); ok(`${SITE} answers: ${s.total.toLocaleString('en-US')} .ai names claimed`); } catch (e) { bad(`${SITE}: ${e.message}`); }
  if (!rpcUrl) return console.log('no node set: who/pnl use the site (only .ai wallets). For any address: aitrace config set rpc <url>');
  const rpc = createRpc(rpcUrl, { rps: conf.rps || 10, retries: 1 });
  try {
    const h = await rpc.head(); ok(`node ${mask(rpcUrl)} at block ${h}`);
    const chain = await rpc.send('eth_chainId'); chain === '0x38' ? ok('BSC mainnet') : bad(`chain ${chain} is not BSC (0x38)`);
    try { await rpc.balance('0x0000000000000000000000000000000000001000', START); ok('archive balances'); } catch (e) { bad(`archive balances: ${e.message} (pnl needs an archive node)`); }
    try { await rpc.send('eth_getLogs', [{ fromBlock: rpc.hex(START), toBlock: rpc.hex(START + 999), address: '0x60b9262456de011f7d15a54cdd8c48baaa8b022f' }]); ok('history logs (1000 blocks)'); }
    catch (e) { bad(`history logs: ${e.message} (this node can't read old logs; free public nodes usually can't)`); }
  } catch (e) { bad(`node ${mask(rpcUrl)}: ${e.message}`); }
}

main().catch((e) => err(e.message));
