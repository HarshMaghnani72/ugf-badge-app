import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_TYPE,
  TYI_USD_PAYMENT_COIN,
  UGFClient,
} from "@tychilabs/ugf-testnet-js";
import { ethers } from "ethers";

const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const BADGE_NFT_ADDRESS = import.meta.env.VITE_BADGE_NFT_ADDRESS?.trim() ?? "";

const MINT_ABI = [
  "function mint(address to, uint256 tokenId) external",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 value) returns (bool)",
];

const CERTIFICATES = [
  {
    id: 1,
    name: "Gasless Starter",
    description: "Proof that your first app action landed without native gas.",
    color: "#00d4ff",
    rarity: "Starter",
  },
  {
    id: 2,
    name: "Builder Checkpoint",
    description: "A Base Sepolia builder credential minted through UGF.",
    color: "#00ff9d",
    rarity: "Builder",
  },
  {
    id: 3,
    name: "Invisible Gas",
    description: "A public receipt that Mock USD powered the gas path.",
    color: "#ff6b35",
    rarity: "Advanced",
  },
];

const STEPS = [
  { key: "auth", label: "Authenticate" },
  { key: "quote", label: "Quote" },
  { key: "settle", label: "Settle" },
  { key: "execute", label: "Execute" },
];

const shortAddr = (value) => (value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "");
const isConfiguredAddress = ethers.isAddress(BADGE_NFT_ADDRESS);

function certificateTokenId(address, certificateId) {
  if (!ethers.isAddress(address)) return null;
  return BigInt(ethers.solidityPackedKeccak256(["address", "uint256"], [address, certificateId]));
}

function shortTokenId(tokenId) {
  return tokenId ? `#${tokenId.toString().slice(0, 8)}...${tokenId.toString().slice(-5)}` : "";
}

function errorText(error) {
  const code = error?.code ? `[${error.code}] ` : "";
  const status = error?.statusCode ? ` HTTP ${error.statusCode}` : "";
  return `${code}${error?.message ?? "Unknown error"}${status}`;
}

async function ensureBaseSepolia(provider) {
  const chainId = `0x${Number(BASE_SEPOLIA_CHAIN_ID).toString(16)}`;
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId }]);
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await provider.send("wallet_addEthereumChain", [
      {
        chainId,
        chainName: "Base Sepolia",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [BASE_SEPOLIA_RPC],
        blockExplorerUrls: ["https://sepolia.basescan.org"],
      },
    ]);
  }
}

