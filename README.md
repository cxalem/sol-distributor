# Solana Merkle Distributor

A complete Solana program for efficient token airdrops using Merkle trees. Distribute SOL to thousands of recipients while storing only a 32-byte Merkle root on-chain.

## 🎯 What This Project Does

This is a **merkle tree-based airdrop system** that allows you to:

1. **Create** a list of recipients and amounts
2. **Generate** a merkle tree representing all recipients  
3. **Deploy** a Solana program that stores only the merkle root
4. **Initialize** the airdrop with funded SOL
5. **Allow recipients** to claim their SOL using cryptographic proofs

**Why Merkle Trees?** Instead of storing thousands of recipient addresses on-chain (expensive), we store just one 32-byte hash that represents the entire list. Recipients prove they're eligible using merkle proofs.

## 🏗️ How It Works

```ascii
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Recipients    │    │   Merkle Tree    │    │  Solana Program │
│     List        │───▶│   Generation     │───▶│   (Root Only)   │
│ • Alice: 0.1 SOL│    │                  │    │                 │
│ • Bob: 0.2 SOL  │    │ Root: 0x1a2b3c...│    │ Root: 0x1a2b3c..│
│ • Carol: 0.1 SOL│    │                  │    │ SOL: 0.4 Total  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                        │
┌─────────────────┐    ┌──────────────────┐             │
│   Alice Claims  │    │  Generate Proof  │             │
│                 │◀───│  for Alice       │◀────────────┘
│ ✓ Proof Valid   │    │                  │
│ ✓ Receives SOL  │    │ Proof: [0x4d,    │
│                 │    │        0x9f, ...]│
└─────────────────┘    └──────────────────┘
```

## 📋 Prerequisites

Before starting, install:

- **Rust 1.88.0+** - `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Solana CLI 2.2.20+** - `sh -c "$(curl -sSfL https://release.solana.com/stable/install)"`
- **Anchor CLI 0.31.1** - `cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.31.1`
- **Node.js 16+** with npm

Verify installations:
```bash
rustc --version    # Should be 1.88.0+
solana --version   # Should be 2.2.20+
anchor --version   # Should be 0.31.1
node --version     # Should be 16+
```

## 🚀 Step-by-Step Setup

### Step 1: Clone and Install

```bash
# Clone the repository
git clone <your-repo-url>
cd solana-distributor

# Install dependencies
npm install

# Install additional dependencies
npm install --save-dev @types/node
npm install bs58
```

### Step 2: Configure Solana Environment

```bash
# Set network to devnet
solana config set --url https://api.devnet.solana.com
solana config set --commitment confirmed

# Create or use existing wallet
solana-keygen new --outfile deploy-wallet.json --no-bip39-passphrase

# Fund with devnet SOL (need ~2 SOL for deployment)
solana airdrop 2 $(solana address -k deploy-wallet.json)

# Check balance
solana balance
```

### Step 3: Create Your Recipients List

Edit `recipients.json` with your airdrop recipients:

```json
{
  "airdropId": "my-awesome-airdrop-2024",
  "description": "Community airdrop for early supporters",
  "merkleRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "totalAmount": "1000000000",
  "network": "devnet",
  "programId": "WILL_BE_UPDATED_AFTER_DEPLOYMENT",
  "recipients": [
    {
      "publicKey": "HcCcKydEcuGMbBso7jciQrFpBw1XQrKHKFckGSAxXXQG",
      "amount": "250000000",
      "index": 0,
      "description": "Early supporter #1"
    },
    {
      "publicKey": "H3LgCdztZyfE5zch3YAVXYj5D7bf19fR4QTbPtCho6Lu",
      "amount": "250000000", 
      "index": 1,
      "description": "Early supporter #2"
    },
    {
      "publicKey": "8aRyik34YsWL2gz2AYnBHoaxju52b3DHvFyMTCpddh4i",
      "amount": "250000000",
      "index": 2, 
      "description": "Early supporter #3"
    },
    {
      "publicKey": "YOUR_RECIPIENT_PUBLIC_KEY_HERE",
      "amount": "250000000",
      "index": 3,
      "description": "Early supporter #4"
    }
  ],
  "metadata": {
    "createdAt": "2024-01-01T00:00:00Z",
    "version": "1.0.0",
    "algorithm": "keccak256",
    "leafFormat": "recipient_pubkey(32) + amount(8) + is_claimed(1)"
  }
}
```

**Important:** 
- Replace public keys with real Solana addresses
- Amounts are in **lamports** (1 SOL = 1,000,000,000 lamports)
- `totalAmount` must equal sum of all recipient amounts
- Keep `index` values sequential starting from 0

### Step 4: Generate Merkle Tree

```bash
# Generate the merkle tree and update recipients.json
npx ts-node scripts/generate-merkle-tree.ts
```

**What happens:**
- Reads your recipients list
- Creates merkle tree leaves: `hash(publicKey + amount + isClaimedFlag)`
- Builds complete binary tree using keccak256
- Updates `recipients.json` with computed merkle root

**Output:**
```
🌳 Generating Merkle tree...
📋 Loaded 4 recipients
💰 Total amount: 1 SOL
✅ Merkle tree generated!
   Leaves: 4
   Root: 0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890
