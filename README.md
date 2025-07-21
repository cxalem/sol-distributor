# Solana SOL Merkle Distributor

A gas-efficient SOL airdrop program that uses Merkle trees to distribute native SOL tokens on the Solana blockchain. This program allows you to airdrop SOL to thousands of recipients while storing only a 32-byte Merkle root on-chain.

## 🚀 Program Details

- **Program ID**: `77DUYUGYFjCWq8JvnNJkwGTpzVvRskiRzA3KqtTAGv2V`
- **Network**: Solana Devnet
- **Framework**: Anchor v0.31.1
- **Token Type**: Native SOL (no SPL tokens needed)

## 📋 Features

- ✅ **Native SOL Distribution**: Directly distribute SOL to recipient wallets
- ✅ **Merkle Proof Verification**: Efficient verification using keccak256 hashing
- ✅ **Double-Claim Prevention**: Receipt system prevents users from claiming twice
- ✅ **Gas Efficient**: Only stores a 32-byte Merkle root on-chain
- ✅ **Scalable**: Supports airdrops to thousands of recipients

## 🛠 Prerequisites

- Node.js 16+ 
- Yarn or npm
- Anchor CLI v0.31.1
- Solana CLI v2.2.20+
- Solana wallet with devnet SOL

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/cxalem/sol-distributor.git
cd solana-distributor

# Install dependencies
yarn install

# Build the program (if needed)
anchor build
```

## 🔧 Setup

### 1. Configure Solana CLI for Devnet

```bash
solana config set --url https://api.devnet.solana.com
solana config set --keypair <your-keypair.json>
```

### 2. Get Devnet SOL

```bash
solana airdrop 2
```

## 📖 How to Use

### Creating a SOL Airdrop

#### Step 1: Prepare Your Airdrop Data

Create a list of recipients and their SOL amounts (in lamports):

```javascript
const recipients = [
  {
    address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    amount: 100000000 // 0.1 SOL in lamports
  },
  {
    address: "4fYNw3dojWmQ4dXtSGE9epjRGy9QRqE5TkSgbGzZXR7Y", 
    amount: 200000000 // 0.2 SOL in lamports
  }
];
```

#### Step 2: Generate Merkle Tree

```javascript
import { keccak_256 } from "js-sha3";
import { PublicKey } from "@solana/web3.js";

class MerkleTree {
  constructor(recipients) {
    // Create leaves from recipient data
    this.leaves = recipients.map(r => this.createLeaf(r.address, r.amount));
    
    // Build the tree
    this.tree = [this.leaves];
    let currentLevel = this.leaves;
    
    while (currentLevel.length > 1) {
      const nextLevel = [];
      
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
        const parent = this.hashPair(left, right);
        nextLevel.push(parent);
      }
      
      this.tree.push(nextLevel);
      currentLevel = nextLevel;
    }
    
    this.root = currentLevel[0];
  }

  createLeaf(address, amount) {
    const data = Buffer.concat([
      new PublicKey(address).toBuffer(),
      Buffer.from(new Uint8Array(new BigUint64Array([BigInt(amount)]).buffer)),
      Buffer.from([0]) // isClaimed = false
    ]);
    return new Uint8Array(keccak_256.arrayBuffer(data));
  }

  hashPair(left, right) {
    const data = Buffer.concat([Buffer.from(left), Buffer.from(right)]);
    return new Uint8Array(keccak_256.arrayBuffer(data));
  }

  getProof(leafIndex) {
    const proof = [];
    let index = leafIndex;
    
    for (let level = 0; level < this.tree.length - 1; level++) {
      const currentLevel = this.tree[level];
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      
      if (siblingIndex < currentLevel.length) {
        proof.push(currentLevel[siblingIndex]);
      }
      
      index = Math.floor(index / 2);
    }
    
    return proof;
  }
}

// Generate the tree
const merkleTree = new MerkleTree(recipients);
console.log("Merkle Root:", Buffer.from(merkleTree.root).toString('hex'));
```

#### Step 3: Initialize Airdrop

```javascript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

// Set up provider and program
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = new Program(idl, "77DUYUGYFjCWq8JvnNJkwGTpzVvRskiRzA3KqtTAGv2V", provider);

// Calculate total amount
const totalAmount = recipients.reduce((sum, r) => sum + r.amount, 0);

// Derive airdrop state PDA
const [airdropState] = PublicKey.findProgramAddressSync(
  [Buffer.from("merkle_tree")],
  program.programId
);

// Initialize the airdrop
const tx = await program.methods
  .initializeAirdrop(Array.from(merkleTree.root), new anchor.BN(totalAmount))
  .accounts({
    airdrop_state: airdropState,
    authority: provider.wallet.publicKey,
    system_program: SystemProgram.programId,
  })
  .rpc();

