import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { ConversationModel, MessageModel } from "../models/chat.js";
import { BtcDepositModel } from "../models/deposit.js";
import { EscrowEventModel, EscrowModel } from "../models/escrow.js";
import { OfferModel } from "../models/offer.js";
import { UserModel } from "../models/user.js";
import { WalletModel } from "../models/wallet.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/overview", async (_req, res) => {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    admins,
    verifiedUsers,
    newUsers24h,
    newUsers7d,
    totalOffers,
    activeOffers,
    totalConversations,
    totalMessages,
    messages24h,
    messages7d,
    totalEscrows,
    escrows24h,
    openEscrows,
    disputedEscrows,
    payoutPendingEscrows,
    totalDeposits,
    unmatchedDeposits,
    creditedDeposits,
    recentUsers,
    recentEscrows,
    recentDeposits,
    recentEvents,
    walletBalances,
    escrowByStatus,
    depositByStatus,
    offerByStatus,
    messageByKind,
    escrowVolume,
    depositVolume,
  ] = await Promise.all([
    UserModel.countDocuments(),
    UserModel.countDocuments({ role: "admin" }),
    UserModel.countDocuments({ emailVerified: true }),
    UserModel.countDocuments({ createdAt: { $gte: last24h } }),
    UserModel.countDocuments({ createdAt: { $gte: last7d } }),
    OfferModel.countDocuments(),
    OfferModel.countDocuments({ status: "active" }),
    ConversationModel.countDocuments(),
    MessageModel.countDocuments(),
    MessageModel.countDocuments({ createdAt: { $gte: last24h } }),
    MessageModel.countDocuments({ createdAt: { $gte: last7d } }),
    EscrowModel.countDocuments(),
    EscrowModel.countDocuments({ createdAt: { $gte: last24h } }),
    EscrowModel.countDocuments({ status: { $nin: ["paid_out", "failed", "refunded", "cancelled"] } }),
    EscrowModel.countDocuments({ status: "disputed" }),
    EscrowModel.countDocuments({ status: "payout_pending" }),
    BtcDepositModel.countDocuments(),
    BtcDepositModel.countDocuments({ status: "unmatched" }),
    BtcDepositModel.countDocuments({ status: "credited" }),
    UserModel.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .select("email username displayName role emailVerified createdAt bankAccounts payoutWallets"),
    EscrowModel.find().sort({ createdAt: -1 }).limit(10),
    BtcDepositModel.find().sort({ createdAt: -1 }).limit(10),
    EscrowEventModel.find().sort({ createdAt: -1 }).limit(10),
    WalletModel.aggregate([
      { $group: { _id: "$asset", totalBalance: { $sum: "$balance" }, walletCount: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    EscrowModel.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    BtcDepositModel.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    OfferModel.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    MessageModel.aggregate([
      { $group: { _id: "$kind", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    EscrowModel.aggregate([
      {
        $group: {
          _id: "$coin",
          totalAmount: { $sum: "$amount" },
          totalFees: { $sum: "$platformFee" },
          totalPayout: { $sum: "$payoutAmount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    BtcDepositModel.aggregate([
      {
        $group: {
          _id: "$status",
          totalBtc: { $sum: "$amountBtc" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  res.json({
    generated_at: now,
    metrics: {
      users: {
        total: totalUsers,
        admins,
        verified: verifiedUsers,
        unverified: Math.max(totalUsers - verifiedUsers, 0),
        new_24h: newUsers24h,
        new_7d: newUsers7d,
      },
      offers: {
        total: totalOffers,
        active: activeOffers,
        by_status: countMap(offerByStatus),
      },
      chats: {
        conversations: totalConversations,
        messages: totalMessages,
        messages_24h: messages24h,
        messages_7d: messages7d,
        by_kind: countMap(messageByKind),
      },
      escrows: {
        total: totalEscrows,
        new_24h: escrows24h,
        open: openEscrows,
        payout_pending: payoutPendingEscrows,
        disputed: disputedEscrows,
        by_status: countMap(escrowByStatus),
        volume_by_coin: escrowVolume.map((row: any) => ({
          coin: row._id ?? "unknown",
          count: row.count,
          total_amount: row.totalAmount ?? 0,
          total_fees: row.totalFees ?? 0,
          total_payout: row.totalPayout ?? 0,
        })),
      },
      deposits: {
        total: totalDeposits,
        unmatched: unmatchedDeposits,
        credited: creditedDeposits,
        by_status: countMap(depositByStatus),
        volume_by_status: depositVolume.map((row: any) => ({
          status: row._id ?? "unknown",
          count: row.count,
          total_btc: row.totalBtc ?? 0,
        })),
      },
      wallets: {
        balances_by_asset: walletBalances.map((row: any) => ({
          asset: row._id ?? "unknown",
          wallet_count: row.walletCount,
          total_balance: row.totalBalance ?? 0,
        })),
      },
    },
    system: {
      api: "ok",
      database: "ok",
      email_configured: Boolean(config.emailUser && config.emailPassword && config.emailFrom),
      agora_configured: Boolean(config.agoraAppId && config.agoraAppCertificate),
      bybit_configured: Boolean(config.bybitApiKey && config.bybitApiSecret),
      bybit_dry_run: config.bybitDryRun,
      bank_btc_address_configured: Boolean(config.bankBtcAddress),
    },
    recent: {
      users: recentUsers.map((user: any) => ({
        id: String(user._id),
        email: user.email,
        username: user.username,
        display_name: user.displayName,
        role: user.role,
        email_verified: user.emailVerified,
        setup_complete: (user.bankAccounts ?? []).length > 0 && (user.payoutWallets ?? []).length > 0,
        created_at: user.createdAt,
      })),
      escrows: recentEscrows.map((escrow: any) => ({
        id: String(escrow._id),
        sender_user_id: String(escrow.senderUserId),
        receiver_user_id: String(escrow.receiverUserId),
        coin: escrow.coin,
        amount: escrow.amount,
        status: escrow.status,
        created_at: escrow.createdAt,
        updated_at: escrow.updatedAt,
      })),
      deposits: recentDeposits.map(depositJson),
      events: recentEvents.map((event: any) => ({
        id: String(event._id),
        escrow_transaction_id: String(event.escrowTransactionId),
        actor_user_id: event.actorUserId ? String(event.actorUserId) : null,
        event_type: event.eventType,
        metadata: event.metadata ?? {},
        created_at: event.createdAt,
      })),
    },
  });
});

adminRouter.get("/deposits", async (_req, res) => {
  const deposits = await BtcDepositModel.find().sort({ createdAt: -1 }).limit(100);
  res.json(deposits.map(depositJson));
});

adminRouter.post("/deposits/refresh", async (_req, res) => {
  const response = await fetch(`https://mempool.space/api/address/${config.bankBtcAddress}/txs`);
  if (!response.ok) return res.status(502).json({ error: `mempool ${response.status}` });
  const txs = await response.json() as any[];

  let upserted = 0;
  for (const tx of txs) {
    const txid = tx.txid as string;
    const confirmed = Boolean(tx.status?.confirmed);
    const blockTime = tx.status?.block_time as number | undefined;
    const fromAddress = tx.vin?.[0]?.prevout?.scriptpubkey_address ?? null;
    const vouts = tx.vout ?? [];

    for (let i = 0; i < vouts.length; i++) {
      const vout = vouts[i];
      if (vout.scriptpubkey_address !== config.bankBtcAddress) continue;
      await BtcDepositModel.updateOne(
        { txid, vout: i },
        {
          $set: {
            fromAddress,
            amountBtc: Number(vout.value ?? 0) / 100000000,
            confirmations: confirmed ? 1 : 0,
            blockTime: blockTime ? new Date(blockTime * 1000) : null,
          },
          $setOnInsert: { status: "unmatched" },
        },
        { upsert: true },
      );
      upserted++;
    }
  }

  res.json({ ok: true, scanned: txs.length, upserted });
});

adminRouter.post("/deposits/:id/credit", async (req, res) => {
  const body = z.object({ user_id: z.string() }).parse(req.body);
  const deposit = await BtcDepositModel.findById(req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit not found" });
  if (deposit.get("status") !== "unmatched") return res.status(400).json({ error: `Already ${deposit.get("status")}` });
  const user = await UserModel.findById(body.user_id);
  if (!user) return res.status(404).json({ error: "User not found" });
  await WalletModel.updateOne(
    { userId: user._id, asset: "BTC" },
    { $inc: { balance: deposit.get("amountBtc") } },
    { upsert: true },
  );
  deposit.set("status", "credited");
  deposit.set("creditedUserId", user._id);
  deposit.set("creditedAt", new Date());
  await deposit.save();
  res.json({ ok: true });
});

adminRouter.get("/deposits/matches/:address", async (req, res) => {
  const users = await UserModel.find({ linkedBtcAddress: req.params.address }).limit(20);
  res.json(users.map((user) => ({
    id: String(user._id),
    username: user.username,
    display_name: user.displayName,
    phone: null,
  })));
});

function depositJson(deposit: any) {
  return {
    id: String(deposit._id),
    txid: deposit.txid,
    vout: deposit.vout,
    from_address: deposit.fromAddress ?? null,
    amount_btc: deposit.amountBtc,
    confirmations: deposit.confirmations,
    status: deposit.status,
    credited_user_id: deposit.creditedUserId ? String(deposit.creditedUserId) : null,
    credited_at: deposit.creditedAt ?? null,
    block_time: deposit.blockTime ?? null,
    created_at: deposit.createdAt,
    updated_at: deposit.updatedAt,
  };
}

function countMap(rows: any[]) {
  return Object.fromEntries(rows.map((row) => [row._id ?? "unknown", row.count]));
}
