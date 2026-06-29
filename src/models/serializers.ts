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
    bank_accounts: (user.bankAccounts ?? []).map((account: any) => ({
      bank_name: account.bankName,
      account_name: account.accountName,
      account_number: account.accountNumber,
      currency: account.currency,
    })),
    payout_wallets: (user.payoutWallets ?? []).map((wallet: any) => ({
      asset: wallet.asset,
      provider: wallet.provider,
      address: wallet.address,
    })),
    trade_status: user.tradeStatus
      ? {
          type: user.tradeStatus.type,
          coin: user.tradeStatus.coin,
          network: user.tradeStatus.network,
          payment_method: user.tradeStatus.paymentMethod,
          rate: user.tradeStatus.rate ?? null,
          active: user.tradeStatus.active,
          updated_at: user.tradeStatus.updatedAt,
        }
      : null,
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
    voice_data_url: message.voiceDataUrl ?? null,
    voice_duration_ms: message.voiceDurationMs ?? null,
    image_data_url: message.imageDataUrl ?? null,
    transfer_asset: message.transferAsset ?? null,
    transfer_amount: message.transferAmount ?? null,
    transfer_note: message.transferNote ?? null,
    offer_id: message.offerId ? id(message.offerId) : null,
    offer: message.offerSnapshot ?? null,
    trade_id: message.tradeId ? id(message.tradeId) : null,
    trade: message.tradeSnapshot ?? null,
    read_by: (message.readReceipts ?? []).map((receipt: any) => ({
      user_id: id(receipt.userId),
      read_at: receipt.readAt,
    })),
    created_at: message.createdAt,
  };
}

export function offerJson(offer: any) {
  return {
    id: id(offer._id),
    user_id: id(offer.userId?._id ?? offer.userId),
    user: offer.userId?.email ? userPublic(offer.userId) : null,
    side: offer.side,
    coin: offer.coin,
    fiat_currency: offer.fiatCurrency,
    crypto_amount: offer.cryptoAmount,
    rate: offer.rate,
    min_fiat_amount: offer.minFiatAmount,
    max_fiat_amount: offer.maxFiatAmount,
    payment_method: offer.paymentMethod,
    terms: offer.terms ?? "",
    status: offer.status,
    created_at: offer.createdAt,
    updated_at: offer.updatedAt,
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