✅ Updated recipients.json with merkle root
```

### Step 5: Deploy the Program

```bash
# Generate new program keypair
solana-keygen new --outfile program-keypair.json --no-bip39-passphrase

# Get program ID
PROGRAM_ID=$(solana address -k program-keypair.json)
echo "Program ID: $PROGRAM_ID"

# Update program ID in code
sed -i '' "s/declare_id!(\".*\")/declare_id!(\"$PROGRAM_ID\")/" programs/solana-distributor/src/lib.rs

# Update Anchor.toml  
sed -i '' "s/solana_distributor = \".*\"/solana_distributor = \"$PROGRAM_ID\"/" Anchor.toml

# Update recipients.json
sed -i '' "s/\"programId\": \".*\"/\"programId\": \"$PROGRAM_ID\"/" recipients.json

# Copy program keypair to expected location
cp program-keypair.json target/deploy/solana_distributor-keypair.json

# Update Anchor.toml with your wallet
sed -i '' 's|wallet = ".*"|wallet = "deploy-wallet.json"|' Anchor.toml

# Build and deploy
anchor build
anchor deploy
```

**Expected output:**
```
Deploying cluster: https://api.devnet.solana.com
Upgrade authority: deploy-wallet.json
Deploying program "solana_distributor"...
Program Id: YOUR_PROGRAM_ID

Deploy success
```

### Step 6: Initialize the Airdrop

```bash
# Initialize the airdrop with your merkle root
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=deploy-wallet.json \
npx ts-node scripts/initialize-airdrop.ts
```

**What happens:**
- Creates airdrop state account (PDA) with your merkle root
- Transfers your SOL to fund the airdrop (from `totalAmount`)
- Makes the airdrop live and ready for claims

**Output:**
```
🚀 Initializing airdrop...
📋 Loaded 4 recipients  
💰 Total amount: 1 SOL
🌳 Merkle root: 0x1a2b3c4d...
📍 Program ID: YOUR_PROGRAM_ID
👤 Authority: YOUR_WALLET_ADDRESS
✅ Airdrop initialized successfully!
📋 Transaction signature: TRANSACTION_ID
🔍 View on explorer: https://explorer.solana.com/tx/TRANSACTION_ID?cluster=devnet
```

### Step 7: Generate Proofs for Claims

```bash
# Generate proof for a specific recipient
npx ts-node scripts/generate-proof.ts HcCcKydEcuGMbBso7jciQrFpBw1XQrKHKFckGSAxXXQG

# Or generate proofs for ALL recipients
npx ts-node scripts/generate-proof.ts --all
```

**What happens:**
- Finds the recipient in your merkle tree
- Generates the "sibling path" from leaf to root
- Provides proof that can be verified on-chain

**Output:**
```
🔍 Generating proof for HcCcKydEcuGMbBso7jciQrFpBw1XQrKHKFckGSAxXXQG...
✅ Proof generated for Early supporter #1:
   Leaf Index: 0
   Amount: 250000000 lamports (0.25 SOL)
   Proof Length: 2 hashes
   Proof: [[132, 111, 172, ...], [207, 11, 238, ...]]
```

### Step 8: Claim the Airdrop

Recipients can now claim their SOL using their private keys:

```bash
# Claim using recipient's secret key
npx ts-node scripts/claim-airdrop.ts \
  HcCcKydEcuGMbBso7jciQrFpBw1XQrKHKFckGSAxXXQG \
  CmRj15BFFh1ECMtYgwzQyYN1AncZvqQRyNHmMD5JqujNMEPaDnJEG5AQvUcDgLjPwbs7dAVLbQ2pPzk3bsWuboS
```

**What happens:**
- Loads recipient data and generates proof
- Creates transaction signed by recipient
- Program verifies merkle proof on-chain
- Transfers SOL to recipient if proof is valid
- Creates "claim receipt" to prevent double-claiming

**Output:**
```
🎯 Claiming airdrop for HcCcKydEcuGMbBso7jciQrFpBw1XQrKHKFckGSAxXXQG...
💰 Claiming 0.25 SOL
📊 Leaf Index: 0
🔍 Proof Length: 2 hashes
✅ Recipient hasn't claimed yet, proceeding...
📤 Sending claim transaction...
✅ Airdrop claimed successfully!
📋 Transaction signature: CLAIM_TX_ID
🔍 View on explorer: https://explorer.solana.com/tx/CLAIM_TX_ID?cluster=devnet
🎉 Claim completed successfully!
```

## 🔧 Available Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `generate-merkle-tree.ts` | Create merkle tree from recipients | `npx ts-node scripts/generate-merkle-tree.ts` |
| `generate-proof.ts` | Generate proofs for claims | `npx ts-node scripts/generate-proof.ts <pubkey>` |
| `initialize-airdrop.ts` | Initialize on-chain airdrop | `ANCHOR_PROVIDER_URL=... npx ts-node scripts/initialize-airdrop.ts` |
| `claim-airdrop.ts` | Claim tokens with proof | `npx ts-node scripts/claim-airdrop.ts <pubkey> <secret>` |
| `extract-private-keys.ts` | Extract keys from test wallets | `npx ts-node scripts/extract-private-keys.ts` |

## 🧪 Testing with Included Test Wallets

The project includes pre-funded test wallets for testing:

```bash
# Extract test wallet keys (includes 64-byte secret keys)
npx ts-node scripts/extract-private-keys.ts