export default function App() {
  const [view, setView] = useState("certificates");
  const [wallet, setWallet] = useState(null);
  const [tokenInfo, setTokenInfo] = useState(null);
  const [claimed, setClaimed] = useState([]);
  const [txState, setTxState] = useState("idle");
  const [activeAction, setActiveAction] = useState(null);
  const [stepStatus, setStepStatus] = useState({});
  const [quote, setQuote] = useState(null);
  const [x402Payload, setX402Payload] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [recipient, setRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("1");
  const [activity, setActivity] = useState([]);
  const [particles, setParticles] = useState([]);
  const confettiRef = useRef(false);

  const configError = useMemo(() => {
    if (!BADGE_NFT_ADDRESS) return "Set VITE_BADGE_NFT_ADDRESS to your deployed certificate contract.";
    if (!isConfiguredAddress) return "VITE_BADGE_NFT_ADDRESS is not a valid EVM address.";
    return null;
  }, []);

  const refreshToken = useCallback(async (provider, owner) => {
    if (!provider || !owner) return null;
    const client = new UGFClient();
    const registry = await client.registry.get();
    const option = registry.payment_options.find(
      (item) => item.type === "x402" && item.token === TYI_USD_PAYMENT_COIN,
    );
    const chain = option?.chains.find((item) => item.chain_id === BASE_SEPOLIA_CHAIN_ID);
    if (!chain?.address || !ethers.isAddress(chain.address)) {
      throw new Error(`Could not find ${TYI_USD_PAYMENT_COIN} on Base Sepolia.`);
    }

    const token = new ethers.Contract(chain.address, ERC20_ABI, provider);
    const [rawBalance, decimals] = await Promise.all([
      token.balanceOf(owner),
      token.decimals().catch(() => 6),
    ]);
    const next = {
      address: chain.address,
      receiver: option.receiver_address,
      rawBalance,
      decimals,
      balance: ethers.formatUnits(rawBalance, decimals),
    };
    setTokenInfo(next);
    return next;
  }, []);

  const refreshCertificates = useCallback(async (provider, owner) => {
    if (!provider || !owner || !isConfiguredAddress) return;
    const contract = new ethers.Contract(BADGE_NFT_ADDRESS, MINT_ABI, provider);
    const results = await Promise.all(
      CERTIFICATES.map(async (certificate) => {
        try {
          const tokenId = certificateTokenId(owner, certificate.id);
          const tokenOwner = await contract.ownerOf(tokenId);
          return tokenOwner.toLowerCase() === owner.toLowerCase() ? certificate.id : null;
        } catch {
          return null;
        }
      }),
    );
    setClaimed(results.filter(Boolean));
  }, []);

  const refreshAll = useCallback(
    async (nextWallet = wallet) => {
      if (!nextWallet) return;
      await Promise.all([
        refreshToken(nextWallet.provider, nextWallet.address),
        refreshCertificates(nextWallet.provider, nextWallet.address),
      ]);
    },
    [refreshCertificates, refreshToken, wallet],
  );

  const connectWallet = useCallback(async () => {
    setErrorMsg(null);
    try {
      if (!window.ethereum) throw new Error("Install MetaMask or another injected wallet.");
      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      await ensureBaseSepolia(provider);
      const network = await provider.getNetwork();
      if (String(network.chainId) !== BASE_SEPOLIA_CHAIN_ID) {
        throw new Error(`Switch to Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}).`);
      }
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const nextWallet = { provider, signer, address };
      setWallet(nextWallet);
      await refreshAll(nextWallet);
      setTxState("idle");
    } catch (error) {
      setTxState("error");
      setErrorMsg(errorText(error));
    }
  }, [refreshAll]);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    const reset = () => {
      setWallet(null);
      setTokenInfo(null);
      setClaimed([]);
      resetTx();
    };
    window.ethereum.on?.("accountsChanged", reset);
    window.ethereum.on?.("chainChanged", reset);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", reset);
      window.ethereum.removeListener?.("chainChanged", reset);
    };
  }, []);

  async function runUgfAction({ title, txObject, buildTx, extraSpend = 0n }) {
    if (!wallet || txState === "running") return;
    const client = new UGFClient();
    let stage = "auth";

    setTxState("running");
    setActiveAction(title);
    setStepStatus({});
    setQuote(null);
    setX402Payload(null);
    setTxHash(null);
    setErrorMsg(null);

    const mark = (key, status) => setStepStatus((state) => ({ ...state, [key]: status }));

    try {
      stage = "auth";
      mark(stage, "active");
      await client.auth.login(wallet.signer);
      mark(stage, "done");

      stage = "quote";
      mark(stage, "active");
      const fetchedQuote = await client.quote.get({
        payer_address: wallet.address,
        payment_coin: TYI_USD_PAYMENT_COIN,
        payment_chain: BASE_SEPOLIA_CHAIN_ID,
        payment_chain_type: BASE_SEPOLIA_CHAIN_TYPE,
        dest_chain_id: BASE_SEPOLIA_CHAIN_ID,
        dest_chain_type: BASE_SEPOLIA_CHAIN_TYPE,
        tx_object: JSON.stringify(txObject),
      });
      setQuote(fetchedQuote);
      mark(stage, "done");

      stage = "settle";
      mark(stage, "active");
      const latestToken = await refreshToken(wallet.provider, wallet.address);
      const settlementCost = BigInt(fetchedQuote.payment_amount);
      if (!latestToken || latestToken.rawBalance < settlementCost + extraSpend) {
        const required = ethers.formatUnits(settlementCost + extraSpend, latestToken?.decimals ?? 6);
        throw new Error(`Insufficient ${TYI_USD_PAYMENT_COIN}. You have ${latestToken?.balance ?? "0"}, need ${required}.`);
      }
      const payload = await client.payment.x402.sign(fetchedQuote, wallet.signer, wallet.provider, {
        validForSeconds: 900,
      });
      setX402Payload(payload);
      await client.payment.x402.submit(payload);
      mark(stage, "done");

      stage = "execute";
      mark(stage, "active");
      const { userTxHash } = await client.chains.evm.sponsorAndExecute(
        fetchedQuote.digest,
        wallet.signer,
        buildTx,
      );
      mark(stage, "done");
      setTxHash(userTxHash);
      setActivity((items) => [
        { title, hash: userTxHash, when: new Date().toLocaleTimeString() },
        ...items,
      ]);
      await refreshAll();
      setTxState("success");
      triggerConfetti();
    } catch (error) {
      mark(stage, "error");
      setTxState("error");
      setErrorMsg(errorText(error));
      console.error("[UGF]", stage, error);
    }
  }

  async function mintCertificate(certificate) {
    if (configError) {
      setTxState("error");
      setErrorMsg(configError);
      return;
    }
    const tokenId = certificateTokenId(wallet.address, certificate.id);
    const iface = new ethers.Interface(MINT_ABI);
    const data = iface.encodeFunctionData("mint", [wallet.address, tokenId]);
    await runUgfAction({
      title: `Mint ${certificate.name}`,
      txObject: { from: wallet.address, to: BADGE_NFT_ADDRESS, data, value: "0" },
      buildTx: async () => ({ to: BADGE_NFT_ADDRESS, data, value: 0n }),
    });
  }

  async function sendMockUsd() {
    if (!tokenInfo) return;
    if (!ethers.isAddress(recipient)) {
      setTxState("error");
      setErrorMsg("Enter a valid recipient address.");
      return;
    }
    const amount = ethers.parseUnits(sendAmount || "0", tokenInfo.decimals);
    if (amount <= 0n) {
      setTxState("error");
      setErrorMsg("Enter an amount greater than zero.");
      return;
    }
    const iface = new ethers.Interface(ERC20_ABI);
    const data = iface.encodeFunctionData("transfer", [recipient, amount]);
    await runUgfAction({
      title: `Send ${sendAmount} ${TYI_USD_PAYMENT_COIN}`,
      txObject: { from: wallet.address, to: tokenInfo.address, data, value: "0" },
      buildTx: async () => ({ to: tokenInfo.address, data, value: 0n }),
      extraSpend: amount,
    });
  }

  function resetTx() {
    setTxState("idle");
    setActiveAction(null);
    setStepStatus({});
    setQuote(null);
    setX402Payload(null);
    setTxHash(null);
    setErrorMsg(null);
  }

  function triggerConfetti() {
    if (confettiRef.current) return;
    confettiRef.current = true;
    setParticles(
      Array.from({ length: 44 }, (_, id) => ({
        id,
        x: Math.random() * 100,
        drift: (Math.random() - 0.5) * 180,
        speed: Math.random() * 2.5 + 2,
        color: ["#00d4ff", "#00ff9d", "#ff6b35", "#ffd166"][Math.floor(Math.random() * 4)],
      })),
    );
    window.setTimeout(() => {
      setParticles([]);
      confettiRef.current = false;
    }, 3800);
  }

  return (
    <>
      <style>{CSS}</style>
      {particles.map((p) => (
        <span
          key={p.id}
          className="particle"
          style={{ left: `${p.x}vw`, "--drift": `${p.drift}px`, animationDuration: `${p.speed}s`, background: p.color }}
        />
      ))}

      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span>UGF</span>
            <strong>Gasless Utility Hub</strong>
          </div>
          <nav>
            {[
              ["certificates", "Certificates"],
              ["send", "Send Mock USD"],
              ["activity", "Activity"],
              ["setup", "Setup"],
            ].map(([key, label]) => (
              <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
                {label}
              </button>
            ))}
          </nav>
          {!wallet ? (
            <button className="connect" onClick={connectWallet}>Connect Wallet</button>
          ) : (
            <button className="wallet" onClick={() => refreshAll()}>{shortAddr(wallet.address)}</button>
          )}
        </header>

        <main>
          <section className="hero">
            <div>
              <p>Base Sepolia dApp powered by Universal Gas Framework</p>
              <h1>Do useful onchain actions without keeping ETH for gas.</h1>
            </div>
            <div className="metrics">
              <Metric label="Network" value="Base Sepolia" />
              <Metric label="Gas paid with" value={TYI_USD_PAYMENT_COIN} />
              <Metric label="TYI balance" value={tokenInfo ? Number(tokenInfo.balance).toLocaleString() : "Connect"} />
              <Metric label="Certificate contract" value={isConfiguredAddress ? shortAddr(BADGE_NFT_ADDRESS) : "Not set"} />
            </div>
          </section>

          <div className="workspace">
            <section className="panel main-panel">
              {view === "certificates" && (
                <CertificatesView
                  wallet={wallet}
                  claimed={claimed}
                  txState={txState}
                  configError={configError}
                  mintCertificate={mintCertificate}
                />
              )}
              {view === "send" && (
                <SendView
                  wallet={wallet}
                  tokenInfo={tokenInfo}
                  recipient={recipient}
                  setRecipient={setRecipient}
                  sendAmount={sendAmount}
                  setSendAmount={setSendAmount}
                  sendMockUsd={sendMockUsd}
                  txState={txState}
                />
              )}
              {view === "activity" && <ActivityView activity={activity} />}
              {view === "setup" && <SetupView tokenInfo={tokenInfo} configError={configError} />}
            </section>

            <aside className="panel side-panel">
              <StatusPanel
                txState={txState}
                activeAction={activeAction}
                stepStatus={stepStatus}
                quote={quote}
                x402Payload={x402Payload}
                txHash={txHash}
                errorMsg={errorMsg}
                resetTx={resetTx}
              />
            </aside>
          </div>
        </main>
      </div>
    </>
  );
}

