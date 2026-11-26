/**
 * Solana Devnet üzerinde toplu USDC (SPL) transferi: payouts.ts'teki Chain arayüzünün gerçek uygulaması.
 *
 * Bir işlem: her alıcı için "token hesabını yoksa aç" (idempotent) + TransferChecked talimatı.
 * Gönderen platform cüzdanıdır (PLATFORM_PRIVATE_KEY, yalnızca Mac'teki .env); işlem ücretini ve
 * yeni token hesaplarının kirasını da o öder, bu yüzden platform adresinde biraz Devnet SOL gerekir.
 *
 * Ağ gerektirdiği için otomatik testlerde kullanılmaz (testler sahte zincirle); Devnet'te elle denenir.
 */
import { base58 } from "@scure/base";
import {
  address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc,
  createTransactionMessage, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Instruction, type Signature,
} from "@solana/kit";
import {
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { Chain, ChainStatus, SignedBatch, Transfer } from "./payouts.ts";

export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const USDC_DECIMALS = 6;

type Rpc = ReturnType<typeof createSolanaRpc>;

/** `rpc` yalnızca testlerde verilir (ağsız imzalama denetimi). */
export async function solanaChain(opts: { rpcUrl: string; platformSecret: string; mint: string; rpc?: Rpc }): Promise<Chain & { address: string }> {
  const rpc = opts.rpc ?? createSolanaRpc(opts.rpcUrl);
  const signer = await createKeyPairSignerFromBytes(base58.decode(opts.platformSecret));
  const mint = address(opts.mint);
  const ata = async (owner: string) =>
    (await findAssociatedTokenPda({ owner: address(owner), mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const source = await ata(signer.address);

  return {
    address: signer.address,

    async sign(transfers: Transfer[]): Promise<SignedBatch> {
      const ixs: Instruction[] = [];
      for (const t of transfers) {
        const destination = await ata(t.to);
        ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner: address(t.to), mint }));
        ixs.push(getTransferCheckedInstruction({
          source, mint, destination, authority: signer, amount: BigInt(t.amountAtomic), decimals: USDC_DECIMALS,
        }));
      }
      const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      );
      const signed = await signTransactionMessageWithSigners(message);
      const wire = getBase64EncodedWireTransaction(signed);
      return {
        signature: getSignatureFromTransaction(signed),
        blockhash: latest.blockhash,
        lastValidBlockHeight: Number(latest.lastValidBlockHeight),
        async send() {
          await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
        },
      };
    },

    async status(signature: string, lastValidBlockHeight: number): Promise<{ status: ChainStatus; error?: string }> {
      const { value } = await rpc.getSignatureStatuses([signature as Signature], { searchTransactionHistory: true }).send();
      const s = value[0];
      if (s) {
        if (s.err) return { status: "failed", error: JSON.stringify(s.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) };
        if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return { status: "confirmed" };
        return { status: "pending" };
      }
      // Zincirde yok: blok karmasının süresi dolduysa artık giremez → yeniden imzalanabilir.
      const height = Number(await rpc.getBlockHeight({ commitment: "confirmed" }).send());
      return { status: height > lastValidBlockHeight ? "expired" : "pending" };
    },
  };
}
