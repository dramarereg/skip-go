import { atom } from "jotai";
import {
  Asset,
  SkipClient,
  Chain,
  RouteRequest,
  SkipClientOptions,
} from "@skip-go/client";
import { atomWithQuery } from "jotai-tanstack-query";
import { apiURL, endpointOptions } from "@/constants/skipClientDefault";
import {
  debouncedDestinationAssetAmountAtom,
  debouncedSourceAssetAmountAtom,
  destinationAssetAtom,
  isInvertingSwapAtom,
  routeAmountEffect,
  sourceAssetAtom,
  swapDirectionAtom,
} from "./swapPage";
import { getAmountWei } from "@/utils/number";
import { walletsAtom } from "./wallets";
import { getWallet, WalletType } from "graz";
import { getWalletClient } from "@wagmi/core";
import { config } from "@/constants/wagmi";
import { WalletClient } from "viem";
import { solanaWallets } from "@/constants/solana";
import { Adapter } from "@solana/wallet-adapter-base";
import { defaultTheme, Theme } from "@/widget/theme";

export const skipClientConfigAtom = atom<SkipClientOptions>({
  apiURL,
  endpointOptions,
});

export const themeAtom = atom<Theme>(defaultTheme);

export const skipClient = atom((get) => {
  const options = get(skipClientConfigAtom);
  const wallets = get(walletsAtom);

  return new SkipClient({
    ...options,
    getCosmosSigner: async (chainID) => {
      if (!wallets.cosmos) {
        throw new Error("getCosmosSigner error: no cosmos wallet");
      }
      const wallet = getWallet(wallets.cosmos.walletName as WalletType);
      if (!wallet) {
        throw new Error("getCosmosSigner error: wallet not found");
      }
      const key = await wallet.getKey(chainID);

      return key.isNanoLedger ? wallet.getOfflineSignerOnlyAmino(chainID) : wallet.getOfflineSigner(chainID);
    },
    // @ts-expect-error having a different viem version
    getEVMSigner: async (chainID) => {
      const evmWalletClient = (await getWalletClient(config, {
        chainId: parseInt(chainID),
      })) as WalletClient;

      return evmWalletClient;
    },
    // @ts-expect-error solanaWallet is not a merged Adapter
    getSVMSigner: async () => {
      const walletName = wallets.svm?.walletName;
      if (!walletName) throw new Error("getSVMSigner error: no svm wallet");
      const solanaWallet = solanaWallets.find((w) => w.name === walletName);
      if (!solanaWallet) throw new Error("getSVMSigner error: wallet not found");
      return solanaWallet as Adapter;
    }
  });
});

export type ClientAsset = Asset & {
  chain_key: string;
  chainName: string;
};

const flattenData = (data: Record<string, Asset[]>, chains?: Chain[]) => {
  const flattenedData: ClientAsset[] = [];

  for (const chainKey in data) {
    data[chainKey].forEach((asset: Asset) => {
      const chain = chains?.find((c) => c.chainID === asset.chainID);
      flattenedData.push({
        ...asset,
        chain_key: chainKey,
        chainName:
          chain?.prettyName ?? chain?.chainName ?? asset.chainID ?? "--",
      });
    });
  }

  return flattenedData;
};

export const skipAssetsAtom = atomWithQuery((get) => {
  const skip = get(skipClient);
  const chains = get(skipChainsAtom);

  return {
    queryKey: ["skipAssets"],
    queryFn: async () => {
      return skip
        .assets({
          includeEvmAssets: true,
          includeCW20Assets: true,
          includeSvmAssets: true,
        })
        .then((v) => flattenData(v, chains.data));
    },
  };
});

export const skipChainsAtom = atomWithQuery((get) => {
  const skip = get(skipClient);
  return {
    queryKey: ["skipChains"],
    queryFn: async () => {
      return skip.chains({
        includeEVM: true,
        includeSVM: true,
      });
    },
  };
});

