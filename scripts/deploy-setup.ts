#!/usr/bin/env ts-node

import * as fs from "fs";
import * as path from "path";
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { execSync } from "child_process";
import * as readline from "readline";
import { keccak_256 } from "js-sha3";

interface WalletInfo {
  name: string;
  publicKey: string;
  keypairFile: string;
  privateKey: {
    hex: string;
    base58: string;
    array: number[];
  };
  secretKey: {
    hex: string;
    base58: string;
    array: number[];
  };
  balance?: string;
  funded?: boolean;
  seedPhrase?: string;
  isDeployWallet?: boolean;
}

interface Recipient {
  recipient: PublicKey;
  amount: number;
}

class SimpleMerkleTree {
  public root: Uint8Array;
  private leaves: Uint8Array[];
  private tree: Uint8Array[][];

  constructor(recipients: Recipient[]) {
    // Create leaves
    this.leaves = recipients.map((r) => this.createLeaf(r.recipient, r.amount));

    // Build tree
    this.tree = [this.leaves];
    let currentLevel = this.leaves;

    while (currentLevel.length > 1) {
      const nextLevel: Uint8Array[] = [];

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

  private createLeaf(recipient: PublicKey, amount: number): Uint8Array {
    const data = Buffer.concat([
      recipient.toBuffer(),
      Buffer.from(new Uint8Array(new BigUint64Array([BigInt(amount)]).buffer)),
      Buffer.from([0]), // isClaimed = false
    ]);
    return new Uint8Array(keccak_256.arrayBuffer(data));
  }

  private hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
    const data = Buffer.concat([Buffer.from(left), Buffer.from(right)]);
    return new Uint8Array(keccak_256.arrayBuffer(data));
  }

  public getProof(leafIndex: number): Uint8Array[] {
    const proof: Uint8Array[] = [];
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

  public getRootHex(): string {
    return "0x" + Buffer.from(this.root).toString("hex");
  }

  public getLeafCount(): number {
    return this.leaves.length;
  }
}

interface TestWalletsData {
  network: string;
  description: string;
  createdAt: string;
  wallets: WalletInfo[];
  usage: {
    description: string;
    loadWallet: string;
    checkBalance: string;
    fundWallet: string;
    transferFunds: string;
    privateKeyFormats: {
      hex: string;
      base58: string;
      array: string;
    };
    security: {
      warning: string;
      note: string;
    };
  };
}

class SolanaDeploymentSetup {
  private connection: Connection;
  private rl: readline.Interface;
  private wallets: WalletInfo[] = [];

  constructor() {
    this.connection = new Connection("https://api.devnet.solana.com", "confirmed");
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  private question(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private generateWallet(name: string): WalletInfo {
    const keypair = Keypair.generate();
    const secretKey = keypair.secretKey;
    const privateKey = secretKey.slice(0, 32);

    return {
      name,
      publicKey: keypair.publicKey.toString(),
      keypairFile: `${name}.json`,
      privateKey: {
        hex: Buffer.from(privateKey).toString("hex"),
        base58: bs58.encode(privateKey),
        array: Array.from(privateKey),
      },
      secretKey: {
        hex: Buffer.from(secretKey).toString("hex"),
        base58: bs58.encode(secretKey),
        array: Array.from(secretKey),
      },
      balance: "0 SOL",
      funded: false,
    };
  }

  private saveWalletFile(wallet: WalletInfo): void {
    // Only save deploy wallet file (others are stored in test-wallets.json)
    if (wallet.isDeployWallet) {
      const walletPath = wallet.keypairFile;
      fs.writeFileSync(walletPath, JSON.stringify(wallet.secretKey.array));
      console.log(`💾 Saved wallet file: ${walletPath}`);
    }
  }

  private async checkBalance(publicKey: string): Promise<number> {
    try {
      const balance = await this.connection.getBalance(new PublicKey(publicKey));
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error(`❌ Error checking balance for ${publicKey}:`, error);
      return 0;
    }
  }

  private async requestAirdrop(publicKey: string, amount: number = 2): Promise<boolean> {
    try {
      console.log(`💧 Requesting ${amount} SOL airdrop for ${publicKey}...`);
      const signature = await this.connection.requestAirdrop(
        new PublicKey(publicKey),
        amount * LAMPORTS_PER_SOL
      );
      
      // Wait for confirmation
      await this.connection.confirmTransaction(signature);
      console.log(`✅ Airdrop successful! Signature: ${signature}`);
      
      // Wait a bit for balance to update
      await this.delay(2000);
      
      return true;
    } catch (error) {
      console.error(`❌ Airdrop failed for ${publicKey}:`, error);
      return false;
    }
  }

  private loadExistingWallets(): { deployWallet: WalletInfo | null; testWallets: WalletInfo[] } {
    try {
      if (!fs.existsSync("test-wallets.json")) {
        return { deployWallet: null, testWallets: [] };
      }

      const testWalletsData = JSON.parse(fs.readFileSync("test-wallets.json", "utf8"));
      const wallets = testWalletsData.wallets || [];
      
      const deployWallet = wallets.find((w: any) => w.isDeployWallet || w.name === "deploy-wallet");
      const testWallets = wallets.filter((w: any) => !w.isDeployWallet && w.name !== "deploy-wallet");

      return { deployWallet, testWallets };
    } catch (error) {
      console.error("⚠️  Error loading existing wallets:", error);
      return { deployWallet: null, testWallets: [] };
    }
  }

  private createDeployWalletFile(wallet: WalletInfo): void {
    // Only create individual file for deploy wallet (needed by Anchor)
    if (wallet.isDeployWallet && !fs.existsSync(wallet.keypairFile)) {
      fs.writeFileSync(wallet.keypairFile, JSON.stringify(wallet.secretKey.array));
      console.log(`💾 Created deploy wallet file: ${wallet.keypairFile}`);
    }
  }

  private async setupDeployWallet(): Promise<WalletInfo> {
    console.log("\n🚀 Setting up deployment wallet...\n");
    
    // Check for existing wallets first
    const { deployWallet: existingDeployWallet } = this.loadExistingWallets();
    
    if (existingDeployWallet) {
      const useExisting = await this.question(
        `Found existing deploy wallet: ${existingDeployWallet.publicKey}\n` +
        "Do you want to use this existing wallet? (y/n): "
      );
      
      if (useExisting.toLowerCase() === 'y' || useExisting.toLowerCase() === 'yes') {
        console.log(`✅ Using existing deployment wallet: ${existingDeployWallet.publicKey}`);
        
        // Create deploy wallet file if it doesn't exist (needed by Anchor)
        this.createDeployWalletFile(existingDeployWallet);
        
        // Check balance
        const balance = await this.checkBalance(existingDeployWallet.publicKey);
        existingDeployWallet.balance = `${balance} SOL`;
        
        console.log(`💰 Current balance: ${balance} SOL`);
        
        if (balance < 1) {
          console.log("💧 Requesting devnet SOL...");
          const airdropSuccess = await this.requestAirdrop(existingDeployWallet.publicKey, 2);
          if (airdropSuccess) {
            const newBalance = await this.checkBalance(existingDeployWallet.publicKey);
            existingDeployWallet.balance = `${newBalance} SOL`;
            existingDeployWallet.funded = true;
            console.log(`✅ Wallet funded! New balance: ${newBalance} SOL`);
          } else {
            console.log("⚠️  Automatic airdrop failed. Please fund your wallet manually:");
            console.log(`solana airdrop 2 ${existingDeployWallet.publicKey} --url devnet`);
          }
        } else {
          existingDeployWallet.funded = true;
        }
        
        return existingDeployWallet;
      }
    }
    
    const choice = await this.question(
      "Do you want to:\n" +
      "1. Use an existing wallet (provide private key)\n" +
      "2. Create a new wallet\n" +
      "Enter choice (1 or 2): "
    );

    let deployWallet: WalletInfo;

    if (choice === "1") {
      const privateKeyInput = await this.question("Enter your private key (base58 or hex): ");
      
      try {
        let secretKeyArray: number[];
        
        if (privateKeyInput.length === 128) {
          // Hex format (64 bytes)
          const secretKeyBuffer = Buffer.from(privateKeyInput, "hex");
          secretKeyArray = Array.from(secretKeyBuffer);
        } else if (privateKeyInput.length === 88) {
          // Base58 format (64 bytes)
          const secretKeyBuffer = bs58.decode(privateKeyInput);
          secretKeyArray = Array.from(secretKeyBuffer);
        } else {
          throw new Error("Invalid private key format");
        }

        const keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyArray));
        const privateKey = secretKeyArray.slice(0, 32);

        deployWallet = {
          name: "deploy-wallet",
          publicKey: keypair.publicKey.toString(),
          keypairFile: "deploy-wallet.json",
          privateKey: {
            hex: Buffer.from(privateKey).toString("hex"),
            base58: bs58.encode(new Uint8Array(privateKey)),
            array: privateKey,
          },
          secretKey: {
            hex: privateKeyInput.length === 128 ? privateKeyInput : Buffer.from(secretKeyArray).toString("hex"),
            base58: privateKeyInput.length === 88 ? privateKeyInput : bs58.encode(new Uint8Array(secretKeyArray)),
            array: secretKeyArray,
          },
          isDeployWallet: true,
        };

        console.log(`✅ Using existing wallet: ${deployWallet.publicKey}`);
      } catch (error) {
        console.error("❌ Invalid private key format. Please try again.");
        process.exit(1);
      }
    } else {
      deployWallet = this.generateWallet("deploy-wallet");
      deployWallet.isDeployWallet = true;
      console.log(`✅ Generated new deployment wallet: ${deployWallet.publicKey}`);
    }

    // Save deploy wallet file (needed by Anchor)
    this.createDeployWalletFile(deployWallet);

    // Check balance
    const balance = await this.checkBalance(deployWallet.publicKey);
    deployWallet.balance = `${balance} SOL`;
    
    console.log(`💰 Current balance: ${balance} SOL`);

    if (balance < 1) {
      console.log("💧 Requesting devnet SOL...");
      const airdropSuccess = await this.requestAirdrop(deployWallet.publicKey, 2);
      if (airdropSuccess) {
        const newBalance = await this.checkBalance(deployWallet.publicKey);
        deployWallet.balance = `${newBalance} SOL`;
        deployWallet.funded = true;
        console.log(`✅ Wallet funded! New balance: ${newBalance} SOL`);
      } else {
        console.log("⚠️  Automatic airdrop failed. Please fund your wallet manually:");
        console.log(`solana airdrop 2 ${deployWallet.publicKey} --url devnet`);
      }
    } else {
      deployWallet.funded = true;
    }

    return deployWallet;
  }

  private async setupTestWallets(): Promise<WalletInfo[]> {
    console.log("\n🧪 Setting up test wallets...\n");
    
    // Check for existing test wallets first
    const { testWallets: existingTestWallets } = this.loadExistingWallets();
    
    if (existingTestWallets.length > 0) {
      console.log(`Found ${existingTestWallets.length} existing test wallets:`);
      existingTestWallets.forEach((wallet, i) => {
        console.log(`  ${i + 1}. ${wallet.name}: ${wallet.publicKey} (${wallet.funded ? 'Funded' : 'Unfunded'})`);
      });
      
      const useExisting = await this.question(
        "\nDo you want to use these existing test wallets? (y/n): "
      );
      
      if (useExisting.toLowerCase() === 'y' || useExisting.toLowerCase() === 'yes') {
        console.log("✅ Using existing test wallets (no individual files needed - all data in test-wallets.json)");
        
        // Check balances for existing wallets
        for (const wallet of existingTestWallets) {
          const balance = await this.checkBalance(wallet.publicKey);
          wallet.balance = `${balance} SOL`;
          console.log(`💰 ${wallet.name}: ${balance} SOL`);
          
          if (balance > 0) {
            wallet.funded = true;
          } else {
            wallet.funded = false;
            console.log(`⚠️  ${wallet.name} has no funds. You can fund it manually if needed.`);
          }
        }
        
        return existingTestWallets;
      }
    }
    
    const numWallets = await this.question("How many test wallets do you want to create? (default: 3): ");
    const walletCount = parseInt(numWallets) || 3;

    const testWallets: WalletInfo[] = [];

    for (let i = 1; i <= walletCount; i++) {
      console.log(`\n📱 Creating test wallet ${i}...`);
      
      const wallet = this.generateWallet(`test-wallet-${i}`);
      
      console.log(`✅ Created: ${wallet.publicKey}`);
      
      // Try to fund the wallet
      const fundSuccess = await this.requestAirdrop(wallet.publicKey, 1);
      if (fundSuccess) {
        const balance = await this.checkBalance(wallet.publicKey);
        wallet.balance = `${balance} SOL`;
        wallet.funded = true;
        console.log(`💰 Funded with ${balance} SOL`);
      } else {
        wallet.balance = "0 SOL";
        wallet.funded = false;
        console.log(`⚠️  Failed to fund wallet ${i} (rate limiting)`);
      }

      testWallets.push(wallet);
      
      // Add delay between airdrops to avoid rate limiting
      if (i < walletCount) {
        console.log("⏳ Waiting 3 seconds before next wallet...");
        await this.delay(3000);
      }
    }

    return testWallets;
  }

  private saveTestWalletsJson(allWallets: WalletInfo[]): void {
    const testWalletsData: TestWalletsData = {
      network: "devnet",
      description: "Test wallets for Solana distributor development",
      createdAt: new Date().toISOString(),
      wallets: allWallets,
      usage: {
        description: "These test wallets can be used for development and testing",
        loadWallet: "solana config set --keypair <keypairFile>",
        checkBalance: "solana balance <publicKey>",
        fundWallet: "solana airdrop <amount> <publicKey>",
        transferFunds: "solana transfer <recipient> <amount> --keypair <keypairFile>",
        privateKeyFormats: {
          hex: "32-byte hexadecimal string (lowercase)",
          base58: "Base58 encoded string (most common format for Solana)",
          array: "Array of 32 integers (0-255)",
        },
        security: {
          warning: "⚠️ NEVER share private keys publicly or commit them to public repositories!",
          note: "These are test wallets for devnet only. Do not use for mainnet or real funds.",
        },
      },
    };

    fs.writeFileSync("test-wallets.json", JSON.stringify(testWalletsData, null, 2));
    console.log("💾 Saved test-wallets.json");
  }

  private updateAnchorConfig(deployWallet: WalletInfo): void {
    const anchorToml = `[toolchain]
anchor_version = "0.31.1"
package_manager = "yarn"

[features]
resolution = true
skip-lint = false

[programs.devnet]
solana_distributor = "ErbDoJTnJyG6EBXHeFochTsHJhB3Jfjc3MF1L9aNip3y"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "devnet"
wallet = "${deployWallet.keypairFile}"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
`;

    fs.writeFileSync("Anchor.toml", anchorToml);
    console.log(`✅ Updated Anchor.toml to use ${deployWallet.keypairFile}`);
  }

  private generateRecipientsJson(testWallets: WalletInfo[]): void {
    const recipients = testWallets.map((wallet, index) => ({
      publicKey: wallet.publicKey,
      amount: "75000000", // 0.075 SOL
      index,
      description: `${wallet.name} - ${wallet.funded ? 'Funded' : 'Unfunded'}`,
    }));

    const totalAmount = (recipients.length * 75000000).toString();

    // Check if recipients.json already exists with the same wallets
    let shouldUpdate = true;
    if (fs.existsSync("recipients.json")) {
      try {
        const existingData = JSON.parse(fs.readFileSync("recipients.json", "utf8"));
        const existingPublicKeys = existingData.recipients?.map((r: any) => r.publicKey) || [];
        const newPublicKeys = recipients.map(r => r.publicKey);
        
        // If the wallets are the same, just update descriptions and keep existing merkle root
        if (JSON.stringify(existingPublicKeys.sort()) === JSON.stringify(newPublicKeys.sort())) {
          console.log("📋 Recipients unchanged, updating descriptions only");
          existingData.recipients = recipients;
          existingData.description = "Deployment setup airdrop for testing purposes";
          fs.writeFileSync("recipients.json", JSON.stringify(existingData, null, 2));
          shouldUpdate = false;
        }
      } catch (error) {
        // If there's an error reading existing file, proceed with generating new one
      }
    }

    if (shouldUpdate) {
      const recipientsData = {
        airdropId: "solana-distributor-airdrop-" + new Date().getFullYear(),
        description: "Deployment setup airdrop for testing purposes",
        merkleRoot: "0x0000000000000000000000000000000000000000000000000000000000000000", // Will be updated after tree generation
        totalAmount,
        network: "devnet",
        programId: this.getCurrentProgramId(),
        recipients,
        metadata: {
          createdAt: new Date().toISOString(),
          version: "1.0.0",
          algorithm: "keccak256",
          leafFormat: "recipient_pubkey(32) + amount(8) + is_claimed(1)",
        },
      };

      fs.writeFileSync("recipients.json", JSON.stringify(recipientsData, null, 2));
      console.log("📋 Generated recipients.json");
    }
  }

  private generateMerkleTree(): { merkleRoot: string; merkleTree: SimpleMerkleTree } {
    try {
      console.log("🌳 Generating Merkle tree...");

      // Load recipients data
      const recipientsData = JSON.parse(fs.readFileSync("recipients.json", "utf8"));

      // Convert to format expected by merkle tree
      const recipients: Recipient[] = recipientsData.recipients.map((r: any) => ({
        recipient: new PublicKey(r.publicKey),
        amount: parseInt(r.amount),
      }));

      // Generate merkle tree
      const merkleTree = new SimpleMerkleTree(recipients);
      const merkleRootHex = merkleTree.getRootHex();

      console.log(`✅ Merkle tree generated!`);
      console.log(`   Leaves: ${merkleTree.getLeafCount()}`);
      console.log(`   Root: ${merkleRootHex}`);

      // Update recipients.json with the computed root
      recipientsData.merkleRoot = merkleRootHex;
      recipientsData.metadata.algorithm = "keccak256";
      recipientsData.metadata.leafFormat = "recipient_pubkey(32) + amount(8) + is_claimed(1)";

      // Write back to file
      fs.writeFileSync("recipients.json", JSON.stringify(recipientsData, null, 2));
      console.log(`✅ Updated recipients.json with merkle root`); 

      return {
        merkleRoot: merkleRootHex,
        merkleTree,
      };
    } catch (error) {
      console.error("❌ Error generating merkle tree:", error);
      throw error;
    }
  }

  private generateNewProgramId(): { programId: string; keypairPath: string } {
    try {
      console.log("🆔 Generating new program ID...");
      
      // Generate new program keypair
      const keypairPath = "new-program-keypair.json";
      
      // Remove existing keypair if it exists
      if (fs.existsSync(keypairPath)) {
        fs.unlinkSync(keypairPath);
      }
      
      execSync(`solana-keygen new --outfile ${keypairPath} --no-bip39-passphrase --force`, { stdio: "pipe" });
      
      // Get the program ID
      const programId = execSync(`solana address -k ${keypairPath}`, { encoding: "utf8" }).trim();
      
      console.log(`✅ Generated new program ID: ${programId}`);
      return { programId, keypairPath };
    } catch (error) {
      console.error("❌ Error generating program ID:", error);
      throw error;
    }
  }

  private getCurrentProgramId(): string {
    try {
      // Try to read from Anchor.toml first
      const anchorContent = fs.readFileSync("Anchor.toml", "utf8");
      const match = anchorContent.match(/solana_distributor = "([^"]+)"/);
      if (match) {
        return match[1];
      }
      
      // Fallback to reading from lib.rs
      const libContent = fs.readFileSync("programs/solana-distributor/src/lib.rs", "utf8");
      const libMatch = libContent.match(/declare_id!\("([^"]+)"\);/);
      if (libMatch) {
        return libMatch[1];
      }
      
      throw new Error("Could not find program ID in configuration files");
    } catch (error) {
      console.error("❌ Error getting current program ID:", error);
      return "2SJSD8SwrGJRqkDUfcbmkuibEMygjiVm68fLyonUvXma"; // fallback
    }
  }

  private updateProgramReferences(newProgramId: string): void {
    try {
      console.log("📝 Updating program references...");
      
      // Update lib.rs
      const libPath = "programs/solana-distributor/src/lib.rs";
      let libContent = fs.readFileSync(libPath, "utf8");
      libContent = libContent.replace(/declare_id!\(".*"\);/, `declare_id!("${newProgramId}");`);
      fs.writeFileSync(libPath, libContent);
      console.log("   ✅ Updated programs/solana-distributor/src/lib.rs");
      
      // Update Anchor.toml
      let anchorContent = fs.readFileSync("Anchor.toml", "utf8");
      anchorContent = anchorContent.replace(/solana_distributor = ".*"/, `solana_distributor = "${newProgramId}"`);
      fs.writeFileSync("Anchor.toml", anchorContent);
      console.log("   ✅ Updated Anchor.toml");
      
      // Update recipients.json if it exists
      if (fs.existsSync("recipients.json")) {
        const recipientsData = JSON.parse(fs.readFileSync("recipients.json", "utf8"));
        recipientsData.programId = newProgramId;
        fs.writeFileSync("recipients.json", JSON.stringify(recipientsData, null, 2));
        console.log("   ✅ Updated recipients.json");
      }
      
      console.log("✅ All program references updated!");
    } catch (error) {
      console.error("❌ Error updating program references:", error);
      throw error;
    }
  }

  private async deployProgram(): Promise<boolean> {
    try {
      console.log("\n🚀 Deploying Solana program...\n");
      
      // Check if we need a new program ID
      const needNewProgram = await this.question("Do you want to deploy with a new program ID? (y/n): ");
      
      let newKeypairPath: string | null = null;
      
      if (needNewProgram.toLowerCase() === 'y' || needNewProgram.toLowerCase() === 'yes') {
        const { programId, keypairPath } = this.generateNewProgramId();
        this.updateProgramReferences(programId);
        newKeypairPath = keypairPath;
      }
      
      // Ensure deploy wallet has sufficient funds
      await this.ensureDeployWalletFunded();
      
      // Build the program first to create target/deploy directory
      console.log("🔨 Building program...");
      execSync("anchor build", { stdio: "inherit" });
      
      // Now copy the program keypair after build creates the directory
      if (newKeypairPath) {
        console.log("📋 Setting up program keypair...");
        // Ensure target/deploy directory exists
        execSync("mkdir -p target/deploy");
        execSync(`cp ${newKeypairPath} target/deploy/solana_distributor-keypair.json`);
        console.log("✅ Program keypair configured");
      }
      
      // Deploy the program
      console.log("📡 Deploying program...");
      execSync("anchor deploy", { stdio: "inherit" });
      
      console.log("✅ Program deployed successfully!");
      return true;
    } catch (error) {
      console.error("❌ Deployment failed:", error);
      console.log("\n🔧 Troubleshooting tips:");
      console.log("1. Make sure you have sufficient SOL in your deploy wallet");
      console.log("2. Check network connectivity to devnet");
      console.log("3. Try manual deployment: anchor build && anchor deploy");
      return false;
    }
  }

  private async ensureDeployWalletFunded(): Promise<void> {
    try {
      // Check if deploy wallet exists and extract it
      const { deployWallet } = this.loadExistingWallets();
      if (deployWallet) {
        this.createDeployWalletFile(deployWallet);
        
        const balance = await this.checkBalance(deployWallet.publicKey);
        console.log(`💰 Deploy wallet balance: ${balance} SOL`);
        
        if (balance < 2) {
          console.log("💧 Deploy wallet needs more SOL for deployment...");
          const fundSuccess = await this.requestAirdrop(deployWallet.publicKey, 2);
          if (!fundSuccess) {
            console.log("⚠️  Please fund your deploy wallet manually:");
            console.log(`   solana airdrop 2 ${deployWallet.publicKey} --url devnet`);
            console.log("   Or visit: https://faucet.solana.com");
          }
        }
      }
    } catch (error) {
      console.log("⚠️  Could not check deploy wallet balance");
    }
  }

  private async initializeAirdrop(): Promise<boolean> {
    try {
      console.log("\n🚀 Initializing airdrop on-chain...\n");
      
      console.log("📤 Running initialization script...");
      execSync("npx ts-node scripts/initialize-airdrop.ts", { stdio: "inherit" });
      
      console.log("✅ Airdrop initialized successfully!");
      return true;
    } catch (error) {
      console.error("❌ Airdrop initialization failed:", error);
      console.log("You can try manually with: npx ts-node scripts/initialize-airdrop.ts");
      return false;
    }
  }

  public async run(): Promise<void> {
    try {
      console.log("🎉 Welcome to Solana Distributor Deployment Setup!\n");
      console.log("This script will help you:");
      console.log("1. Set up your deployment wallet");
      console.log("2. Create test wallets for examples");
      console.log("3. Deploy the Solana program");
      console.log("4. Generate configuration files");
      console.log("\n" + "=".repeat(50) + "\n");

      // Step 1: Setup deployment wallet
      const deployWallet = await this.setupDeployWallet();
      this.wallets.push(deployWallet);

      // Step 2: Setup test wallets
      const testWallets = await this.setupTestWallets();
      this.wallets.push(...testWallets);

      // Step 3: Update configuration files
      console.log("\n📝 Updating configuration files...");
      this.updateAnchorConfig(deployWallet);
      this.saveTestWalletsJson(this.wallets);
      this.generateRecipientsJson(testWallets);

      // Step 3.5: Generate merkle tree and update recipients.json
      console.log("\n🌳 Generating merkle tree and updating recipients...");
      const { merkleRoot } = this.generateMerkleTree();

      // Step 4: Deploy program
      const deployChoice = await this.question("\nDo you want to deploy the program now? (y/n): ");
      let deploySuccess = false;
      if (deployChoice.toLowerCase() === 'y' || deployChoice.toLowerCase() === 'yes') {
        deploySuccess = await this.deployProgram();
        if (!deploySuccess) {
          console.log("⚠️  Deployment failed. You can try manually with: anchor deploy");
        }
      } else {
        console.log("⏭️  Skipping deployment. You can deploy later with: anchor deploy");
      }

      // Deployment completed successfully
      if (deploySuccess) {
        console.log("🎉 Program deployment completed successfully!");
        console.log("📋 To initialize the airdrop later, run: npx ts-node scripts/initialize-airdrop.ts");
      }

      // Step 5: Next steps
      console.log("\n" + "=".repeat(50));
      console.log("✅ Setup completed successfully!\n");
      console.log("📁 Files created:");
      this.wallets.forEach(wallet => {
        console.log(`   - ${wallet.keypairFile}`);
      });
      console.log("   - test-wallets.json");
      console.log("   - recipients.json (updated)");
      console.log("   - Anchor.toml (updated)");
      
      console.log("\n🚀 Next steps:");
      console.log("1. ✅ Merkle tree generated and recipients.json updated");
      if (deploySuccess) {
        console.log("2. ✅ Program deployed successfully");
        console.log("3. Initialize airdrop: npx ts-node scripts/initialize-airdrop.ts");
      } else {
        console.log("2. Deploy program: anchor deploy");
        console.log("3. Initialize airdrop: npx ts-node scripts/initialize-airdrop.ts");
      }
      console.log("4. Test claiming: npx ts-node scripts/claim-airdrop.ts <pubkey> <secretkey>");
      
      console.log("\n💡 Wallet information saved in test-wallets.json");
      console.log("   Use 'npx ts-node scripts/extract-private-keys.ts' to view keys");

    } catch (error) {
      console.error("❌ Setup failed:", error);
      process.exit(1);
    } finally {
      this.rl.close();
    }
  }
}

// Run the setup if this file is executed directly
if (require.main === module) {
  const setup = new SolanaDeploymentSetup();
  setup.run().catch(console.error);
}

export { SolanaDeploymentSetup }; 