function CertificatesView({ wallet, claimed, txState, configError, mintCertificate }) {
  return (
    <>
      <Header title="Gasless Certificates" text="Mint real onchain credentials. Each wallet receives unique token IDs, and UGF handles gas after Mock USD settlement." />
      {configError && <div className="notice">{configError}</div>}
      <div className="card-grid">
        {CERTIFICATES.map((certificate) => {
          const tokenId = wallet ? certificateTokenId(wallet.address, certificate.id) : null;
          const isClaimed = claimed.includes(certificate.id);
          return (
            <button
              key={certificate.id}
              className="certificate-card"
              style={{ "--accent": certificate.color }}
              disabled={!wallet || isClaimed || txState === "running" || Boolean(configError)}
              onClick={() => mintCertificate(certificate)}
            >
              <span>{certificate.rarity}</span>
              <strong>{certificate.name}</strong>
              <p>{certificate.description}</p>
              <small>{tokenId ? shortTokenId(tokenId) : "Connect wallet for token ID"}</small>
              <b>{isClaimed ? "Already minted" : wallet ? "Mint with UGF" : "Connect wallet"}</b>
            </button>
          );
        })}
      </div>
    </>
  );
}

function SendView({ wallet, tokenInfo, recipient, setRecipient, sendAmount, setSendAmount, sendMockUsd, txState }) {
  return (
    <>
      <Header title="Send Mock USD" text="A real wallet action: transfer TYI_MOCK_USD to any Base Sepolia address while UGF pays the destination gas path." />
      <div className="form-grid">
        <label>
          Recipient
          <input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x..." />
        </label>
        <label>
          Amount
          <input value={sendAmount} onChange={(event) => setSendAmount(event.target.value)} inputMode="decimal" />
        </label>
        <div className="balance-box">
          <span>Available</span>
          <strong>{tokenInfo ? `${tokenInfo.balance} ${TYI_USD_PAYMENT_COIN}` : "Connect wallet"}</strong>
        </div>
        <button className="primary" disabled={!wallet || !tokenInfo || txState === "running"} onClick={sendMockUsd}>
          Send Through UGF
        </button>
      </div>
    </>
  );
}

