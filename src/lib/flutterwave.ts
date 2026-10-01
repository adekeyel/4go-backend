import { env } from "@/lib/env";
import { ApiError } from "@/middleware/errorHandler";

const BASE = "https://api.flutterwave.com/v3";

async function flw<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ httpOk: boolean; json: T }> {
  if (!env.flutterwave.secretKey) throw new ApiError(503, "Payments aren't configured (FLUTTERWAVE_SECRET_KEY missing)");
  // A hung provider call must not hang the request (or hold a database transaction open).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${env.flutterwave.secretKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as T;
    return { httpOk: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

export type VerifiedTransaction = {
  id: number;
  successful: boolean;
  amount: number;
  currency: string;
  txRef: string;
  meta: { purpose?: string; plan?: string; coin_amount?: number; user_id?: string };
};

/** Ask Flutterwave what really happened to a transaction. Never trust amounts or metadata from a client or a webhook body. */
export async function verifyTransaction(transactionId: string | number): Promise<VerifiedTransaction | null> {
  const { json } = await flw<any>(`/transactions/${encodeURIComponent(String(transactionId))}/verify`);
  if (json?.status !== "success" || !json.data) return null;
  const d = json.data;
  return {
    id: Number(d.id),
    successful: d.status === "successful",
    amount: Number(d.amount) || 0,
    currency: String(d.currency ?? ""),
    txRef: String(d.tx_ref ?? ""),
    meta: d.meta ?? {},
  };
}

export async function createPaymentLink(input: {
  txRef: string;
  amount: number;
  redirectUrl: string;
  email: string;
  title: string;
  description: string;
  meta: Record<string, unknown>;
}): Promise<string> {
  const { json } = await flw<any>("/payments", {
    method: "POST",
    body: {
      tx_ref: input.txRef,
      amount: input.amount,
      currency: "NGN",
      redirect_url: input.redirectUrl,
      customer: { email: input.email },
      customizations: {
        title: input.title,
        description: input.description,
        logo: `${env.siteUrl}/icons/icon-192.png`,
      },
      meta: input.meta,
    },
  });
  if (json?.status !== "success" || !json.data?.link) throw new ApiError(502, json?.message || "Payment provider error");
  return json.data.link as string;
}

export async function resolveBankAccount(accountNumber: string, bankCode: string) {
  const { json } = await flw<any>("/accounts/resolve", {
    method: "POST",
    body: { account_number: accountNumber, account_bank: bankCode },
  });
  return json?.status === "success"
    ? { ok: true as const, account_name: String(json.data.account_name), account_number: String(json.data.account_number) }
    : { ok: false as const, error: String(json?.message || "Could not resolve account") };
}

export type TransferOutcome =
  | { kind: "queued" }
  | { kind: "rejected"; message: string }   // Flutterwave explicitly refused: money did not move
  | { kind: "unknown"; message: string };   // timeout / network error: it may or may not have gone through

export async function startTransfer(input: {
  reference: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  amountNgn: number;
}): Promise<TransferOutcome> {
  try {
    const { json } = await flw<any>("/transfers", {
      method: "POST",
      body: {
        account_bank: input.bankCode,
        account_number: input.accountNumber,
        amount: input.amountNgn,
        narration: `4GO Withdrawal - ${input.reference}`,
        currency: "NGN",
        reference: input.reference,
        beneficiary_name: input.accountName,
      },
    });
    if (json?.status === "success") return { kind: "queued" };
    const message = String(json?.message || "Transfer failed");
    // The reference is fixed per withdrawal, so a repeat call is answered "duplicate": the first one is in flight.
    if (/duplicate|already/i.test(message)) return { kind: "unknown", message };
    return { kind: "rejected", message };
  } catch (err) {
    return { kind: "unknown", message: (err as Error).message };
  }
}