# Test claiming with test wallet 1
npx ts-node scripts/claim-airdrop.ts \
  HcCcKydEcuGMbBso7jciQrFpBw1XQrKHKFckGSAxXXQG \
  CmRj15BFFh1ECMtYgwzQyYN1AncZvqQRyNHmMD5JqujNMEPaDnJEG5AQvUcDgLjPwbs7dAVLbQ2pPzk3bsWuboS
```

## 🔍 How Merkle Proofs Work

```
Merkle Tree Example (4 recipients):

                    ROOT
                 /        \
            H(AB)              H(CD)  
           /    \             /    \
       H(A)    H(B)       H(C)    H(D)
        |       |          |       |
    Alice    Bob      Carol    Dave

To prove Alice is in the tree:
1. Provide H(B), H(CD) as proof
2. Program computes: H(H(A) + H(B)) + H(CD) = ROOT  
3. If computed ROOT matches stored ROOT → Alice is valid ✅
```

**Benefits:**
- **Efficient**: Proof size is O(log n), not O(n)
- **Secure**: Cryptographically impossible to fake
- **Scalable**: Works for millions of recipients

## 📊 Current Deployment Status

This repository includes a working example:

- **Program ID**: `ErbDoJTnJyG6EBXHeFochTsHJhB3Jfjc3MF1L9aNip3y`
- **Network**: Devnet  
- **Recipients**: 4 test wallets (0.075 SOL each)
- **Status**: ✅ Deployed and initialized

## 🚨 Production Deployment

For mainnet deployment:

```bash
# 1. Switch to mainnet
solana config set --url https://api.mainnet-beta.solana.com

# 2. Update Anchor.toml
[provider]
cluster = "mainnet"

# 3. Fund wallet with REAL SOL
solana airdrop 2  # Won't work on mainnet - use real SOL

# 4. Update recipients.json
"network": "mainnet"

# 5. Deploy (same steps as above)
anchor deploy
```

**⚠️ Security Checklist:**
- [ ] Verify all recipient addresses are correct
- [ ] Double-check all amounts (in lamports)
- [ ] Test completely on devnet first
- [ ] Secure your program upgrade authority
- [ ] Consider making program immutable after deployment

## 🐛 Troubleshooting

### Common Issues

**"Key pair bytes must be of length 64, got 32"**
```bash
# Use 64-byte secret key, not 32-byte private key
npx ts-node scripts/extract-private-keys.ts  # Shows both formats
```

**"Invalid Merkle proof"**
```bash
# Regenerate merkle tree if recipients changed
npx ts-node scripts/generate-merkle-tree.ts
```

**"Airdrop already initialized"**
- Use different program ID, or 
- Update existing airdrop (if you control authority)

**"Account not found"**
```bash
# Make sure program is deployed
anchor deploy

# Check you're on correct network
solana config get
```

**"Dynamic program error: No default signer found"**
```bash
# Create the deploy wallet file specified in Anchor.toml
solana-keygen new -o deploy-wallet.json

# Fund the deploy wallet with devnet SOL for deployment fees
solana airdrop 2 $(solana address -k deploy-wallet.json) --url devnet

# Verify wallet is funded
solana balance -k deploy-wallet.json --url devnet

# Now you can deploy
anchor deploy
```
*This error occurs when the wallet file specified in `Anchor.toml` doesn't exist. The `deploy-wallet.json` file is needed to sign deployment transactions.*

## 📁 Project Structure

```
solana-distributor/
├── programs/solana-distributor/    # Rust program
│   └── src/lib.rs                 # Program logic
├── scripts/                       # TypeScript utilities  
│   ├── generate-merkle-tree.ts   # Generate tree
│   ├── generate-proof.ts         # Generate proofs
│   ├── initialize-airdrop.ts     # Initialize airdrop
│   ├── claim-airdrop.ts          # Claim tokens
│   ├── extract-private-keys.ts   # Extract wallet keys
│   └── load-recipients.ts        # Load recipients
├── tests/                        # Anchor tests
├── recipients.json               # Your recipients + merkle root
└── test-wallets.json            # Test wallets with keys
```

## 🎓 Learning Resources

- **[Scripts Documentation](scripts/README.md)**: Detailed documentation for all utility scripts
- **[Anchor Documentation](https://www.anchor-lang.com/)**: Solana development framework
- **[Solana Cookbook](https://solanacookbook.com/)**: Solana development patterns
- **[Solana Web3.js Guide](https://docs.solana.com/developing/clients/javascript-reference)**: Client-side development

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Test on devnet thoroughly
4. Submit pull request

## 📄 License

[Add your license here]

---

Need help? Check the [troubleshooting section](#-troubleshooting) or open an issue! 