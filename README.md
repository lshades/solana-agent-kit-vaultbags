# solana-agent-kit-vaultbags

A [Solana Agent Kit v2](https://github.com/sendaifun/solana-agent-kit) plugin that lets any agent read the **VaultBags** autonomous real-world-asset treasury and run its allocation model.

VaultBags turns Bags trading fees into tokenized gold, the S&P 500 and US treasuries that holders claim directly. Every day at 00:00 UTC it reads live market data, freezes that day's buy proportions inside a strict 23-43% band, and stamps the decision on-chain. This plugin exposes that surface as agent tools.

Everything here is **read-only public data over HTTPS**. The plugin holds no key, never signs, never moves funds, and needs no auth.

## Install

```bash
npm install solana-agent-kit-vaultbags
```

`solana-agent-kit` (v2) and `zod` are peer dependencies; they are already present in any Solana Agent Kit project, so nothing new is pulled into your tree.

## Usage

Attach it to your existing agent (the `wallet`, `rpcUrl` and config come from your own Solana Agent Kit setup; this plugin never reads or uses the wallet):

```js
import { SolanaAgentKit, createVercelAITools } from "solana-agent-kit";
import VaultBagsPlugin from "solana-agent-kit-vaultbags";

const agent = new SolanaAgentKit(wallet, rpcUrl, config).use(VaultBagsPlugin);

// Call a method directly:
const today = await agent.methods.getTodaysAllocation();

// Or expose the actions to your model (Vercel AI SDK, LangChain, OpenAI, ...):
const tools = createVercelAITools(agent, agent.actions);
```

Or skip the framework entirely: every method also works standalone, with no wallet, no keys and no configuration.

```js
import { methods } from "solana-agent-kit-vaultbags";

const today = await methods.getTodaysAllocation();
```

## Tools

| Action | Method | What it returns |
| --- | --- | --- |
| `VAULTBAGS_GET_TODAYS_ALLOCATION` | `getTodaysAllocation()` | Today's gold / S&P 500 / US treasuries buy proportions, the 23-43% band, whether the decision is frozen, the rationale, and the on-chain receipt. |
| `VAULTBAGS_GET_DAILY_BRIEFING` | `getDailyBriefing()` | Today's market note explaining the allocation, plus weights and receipt. |
| `VAULTBAGS_GET_TREASURY_STATS` | `getTreasuryStats()` | Live per-asset balances and USD values, total vault value, total paid to holders, holder count, cycles and fees processed. |
| `VAULTBAGS_GET_DECISION_HISTORY` | `getDecisionHistory({ days })` | Recent daily decisions (newest first) with weights, rationale and receipts. `days` 1-30, default 14. |
| `VAULTBAGS_GET_MARKET_SIGNALS` | `getMarketSignals()` | The quantitative signals behind today's allocation, each with its per-asset read. Numbers only. |
| `VAULTBAGS_GET_BRAIN_VS_FLAT` | `getBrainVsFlat()` | Honest track record: the daily allocation line versus a fixed even split, with the edge reported either way. |
| `VAULTBAGS_SIMULATE_ALLOCATION` | `simulateAllocation({ ...signals })` | Runs the vault's model on your own market inputs and returns the weights it would choose. Deterministic, bounded, not advice. |
| `VAULTBAGS_GET_PROJECTS` | `getProjects()` | Every treasury currently running on VaultBags. |
| `VAULTBAGS_GET_PROJECT_TREASURY` | `getProjectTreasury({ mint })` | One integrated project's live treasury by SPL token mint. |
| `VAULTBAGS_GET_AGENT` | `getAgent({ mint })` | Evaluate any launched token as an agent: Autonomy Score split into inherited protocol guarantees vs its own earned record, plus passport and treasury. |
| `VAULTBAGS_GET_VAULT_DOCS` | `getVaultDocs()` | Condensed protocol documentation and live surface links. |
| `VAULTBAGS_LIST_RWAS` | `listRwas({ category?, issuer? })` | The certified registry of openly transferable tokenized RWAs on Solana (gold, US Treasuries, US equities/ETFs), every mint verified against the issuer's own domain. |
| `VAULTBAGS_GET_RWA` | `getRwa({ query })` | One certified RWA resolved by symbol or mint: verified identity plus a live market read. Protects agents from impersonator mints. |
| `VAULTBAGS_GET_PROTOCOL_METER` | `getProtocolMeter()` | The Meter: the protocol's consolidated live numbers, every section with its verification URL. |
| `VAULTBAGS_GET_AUTONOMY` | `getAutonomy()` | The vault agent's Autonomy Score and the verifiable facts behind it. |
| `VAULTBAGS_GET_AGENT_PASSPORT` | `getAgentPassport()` | The agent's portable machine-readable passport (identity, surfaces, receipts). |
| `VAULTBAGS_GET_RWA_PERFORMANCE` | `getRwaPerformance()` | The vault's real cost basis and return per RWA position since purchase, in USD and SOL terms. |
| `VAULTBAGS_GET_SHADOW_VS_BRAIN` | `getShadowVsBrain()` | The shadow language model's daily calls measured against the deterministic brain. |
| `VAULTBAGS_GET_RECENT_CYCLES` | `getRecentCycles({ limit? })` | The latest distribution cycles with their on-chain receipts. `limit` 1-20, default 5. |
| `VAULTBAGS_GET_MONTHLY_REPORTS` | `getMonthlyReports({ months? })` | The agent's closed books, one per calendar month, each committed on-chain. `months` 1-24, default 12. |
| `VAULTBAGS_GET_PROOF_OF_RESERVES` | `getProofOfReserves()` | Proof of Reserves: the reserve wallets, their certified issuers and live on-chain balances, plus decision receipts and value paid to holders. |
| `VAULTBAGS_VERIFY_CLAIM` | `verifyClaim({ tx })` | Verify one holder claim against the on-chain Merkle root: the committed record, its proof, the day's root and the on-chain memo. Recompute it yourself; the guarantee is on-chain. |

## Configuration

By default the plugin talks to `https://vaultbags.app`. To point it elsewhere (for local testing), set `VAULTBAGS_API_URL` in the agent config:

```js
const agent = new SolanaAgentKit(wallet, rpcUrl, {
  OTHER_API_KEYS: { VAULTBAGS_API_URL: "http://localhost:3000" },
}).use(VaultBagsPlugin);
```

## Notes

- The tool names, schemas and descriptions mirror the VaultBags MCP server verbatim, so an agent sees the same contract whether it connects over MCP or through this plugin.
- `simulateAllocation` runs the model on inputs you supply; it is a compute helper, not a read of the vault's own live decision. Nothing it returns predicts returns or moves funds.
- All data is informational. This plugin does not provide financial advice.

## Links

- Agent surface: <https://vaultbags.app/agent>
- Daily briefing: <https://vaultbags.app/briefing>
- Docs: <https://vaultbags.app/docs>