function ActivityView({ activity }) {
  return (
    <>
      <Header title="Real Activity" text="No fake feed. This list only shows transactions completed from this browser session." />
      {activity.length === 0 ? (
        <div className="empty">No completed UGF actions yet.</div>
      ) : (
        <div className="activity-list">
          {activity.map((item) => (
            <a key={item.hash} href={`https://sepolia.basescan.org/tx/${item.hash}`} target="_blank" rel="noreferrer">
              <span>{item.title}</span>
              <b>{shortAddr(item.hash)}</b>
              <small>{item.when}</small>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function SetupView({ tokenInfo, configError }) {
  return (
    <>
      <Header title="Setup Checklist" text="Everything here is required for a fully real Base Sepolia UGF flow." />
      <div className="setup-list">
        <Check ok={isConfiguredAddress && !configError} title="Certificate contract" text={isConfiguredAddress ? BADGE_NFT_ADDRESS : "Deploy the contract and set VITE_BADGE_NFT_ADDRESS."} />
        <Check ok={Boolean(tokenInfo)} title="UGF token registry" text={tokenInfo ? `${TYI_USD_PAYMENT_COIN}: ${tokenInfo.address}` : "Connect wallet to read live registry."} />
        <Check ok={tokenInfo?.rawBalance > 0n} title="Mock USD balance" text={tokenInfo ? `${tokenInfo.balance} ${TYI_USD_PAYMENT_COIN}` : "Claim TYI_MOCK_USD from the UGF faucet."} />
        <Check ok title="No mocked execution" text="Quotes, x402 signatures, status polling, and tx hashes are produced by UGF/Base Sepolia." />
      </div>
    </>
  );
}

function StatusPanel({ txState, activeAction, stepStatus, quote, x402Payload, txHash, errorMsg, resetTx }) {
  return (
    <>
      <Header title="UGF Lifecycle" text={activeAction ?? "Select an action to start."} />
      <div className="steps">
        {STEPS.map((step) => {
          const status = stepStatus[step.key] ?? "idle";
          return (
            <div key={step.key} className={`step ${status}`}>
              <span>{status === "done" ? "OK" : status === "error" ? "!" : status === "active" ? "..." : ""}</span>
              <b>{step.label}</b>
            </div>
          );
        })}
      </div>
      {quote && (
        <div className="data-box">
          <Row label="Digest" value={shortAddr(quote.digest)} />
          <Row label="Payment" value={quote.payment_amount} />
          <Row label="Receiver" value={shortAddr(quote.payment_to)} />
        </div>
      )}
      {x402Payload && (
        <div className="data-box">
          <Row label="x402 v" value={String(x402Payload.v)} />
          <Row label="Nonce" value={shortAddr(x402Payload.nonce)} />
          <Row label="Valid before" value={new Date(x402Payload.valid_before * 1000).toLocaleTimeString()} />
        </div>
      )}
      {txState === "success" && txHash && (
        <div className="result success">
          <strong>Completed onchain</strong>
          <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer">{shortAddr(txHash)}</a>
          <button onClick={resetTx}>Clear</button>
        </div>
      )}
      {txState === "error" && (
        <div className="result error">
          <strong>Action stopped</strong>
          <p>{errorMsg}</p>
          <button onClick={resetTx}>Clear</button>
        </div>
      )}
    </>
  );
}

function Header({ title, text }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Check({ ok, title, text }) {
  return (
    <div className={`check ${ok ? "ok" : ""}`}>
      <span>{ok ? "OK" : "!"}</span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

const CSS = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --bg: #030910;
  --surface: #08111d;
  --surface2: #0d1a2a;
  --border: #18304a;
  --border2: #254969;
  --text: #d8eefc;
  --muted: #7893aa;
  --blue: #00d4ff;
  --green: #00ff9d;
  --orange: #ff6b35;
  --red: #ff5d5d;
  --mono: "SFMono-Regular", Consolas, monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); }
button, input { font: inherit; }
.app { min-height: 100vh; background-image: linear-gradient(rgba(0,212,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,.035) 1px, transparent 1px); background-size: 42px 42px; }
.topbar { position: sticky; top: 0; z-index: 5; display: grid; grid-template-columns: auto 1fr auto; gap: 18px; align-items: center; padding: 14px 24px; background: rgba(3,9,16,.9); border-bottom: 1px solid var(--border); backdrop-filter: blur(16px); }
.brand { display: flex; gap: 10px; align-items: center; }
.brand span { border: 1px solid rgba(0,212,255,.35); color: var(--blue); padding: 3px 7px; border-radius: 6px; font: 11px var(--mono); }
.brand strong { color: #fff; }
nav { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
nav button, .wallet, .connect { border: 1px solid transparent; border-radius: 8px; padding: 9px 12px; background: transparent; color: var(--muted); cursor: pointer; }
nav button.active { color: #001018; background: var(--blue); font-weight: 800; }
.connect { color: #001018; background: linear-gradient(135deg, var(--blue), var(--green)); font-weight: 850; }
.wallet { color: var(--text); border-color: var(--border2); background: var(--surface2); font-family: var(--mono); }
main { max-width: 1220px; margin: 0 auto; padding: 38px 24px 72px; }
.hero { display: grid; grid-template-columns: 1fr 430px; gap: 28px; align-items: end; margin-bottom: 28px; }
.hero p { color: var(--blue); margin: 0 0 10px; font: 12px var(--mono); text-transform: uppercase; letter-spacing: 1.5px; }
.hero h1 { margin: 0; max-width: 720px; color: #fff; font-size: clamp(38px, 6vw, 70px); line-height: 1.02; letter-spacing: 0; }
.metrics { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
.metrics div { padding: 14px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); min-width: 0; }
.metrics span { display: block; color: var(--muted); font-size: 12px; }
.metrics strong { display: block; color: var(--text); font: 700 13px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 4px; }
.workspace { display: grid; grid-template-columns: 1fr 390px; gap: 24px; align-items: start; }
.panel { background: rgba(8,17,29,.95); border: 1px solid var(--border); border-radius: 8px; padding: 22px; }
.section-head { margin-bottom: 18px; }
.section-head h2 { margin: 0 0 6px; color: #fff; font-size: 22px; }
.section-head p { margin: 0; color: var(--muted); line-height: 1.5; }
.notice { border: 1px solid rgba(255,93,93,.4); color: #ffd4d4; background: rgba(255,93,93,.08); padding: 12px; border-radius: 8px; margin-bottom: 16px; font: 13px var(--mono); }
.card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.certificate-card { min-height: 260px; padding: 18px; text-align: left; border: 1px solid var(--border); border-radius: 8px; background: var(--surface2); color: var(--text); display: flex; flex-direction: column; gap: 12px; cursor: pointer; transition: .2s; }
.certificate-card:not(:disabled):hover { transform: translateY(-3px); border-color: var(--accent); box-shadow: 0 0 26px color-mix(in srgb, var(--accent) 24%, transparent); }
.certificate-card:disabled { cursor: not-allowed; opacity: .65; }
.certificate-card span { align-self: flex-start; color: var(--accent); border: 1px solid var(--accent); border-radius: 4px; padding: 3px 7px; font: 11px var(--mono); }
.certificate-card strong { color: #fff; font-size: 22px; }
.certificate-card p { margin: 0; color: var(--muted); line-height: 1.45; }
.certificate-card small { margin-top: auto; color: var(--muted); font: 12px var(--mono); }
.certificate-card b { color: var(--accent); font: 13px var(--mono); }
.form-grid { display: grid; gap: 16px; max-width: 620px; }
label { display: grid; gap: 8px; color: var(--muted); font-weight: 750; }
input { width: 100%; border: 1px solid var(--border2); border-radius: 8px; background: #050c15; color: var(--text); padding: 13px 14px; outline: none; }
input:focus { border-color: var(--blue); }
.balance-box { border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: #050c15; }
.balance-box span { color: var(--muted); display: block; font-size: 12px; }
.balance-box strong { display: block; margin-top: 4px; font-family: var(--mono); }
.primary { width: fit-content; border: 0; border-radius: 8px; background: linear-gradient(135deg, var(--blue), var(--green)); color: #001018; font-weight: 900; padding: 12px 18px; cursor: pointer; }
.primary:disabled { opacity: .55; cursor: not-allowed; }
.steps { display: grid; gap: 10px; }
.step { display: grid; grid-template-columns: 34px 1fr; align-items: center; gap: 10px; }
.step span { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%; border: 2px solid var(--border2); color: var(--muted); font: 700 10px var(--mono); }
.step.active span { border-color: var(--blue); color: var(--blue); }
.step.done span { border-color: var(--green); color: var(--green); }
.step.error span { border-color: var(--red); color: var(--red); }
.step b { color: #fff; }
.data-box, .result, .empty, .setup-list, .activity-list { margin-top: 16px; }
.data-box { border: 1px solid var(--border); border-radius: 8px; padding: 12px; display: grid; gap: 8px; background: #050c15; }
.row { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 13px; }
.row b { color: var(--text); font: 12px var(--mono); overflow-wrap: anywhere; text-align: right; }
.result { border-radius: 8px; padding: 14px; display: grid; gap: 8px; }
.result.success { border: 1px solid rgba(0,255,157,.35); background: rgba(0,255,157,.07); }
.result.error { border: 1px solid rgba(255,93,93,.4); background: rgba(255,93,93,.08); }
.result p { margin: 0; color: var(--muted); font: 12px var(--mono); overflow-wrap: anywhere; }
.result a { color: var(--blue); font-family: var(--mono); }
.result button { width: fit-content; border: 1px solid var(--border2); border-radius: 8px; color: var(--text); background: var(--surface2); padding: 8px 12px; cursor: pointer; }
.empty { border: 1px dashed var(--border2); border-radius: 8px; padding: 22px; color: var(--muted); text-align: center; }
.activity-list { display: grid; gap: 10px; }
.activity-list a { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; border: 1px solid var(--border); border-radius: 8px; padding: 13px; color: var(--text); text-decoration: none; background: var(--surface2); }
.activity-list b, .activity-list small { font-family: var(--mono); color: var(--blue); }
.setup-list { display: grid; gap: 12px; }
.check { display: grid; grid-template-columns: 34px 1fr; gap: 12px; border: 1px solid var(--border); border-radius: 8px; padding: 13px; background: var(--surface2); }
.check > span { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%; border: 2px solid var(--red); color: var(--red); font: 800 10px var(--mono); }
.check.ok > span { border-color: var(--green); color: var(--green); }
.check strong { color: #fff; }
.check p { margin: 3px 0 0; color: var(--muted); font: 12px var(--mono); overflow-wrap: anywhere; }
.particle { position: fixed; top: -10px; width: 7px; height: 12px; z-index: 20; pointer-events: none; animation: fall linear forwards; }
@keyframes fall { to { transform: translateY(106vh) translateX(var(--drift)) rotate(720deg); opacity: 0; } }
@media (max-width: 1020px) {
  .topbar, .hero, .workspace { grid-template-columns: 1fr; }
  nav { justify-content: flex-start; }
  .card-grid { grid-template-columns: 1fr; }
}
`;
