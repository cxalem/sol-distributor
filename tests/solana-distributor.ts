import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaDistributor } from "../target/types/solana_distributor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { keccak_256 } from "js-sha3";

describe("solana-distributor", () => {
  // Configure the client to use the devnet cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.SolanaDistributor as Program<SolanaDistributor>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  let authority: Keypair;
  let airdropStateKey: PublicKey;

  // Test recipients
  let recipient1: Keypair;
  let recipient2: Keypair;
  let recipient1Amount = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL
  let recipient2Amount = 0.2 * LAMPORTS_PER_SOL; // 0.2 SOL
  let totalAmount = recipient1Amount + recipient2Amount; // 0.3 SOL

  before(async () => {
    authority = (provider.wallet as anchor.Wallet).payer;
    recipient1 = Keypair.generate();
    recipient2 = Keypair.generate();

    // Give recipients some SOL for transaction fees by transferring from authority
    const transferTx1 = await provider.connection.sendTransaction(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: recipient1.publicKey,
          lamports: 0.01 * LAMPORTS_PER_SOL,
        })
      ),
      [authority]
    );

    const transferTx2 = await provider.connection.sendTransaction(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: recipient2.publicKey,
          lamports: 0.01 * LAMPORTS_PER_SOL,
        })
      ),
      [authority]
    );

    // Wait for transfers to confirm
    await provider.connection.confirmTransaction(transferTx1);
    await provider.connection.confirmTransaction(transferTx2);

    // Derive airdrop state PDA
    [airdropStateKey] = PublicKey.findProgramAddressSync(
      [Buffer.from("merkle_tree")],
      program.programId
    );

    console.log("Authority:", authority.publicKey.toString());
    console.log("Airdrop State PDA:", airdropStateKey.toString());
    console.log("Recipient 1:", recipient1.publicKey.toString());
    console.log("Recipient 2:", recipient2.publicKey.toString());
  });

  it("Initialize airdrop with Merkle tree", async () => {
    // Generate Merkle tree for 2 recipients
    const merkleTree = generateMerkleTree([
      { recipient: recipient1.publicKey, amount: recipient1Amount },
      { recipient: recipient2.publicKey, amount: recipient2Amount }
    ]);

    console.log("Merkle root:", Buffer.from(merkleTree.root).toString('hex'));
    console.log("Total amount to distribute:", totalAmount / LAMPORTS_PER_SOL, "SOL");

    const authorityBalanceBefore = await provider.connection.getBalance(authority.publicKey);
    console.log("Authority balance before:", authorityBalanceBefore / LAMPORTS_PER_SOL, "SOL");

    const tx = await program.methods
      .initializeAirdrop(Array.from(merkleTree.root), new anchor.BN(totalAmount))
      .accounts({
        airdropState: airdropStateKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    console.log("Initialize transaction signature:", tx);

    // Verify state
    const airdropState = await program.account.airdropState.fetch(airdropStateKey);
    expect(airdropState.merkleRoot).to.deep.equal(Array.from(merkleTree.root));
    expect(airdropState.authority.toString()).to.equal(authority.publicKey.toString());
    expect(airdropState.airdropAmount.toNumber()).to.equal(totalAmount);
    expect(airdropState.amountClaimed.toNumber()).to.equal(0);

    // Verify the airdrop_state account has the SOL
    const vaultBalance = await provider.connection.getBalance(airdropStateKey);
    console.log("Vault balance:", vaultBalance / LAMPORTS_PER_SOL, "SOL");
    expect(vaultBalance).to.be.greaterThan(totalAmount); // Greater than because of rent
  });

  it("Claim SOL - Recipient 1", async () => {
    // Generate proof for recipient 1 (leaf index 0)
    const merkleTree = generateMerkleTree([
      { recipient: recipient1.publicKey, amount: recipient1Amount },
      { recipient: recipient2.publicKey, amount: recipient2Amount }
    ]);

    const proof = merkleTree.getProof(0);
    
    // Derive claim status PDA
    const [claimStatusKey] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("claim"),
        airdropStateKey.toBuffer(),
        recipient1.publicKey.toBuffer()
      ],
      program.programId
    );

    console.log("Claiming for recipient 1:", recipient1.publicKey.toString());
    console.log("Amount to claim:", recipient1Amount / LAMPORTS_PER_SOL, "SOL");
    console.log("Proof length:", proof.length);

    // Check recipient balance before
    const balanceBefore = await provider.connection.getBalance(recipient1.publicKey);
    console.log("Recipient 1 balance before claim:", balanceBefore / LAMPORTS_PER_SOL, "SOL");

    const tx = await program.methods
      .claimAirdrop(
        new anchor.BN(recipient1Amount),
        proof.map(p => Array.from(p)),
        new anchor.BN(0) // leaf index
      )
      .accounts({
        airdropState: airdropStateKey,
        userClaim: claimStatusKey,
        signer: recipient1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([recipient1])
      .rpc();

    console.log("Claim transaction signature:", tx);

    // Verify claim status account was created
    const claimAccount = await provider.connection.getAccountInfo(claimStatusKey);
    expect(claimAccount).to.not.be.null;

    // Check recipient balance after
    const balanceAfter = await provider.connection.getBalance(recipient1.publicKey);
    console.log("Recipient 1 balance after claim:", balanceAfter / LAMPORTS_PER_SOL, "SOL");
    
    // Should have received the airdrop minus transaction fees
    expect(balanceAfter).to.be.greaterThan(balanceBefore + recipient1Amount - 0.01 * LAMPORTS_PER_SOL);

    // Verify updated airdrop state
    const airdropState = await program.account.airdropState.fetch(airdropStateKey);
    expect(airdropState.amountClaimed.toNumber()).to.equal(recipient1Amount);
  });

  it("Claim SOL - Recipient 2", async () => {
    // Generate proof for recipient 2 (leaf index 1)
    const merkleTree = generateMerkleTree([
      { recipient: recipient1.publicKey, amount: recipient1Amount },
      { recipient: recipient2.publicKey, amount: recipient2Amount }
    ]);

    const proof = merkleTree.getProof(1);
    
    // Derive claim status PDA
    const [claimStatusKey] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("claim"),
        airdropStateKey.toBuffer(),
        recipient2.publicKey.toBuffer()
      ],
      program.programId
    );

    console.log("Claiming for recipient 2:", recipient2.publicKey.toString());
    console.log("Amount to claim:", recipient2Amount / LAMPORTS_PER_SOL, "SOL");

    // Check recipient balance before
    const balanceBefore = await provider.connection.getBalance(recipient2.publicKey);
    console.log("Recipient 2 balance before claim:", balanceBefore / LAMPORTS_PER_SOL, "SOL");

    const tx = await program.methods
      .claimAirdrop(
        new anchor.BN(recipient2Amount),
        proof.map(p => Array.from(p)),
        new anchor.BN(1) // leaf index
      )
      .accounts({
        airdropState: airdropStateKey,
        userClaim: claimStatusKey,
        signer: recipient2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([recipient2])
      .rpc();

    console.log("Claim transaction signature:", tx);

    // Check recipient balance after
    const balanceAfter = await provider.connection.getBalance(recipient2.publicKey);
    console.log("Recipient 2 balance after claim:", balanceAfter / LAMPORTS_PER_SOL, "SOL");
    
    // Should have received the airdrop minus transaction fees
    expect(balanceAfter).to.be.greaterThan(balanceBefore + recipient2Amount - 0.01 * LAMPORTS_PER_SOL);

    // Verify final airdrop state
    const airdropState = await program.account.airdropState.fetch(airdropStateKey);
    expect(airdropState.amountClaimed.toNumber()).to.equal(totalAmount);
  });

  it("Should fail to claim twice", async () => {
    // Try to claim again for recipient 1
    const merkleTree = generateMerkleTree([
      { recipient: recipient1.publicKey, amount: recipient1Amount },
      { recipient: recipient2.publicKey, amount: recipient2Amount }
    ]);

    const proof = merkleTree.getProof(0);
    
    const [claimStatusKey] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("claim"),
        airdropStateKey.toBuffer(),
        recipient1.publicKey.toBuffer()
      ],
      program.programId
    );

    try {
      await program.methods
        .claimAirdrop(
          new anchor.BN(recipient1Amount),
          proof.map(p => Array.from(p)),
          new anchor.BN(0)
        )
        .accounts({
          airdropState: airdropStateKey,
          userClaim: claimStatusKey,
          signer: recipient1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([recipient1])
        .rpc();
      
      expect.fail("Should have failed to claim twice");
    } catch (error) {
      console.log("Expected error for double claim:", error.message);
      expect(error.message).to.include("already in use");
    }
  });
});

// Simple Merkle tree implementation for testing
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
    this.leaves = recipients.map(r => this.createLeaf(r.recipient, r.amount));
    
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
      Buffer.from([0]) // isClaimed = false
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
}

function generateMerkleTree(recipients: Recipient[]): SimpleMerkleTree {
  return new SimpleMerkleTree(recipients);
}