console.log("Airdrop initialized:", tx);
console.log("Airdrop State PDA:", airdropState.toString());
```

### Claiming SOL from Airdrop

#### Step 1: Generate Your Proof

```javascript
// Find your index in the recipients list
const yourAddress = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const recipientIndex = recipients.findIndex(r => r.address === yourAddress);

if (recipientIndex === -1) {
  throw new Error("Address not found in airdrop");
}

// Generate proof for your claim
const proof = merkleTree.getProof(recipientIndex);
const amount = recipients[recipientIndex].amount;

console.log("Your proof:", proof.map(p => Buffer.from(p).toString('hex')));
console.log("Amount to claim:", amount / LAMPORTS_PER_SOL, "SOL");
```

#### Step 2: Submit Claim Transaction

```javascript
// Derive your claim status PDA
const [claimStatus] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("claim"),
    airdropState.toBuffer(),
    provider.wallet.publicKey.toBuffer()
  ],
  program.programId
);

// Submit claim
const claimTx = await program.methods
  .claimAirdrop(
    new anchor.BN(amount),
    proof.map(p => Array.from(p)),
    new anchor.BN(recipientIndex)
  )
  .accounts({
    airdrop_state: airdropState,
    user_claim: claimStatus,
    signer: provider.wallet.publicKey,
    system_program: SystemProgram.programId,
  })
  .rpc();

console.log("Claim successful:", claimTx);
```

## 🧪 Testing

Run the test suite to verify functionality:

```bash
# Set environment variables
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=~/.config/solana/id.json

# Run tests
anchor test --skip-local-validator
```

Or run tests manually:

```bash
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts
```

## 📋 Program Instructions

### `initialize_airdrop`

Initializes a new SOL airdrop with a Merkle root.

**Parameters:**
- `merkle_root: [u8; 32]` - The 32-byte Merkle root
- `amount: u64` - Total SOL amount to distribute (in lamports)

**Accounts:**
- `airdrop_state` - PDA to store airdrop data
- `authority` - Signer who funds the airdrop
- `system_program` - Solana System Program

### `claim_airdrop`

Claims SOL from an airdrop using Merkle proof.

**Parameters:**
- `amount: u64` - Amount to claim (in lamports)
- `proof: Vec<[u8; 32]>` - Array of Merkle proof hashes
- `leaf_index: u64` - Index of the leaf in the Merkle tree

**Accounts:**
- `airdrop_state` - The airdrop state PDA
- `user_claim` - User's claim receipt PDA (created on claim)
- `signer` - User claiming the SOL
- `system_program` - Solana System Program

## 🔍 Account Structure

### `AirdropState`

```rust
pub struct AirdropState {
    pub merkle_root: [u8; 32],        // Merkle root of recipients
    pub authority: Pubkey,            // Airdrop creator
    pub airdrop_amount: u64,          // Total SOL allocated (lamports)
    pub amount_claimed: u64,          // Total SOL claimed (lamports)
    pub bump: u8,                     // PDA bump seed
}
```

### `ClaimStatus`

```rust
pub struct ClaimStatus {} // Empty struct used as receipt flag
```

## 🔐 PDA Seeds

- **Airdrop State**: `["merkle_tree"]`
- **Claim Status**: `["claim", airdrop_state_key, user_key]`

## ⚠️ Important Notes

1. **One Airdrop Per Program**: Currently supports one active airdrop at a time
2. **Irreversible Claims**: Once claimed, SOL cannot be returned to the vault
3. **Authority Responsibility**: The authority must fund the airdrop during initialization
4. **Proof Validation**: Invalid proofs will cause transactions to fail
5. **Devnet Only**: This deployment is for testing on devnet only

## 🔐 Security Best Practices

**⚠️ NEVER commit private keys to Git!**

- All keypair files (`.json` files containing private keys) are gitignored
- Use environment variables for wallet paths in production
- The `program-keypair.json` contains the program's upgrade authority - keep it secure
- For mainnet deployments, use hardware wallets or secure key management systems

**Recommended setup:**
```bash
# Store your keypair in the default Solana location
solana-keygen new --outfile ~/.config/solana/id.json

# Or use environment variables
export ANCHOR_WALLET=/path/to/your/secure/keypair.json
```

## 🐛 Common Issues

### "Invalid Merkle proof" Error
- Ensure your proof was generated correctly for your leaf index
- Verify the leaf data matches exactly (address + amount + isClaimed=0)
- Check that you're using the correct recipient index

### "Account already in use" Error
- You've already claimed from this airdrop
- Each user can only claim once per airdrop

### Insufficient Funds Error
- Ensure you have enough SOL for transaction fees
- The airdrop vault needs to have sufficient SOL for claims

## 📚 Additional Resources

- [Solana Documentation](https://docs.solana.com/)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Merkle Trees Explained](https://en.wikipedia.org/wiki/Merkle_tree)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License.

---

**⚡ Ready to airdrop SOL efficiently on Solana!** 