export const skipBridgesAtom = atomWithQuery((get) => {
  const skip = get(skipClient);
  return {
    queryKey: ["skipBridges"],
    queryFn: async () => {
      return skip.bridges();
    },
  };
});

export const skipSwapVenuesAtom = atomWithQuery((get) => {
  const skip = get(skipClient);
  return {
    queryKey: ["skipSwapVenue"],
    queryFn: async () => {
      return skip.venues();
    },
  };
});

type SkipTransactionStatusProps = {
  txsRequired: number;
  txs: { chainID: string; txHash: string }[] | undefined;
}

export const skipTransactionStatusPropsAtom = atom<SkipTransactionStatusProps>({
  txsRequired: 0,
  txs: undefined,
});

export const skipTransactionStatus = atomWithQuery((get) => {
  const skip = get(skipClient);
  const { txs, txsRequired } = get(skipTransactionStatusPropsAtom);

  return {
    queryKey: ["skipTxStatus", txs, txsRequired],
    queryFn: async () => {
      if (!txs) return;

      return Promise.all(
        txs.map(async (tx) => {
          return skip.transactionStatus({
            chainID: tx.chainID,
            txHash: tx.txHash,
          });
        })
      );
    },
    refetchInterval: 1000 * 2,
    keepPreviousData: true,
  };
});

const skipRouteRequestAtom = atom<RouteRequest | undefined>((get) => {
  const sourceAsset = get(sourceAssetAtom);
  const destinationAsset = get(destinationAssetAtom);
  const direction = get(swapDirectionAtom);
  const sourceAssetAmount = get(debouncedSourceAssetAmountAtom);
  const destinationAssetAmount = get(debouncedDestinationAssetAmountAtom);
  const isInvertingSwap = get(isInvertingSwapAtom);

  if (
    !sourceAsset?.chainID ||
    !sourceAsset.denom ||
    !destinationAsset?.chainID ||
    !destinationAsset.denom ||
    isInvertingSwap
  ) {
    return undefined;
  }
  const amount =
    direction === "swap-in"
      ? {
        amountIn:
          getAmountWei(sourceAssetAmount, sourceAsset.decimals) || "0",
      }
      : {
        amountOut:
          getAmountWei(destinationAssetAmount, destinationAsset.decimals) ||
          "0",
      };

  return {
    ...amount,
    sourceAssetChainID: sourceAsset.chainID,
    sourceAssetDenom: sourceAsset.denom,
    destAssetChainID: destinationAsset.chainID,
    destAssetDenom: destinationAsset.denom,
  };
});

export const skipRouteAtom = atomWithQuery((get) => {
  const skip = get(skipClient);
  const params = get(skipRouteRequestAtom);

  get(routeAmountEffect);

  return {
    queryKey: ["skipRoute", params],
    queryFn: async () => {
      if (!params) {
        throw new Error("No route request provided");
      }
      return skip.route({
        ...params,
        smartRelay: true,
        smartSwapOptions: {
          splitRoutes: true,
          evmSwaps: true,
        },
        experimentalFeatures: ["hyperlane"],
        allowMultiTx: true,
        allowUnsafe: true,
      });
    },
    retry: 1,
    enabled:
      !!params && (Number(params.amountIn) > 0 || Number(params.amountOut) > 0),
    refetchInterval: 1000 * 30,
  };
});

export type ChainWithAsset = Chain & {
  asset?: ClientAsset;
};

export const getChainsContainingAsset = (
  assetSymbol: string,
  assets: ClientAsset[],
  chains: Chain[]
): ChainWithAsset[] => {
  if (!assets) return [];
  const chainIDs = assets
    .filter((asset) => asset.symbol === assetSymbol)
    .map((asset) => asset.chainID);
  const chainsContainingAsset = chains
    .filter((chain) => chainIDs?.includes(chain.chainID))
    .map((chain) => {
      return {
        ...chain,
        asset: assets.find(
          (asset) =>
            asset.chainID === chain.chainID && asset.symbol === assetSymbol
        ),
      };
    });
  return chainsContainingAsset;
};
