# Gasless Utility Hub

A beginner-friendly Base Sepolia dApp powered by the Universal Gas Framework
testnet SDK. It lets users take real onchain actions without holding ETH for
gas.

The app currently supports two real flows:

- **Gasless Certificates**: mint an onchain certificate NFT through a deployed
  contract.
- **Send Mock USD**: transfer real `TYI_MOCK_USD` to another Base Sepolia
  address.

Both flows use UGF's lifecycle:

```text
Authenticate -> Quote -> Settle with TYI_MOCK_USD -> Execute -> Confirm
```

## Why This Exists

New users often cannot use dApps because they do not have the chain's native gas
token. This app demonstrates a smoother UX: users sign with their wallet and pay
gas using Mock USD while UGF handles the destination-chain gas execution.

## Tech Stack

- React
- Vite
- ethers v6
- `@tychilabs/ugf-testnet-js`
- Base Sepolia
- `TYI_MOCK_USD` as the UGF settlement token

## Requirements

- Node.js 18+
- MetaMask or another injected EIP-1193 wallet
- Base Sepolia network in your wallet
- A deployed certificate NFT contract on Base Sepolia
- `TYI_MOCK_USD` from the UGF faucet

## Environment Setup

Create a `.env` or `.env.local` file in the project root:

```env
VITE_BADGE_NFT_ADDRESS=0xYourDeployedCertificateContract
```

The address must be a real deployed contract on Base Sepolia.

## Certificate Contract

The frontend expects a contract with this minimal interface:

```solidity
function mint(address to, uint256 tokenId) external;
function ownerOf(uint256 tokenId) external view returns (address);
function balanceOf(address owner) external view returns (uint256);
```

You can deploy this simple contract with Remix:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract GasFreeBadge {
    string public name = "GasFreeBadge";
    string public symbol = "GFB";

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function mint(address to, uint256 tokenId) external {
        require(to != address(0), "Invalid receiver");
        require(_owners[tokenId] == address(0), "Already minted");

        _owners[tokenId] = to;
        _balances[to] += 1;

        emit Transfer(address(0), to, tokenId);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "Token does not exist");
        return owner;
    }

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "Invalid owner");
        return _balances[owner];
    }
}
```

Deployment itself requires a small amount of Base Sepolia ETH. App users do not
need ETH for the mint/send actions after setup.

## Getting Test Tokens

You need two kinds of test tokens:

- **Base Sepolia ETH**: only needed to deploy the certificate contract.
- **TYI_MOCK_USD**: needed by app users to settle UGF gas payments.

Useful faucets:

- Base Sepolia ETH: `https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet`
- Base Sepolia ETH: `https://faucet.quicknode.com/base`
- UGF Mock USD: `https://universalgasframework.com/faucets`

## Install

```bash
npm install
```

## Run Locally

```bash
npm run dev -- --host=127.0.0.1 --port=5173
```

Open:

```text
http://127.0.0.1:5173
```

## Build

```bash
npm run build
```

## Lint

```bash
npm run lint
```

## How To Use The App

1. Deploy the `GasFreeBadge` contract on Base Sepolia.
2. Add the deployed address to `.env` or `.env.local`.
3. Restart the Vite dev server.
4. Connect your wallet in the app.
5. Claim `TYI_MOCK_USD` from the UGF faucet.
6. Use either:
   - **Certificates** to mint a gasless certificate NFT.
   - **Send Mock USD** to transfer Mock USD to another address.
7. Watch the UGF lifecycle panel show quote, settlement, execution, and tx hash.

## What Is Real

The app does not use fake wallets, fake quotes, fake transaction hashes, or mock
activity.

It reads:

- the connected wallet from MetaMask
- the live UGF token registry
- the real `TYI_MOCK_USD` balance
- the deployed certificate contract
- real UGF quote and x402 settlement payloads
- real Base Sepolia transaction hashes

## Notes

- The UGF testnet SDK supports Base Sepolia and `TYI_MOCK_USD`.
- If x402 settlement fails, first check that your wallet has enough
  `TYI_MOCK_USD`.
- If the certificate UI says the contract is not configured, check
  `VITE_BADGE_NFT_ADDRESS` and restart the dev server.
