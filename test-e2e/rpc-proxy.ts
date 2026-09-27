import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { toHex } from "viem";

interface JsonRpcCall {
  id?: unknown;
  method?: unknown;
}

interface JsonRpcAnswer {
  result?: unknown;
}

/// The priority fee the fee-marking proxy puts into every `eth_feeHistory` answer is this plus
/// the number of the answer, so no two answers carry the same value.
export const MARKED_PRIORITY_FEE_BASE = 1_000_000_000n;

export interface RpcProxyOptions {
  /// Answer `eth_accounts` with an empty list, as a public provider does.
  hideAccounts?: boolean;
  /// Replace the reward in every `eth_feeHistory` answer with a value no other answer carries.
  markFees?: boolean;
}

/// A JSON-RPC endpoint in front of the local chain that forwards every request, rewriting the
/// answers to two methods on request.
///
/// `hideAccounts` exists because `hardhat node` always lists its twenty development accounts,
/// so a command's behaviour against an endpoint exposing none cannot be observed without
/// something in between.
///
/// `markFees` exists because on the `rpc` network hardhat's own `AutomaticGasPriceHandler`
/// fills a missing fee field from `eth_feeHistory` with the same formula the commands use, at
/// the same moment, so a command that stopped setting its fees would still sign exactly the
/// numbers it printed. With every answer distinct, a second `eth_feeHistory` read — which is
/// what hardhat's filler would make — yields a priority fee the command never printed, and the
/// mined transaction no longer matches the print.
export class RpcProxy {
  readonly #server: Server;
  readonly url: string;
  #feeHistoryAnswers = 0n;

  private constructor(server: Server, url: string) {
    this.#server = server;
    this.url = url;
  }

  static async start(upstream: string, options: RpcProxyOptions): Promise<RpcProxy> {
    let proxy: RpcProxy | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        void (async () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as JsonRpcCall | JsonRpcCall[];
          const answer = async (call: JsonRpcCall): Promise<unknown> => {
            if (options.hideAccounts === true && call.method === "eth_accounts") {
              return { jsonrpc: "2.0", id: call.id, result: [] };
            }
            const forwarded = await fetch(upstream, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(call),
            });
            const reply = (await forwarded.json()) as JsonRpcAnswer;
            if (options.markFees === true && call.method === "eth_feeHistory" && proxy !== undefined) {
              proxy.#feeHistoryAnswers += 1n;
              const marked = toHex(MARKED_PRIORITY_FEE_BASE + proxy.#feeHistoryAnswers);
              const result = reply.result as { reward?: unknown[][] } | undefined;
              if (result?.reward !== undefined) {
                result.reward = result.reward.map((row) => row.map(() => marked));
              }
            }
            return reply;
          };
          const result = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        })().catch((error: unknown) => {
          response.writeHead(500);
          response.end(String(error));
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    proxy = new RpcProxy(server, `http://127.0.0.1:${port}`);
    return proxy;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
