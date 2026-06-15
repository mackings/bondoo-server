import type { HydratedDocument } from "mongoose";

export function id(value: unknown) {
  return String(value);
}

export function userPublic(user: any) {
  return {
    id: id(user._id),
    username: user.username,
    display_name: user.displayName,
    avatar_url: user.avatarUrl ?? null,
    email: user.email,
    role: user.role,
    linked_btc_address: user.linkedBtcAddress ?? null,
    linked_eth_address: user.linkedEthAddress ?? null,
    email_verified: user.emailVerified,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  };
}

export function walletJson(wallet: any) {
  return {
    id: id(wallet._id),
    user_id: id(wallet.userId),
    asset: wallet.asset,
    balance: wallet.balance,
    updated_at: wallet.updatedAt,
  };
}

export function messageJson(message: any) {
  return {
    id: id(message._id),
    conversation_id: id(message.conversationId),
    sender_id: id(message.senderId),
    kind: message.kind,
    body: message.body ?? null,
    transfer_asset: message.transferAsset ?? null,
    transfer_amount: message.transferAmount ?? null,
    transfer_note: message.transferNote ?? null,
    created_at: message.createdAt,
  };
}

export function escrowJson(escrow: HydratedDocument<any> | any) {
  return {
    id: id(escrow._id),
    sender_user_id: id(escrow.senderUserId),
    receiver_user_id: id(escrow.receiverUserId),
    coin: escrow.coin,
    network: escrow.network,
    amount: escrow.amount,
    platform_fee: escrow.platformFee,
    network_fee: escrow.networkFee,
    payout_amount: escrow.payoutAmount,
    deposit_address: escrow.depositAddress,
    deposit_txid: escrow.depositTxid ?? null,
    withdrawal_id: escrow.withdrawalId ?? null,
    receiver_wallet_address: escrow.receiverWalletAddress ?? null,
    receiver_wallet_network: escrow.receiverWalletNetwork ?? null,
    status: escrow.status,
    created_at: escrow.createdAt,
    updated_at: escrow.updatedAt,
    funded_at: escrow.fundedAt ?? null,
    paid_out_at: escrow.paidOutAt ?? null,
  };
}
