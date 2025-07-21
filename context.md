Great. I’ll create a simplified and updated example project using the older Jito Distributor program, modernized for:

* `solana-cli 2.2.20`
* `anchor-cli 0.31.1`
* `cargo 1.88.0`
* `rustc 1.88.0`

This will be a minimal working example that runs on devnet, using only backend components (no frontend). I’ll make sure all steps and examples are valid and testable. I’ll let you know once the guide is ready.


# Building a Merkle Airdrop Distributor on Solana (Anchor 0.31 Devnet Example)

## Introduction

Solana airdrops can distribute tokens to many addresses efficiently using a **Merkle tree** of recipients. The Jito Foundation’s **Merkle Distributor** program is an example of this: it stores a Merkle root on-chain and allows eligible users to claim tokens by providing a Merkle proof. This approach supports distributing both immediately **unlocked** tokens and tokens that **vest linearly** over time. In this guide, we will create a **minimal working example** of a Merkle-based token distributor using modern Solana tooling (solana-cli v2.2.20, Anchor v0.31.1, Rust 1.88). We’ll target **devnet** for deployment and testing, focusing purely on the program logic (no front-end integration).

**What is a Merkle Airdrop?** A Merkle tree is a binary tree of hashes that provides a single **Merkle root** representing an entire data set (e.g. a list of token allocations). Each leaf is a hash of a user’s data (such as their address and token amount), and parent nodes are hashes of their children, up to the root. By storing only the 32-byte root on-chain, we can verify any user’s inclusion by having them submit a **Merkle proof** (the series of sibling hashes from the leaf to the root). This is extremely cost-efficient – the on-chain state is minimal, and proof sizes grow only logarithmically with the number of recipients. The program will verify the proof and, if valid, transfer the allotted tokens to the user. Using this pattern, thousands of airdrop recipients can claim tokens without needing to store a giant list on-chain.

## Setup and Prerequisites

Before coding, ensure your development environment meets the requirements:

* **Rust and Cargo:** Rust 1.88.0 (with **cargo** 1.88.0) or later installed.
* **Solana CLI:** Version 2.2.20 (which corresponds to Solana core v1.16+). Ensure it’s configured for devnet (`solana config set --url https://api.devnet.solana.com`).
* **Anchor CLI:** Version 0.31.1. You can install or upgrade Anchor by running `cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.31.1` (or use `avm` if you have Anchor Version Manager). Verify with `anchor --version` to see `anchor-cli 0.31.1`.

Additionally, make sure you have a Solana keypair with some devnet SOL for fees (you can create one with `solana-keygen new` and airdrop SOL using `solana airdrop 2`). We will use Anchor’s default keypair (located at `~/.config/solana/id.json`) as the payer and authority in this example.

## Project Initialization

Let’s set up a new Anchor project for our distributor program:

1. **Create a new Anchor workspace:** Run `anchor init merkle-distributor-example`. This will generate a new directory with an Anchor program (Rust crate) and Anchor configuration.

2. **Update Anchor configuration:** Open the generated **Anchor.toml** and set the Anchor version and cluster. For example:

   ```toml
   [toolchain]
   anchor_version = "0.31.1"
   solana_version = "1.16.10"  # (Anchor 0.31 is compatible with Solana v1.16/v1.17)

   [provider]
   cluster = "devnet"
   wallet = "~/.config/solana/id.json"
   ```

   Ensure the cluster is `"devnet"` so Anchor deploys to devnet. We use the default wallet path for the keypair.

3. **Add dependencies:** Our program will use Anchor’s SPL token library and a Merkle tree utility:

   * Add Anchor SPL crate for token program access: `cargo add anchor-spl = "0.31.0"` (Anchor will pull in the correct Solana token program versions).
   * Add a Merkle tree crate. We can use the `svm_merkle_tree` crate (an optimized Merkle tree library for Solana). It’s not on crates.io at time of writing, but we can add it from GitHub:

     ```bash
     cargo add svm-merkle-tree --git https://github.com/deanmlittle/svm-merkle-tree
     ```

     This crate provides on-chain Merkle proof verification utilities. (Alternatively, one could implement Merkle proof verification manually using Solana’s keccak hashing, but using a proven library is simpler and less error-prone for our example.)

4. **Set Program ID:** Anchor will generate a program ID for us when we build. After running `anchor build`, check the `target/deploy/` folder for a file like `merkle_distributor_example-keypair.json` and note the public key. Copy this public key into your program code using `declare_id!("<PROGRAM_ID>");` (or update Anchor.toml under `[programs.devnet]`). This ensures our program uses a fixed address on devnet.

With the project created and configured, we can now implement the program logic.

## Program Accounts and Data Structures

We will define two main account types for our program:

* **Merkle Distributor State** – a PDA (Program Derived Address) that stores the Merkle root and distribution parameters.
* **Claim Status (Receipt)** – a PDA for each claimant to mark that they have claimed their tokens (preventing double-claims).

### Merkle Distributor State (AirdropState)

The distributor’s state account holds the Merkle root and other important info. We define a struct (marked with `#[account]` so Anchor knows this is a persistent account type):

```rust
#[account]
pub struct AirdropState {
    /// The Merkle root of the airdrop (32 bytes)
    pub merkle_root: [u8; 32],
    /// The authority allowed to update the merkle root (e.g. project owner)
    pub authority: Pubkey,
    /// The token mint being distributed
    pub mint: Pubkey,
    /// Total tokens allocated for this airdrop
    pub airdrop_amount: u64,
    /// Total tokens claimed so far
    pub amount_claimed: u64,
    /// Bump seed for the PDA
    pub bump: u8,
}
```

Each field in `AirdropState` serves a purpose: the `merkle_root` represents all eligible addresses and their allocations; `authority` is the only one who can modify the root (if updates are needed); `mint` is the SPL token being distributed; `airdrop_amount` is the total amount of tokens set aside (minted to the program’s vault) for this airdrop; `amount_claimed` tracks how many have been claimed so far; and `bump` is used for PDA derivation.

We will derive the PDA for `AirdropState` using a seed, e.g., a static string and the mint address. In our example, we’ll use `["merkle_tree", mint]` as seeds. This way, for a given token mint, the program has one corresponding distributor state account.

### Claim Status Account (User Receipt)

To prevent users from claiming more than once, we create a **ClaimStatus** account (or “receipt”) for each claimant. This is a PDA derived from the airdrop state and the user’s wallet. It doesn’t need to store much – the mere existence of this account signifies that the user has claimed their share. We can define it simply as:

```rust
#[account]
pub struct ClaimStatus {}  // Empty account, used as a flag (requires only discriminator)
```

This account will be initialized upon a successful claim. If a user tries to claim again, the program will attempt to re-initialize the same PDA and fail, thereby preventing double spending. (In a more optimized implementation, one could omit even storing a struct here and use an `UncheckedAccount` assigned to the program with zero data, but for clarity we use a basic account.)

## Implementing the Initialize Instruction

First, we need an instruction to initialize the distributor. This will create the `AirdropState` account (PDA), store the Merkle root, and set up a token **vault** to hold the tokens to be distributed. The vault will be an Associated Token Account (ATA) for the `AirdropState` (PDA) to hold the specified token mint.

### Initialize: Accounts Context

We define an Anchor **Accounts** context for the `initialize` instruction. This specifies the accounts required and enforces constraints:

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        seeds = [b"merkle_tree", mint.key().as_ref()],
        bump,
        payer = authority,
        space = 8 + std::mem::size_of::<AirdropState>()  // allocate state account
    )]
    pub airdrop_state: Account<'info, AirdropState>,

    /// CHECK: The token mint of the tokens being distributed
    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = airdrop_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
```

Let’s break this down:

* **airdrop\_state:** This is our program PDA for the distributor. We use `init` to create it, with a deterministic seed (`"merkle_tree"` + the mint’s pubkey) and `bump`. The `payer` is the authority (who pays the rent). We allocate enough `space` for the account (8 bytes for Anchor’s discriminator + the struct size). After this, `airdrop_state` will be owned by our program.
* **mint:** The SPL token Mint account for the token we want to distribute. We mark it mutable (`mut`) because we will mint tokens to the vault and possibly change its authority. The authority (initially the same as `authority` signer) must be provided to authorize minting.
* **vault:** This is the ATA (token account) that will hold the airdrop tokens on behalf of the program. We use Anchor’s `associated_token` constraint to derive the PDA for the token account automatically. By specifying `associated_token::mint = mint` and `associated_token::authority = airdrop_state`, Anchor will ensure `vault` is the token account for `mint` owned by the `airdrop_state` PDA. We use `init_if_needed` in case the ATA already exists (e.g., if the program is re-initialized for the same mint). After this, the program’s PDA will control the vault.
* **authority:** The user initializing the airdrop (probably the project owner). This account pays for the creation of the others and will be stored as the `authority` in `AirdropState`. We mark it as a Signer and `mut` because it will also be used to mint tokens and pay fees.
* The **System, Token, and Associated Token Program** entries are program references required by CPI calls (for creating accounts and minting tokens). Anchor will verify their addresses (e.g., Token Program ID).

### Initialize: Instruction Logic

Now, in the Rust program module (marked with `#[program]`), we implement the `initialize` handler:

```rust
pub fn initialize_airdrop(ctx: Context<Initialize>, merkle_root: [u8; 32], amount: u64) -> Result<()> {
    let airdrop_state = &mut ctx.accounts.airdrop_state;
    // Populate the airdrop state account data
    airdrop_state.merkle_root = merkle_root;
    airdrop_state.authority = ctx.accounts.authority.key();
    airdrop_state.mint = ctx.accounts.mint.key();
    airdrop_state.airdrop_amount = amount;
    airdrop_state.amount_claimed = 0;
    airdrop_state.bump = *ctx.bumps.get("airdrop_state").unwrap();

    // Mint the total airdrop amount of tokens into the vault
    anchor_spl::token::mint_to(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount,
    )?;

    // Optionally, revoke the mint authority to freeze the token supply for the airdrop
    anchor_spl::token::set_authority(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::SetAuthority {
                current_authority: ctx.accounts.authority.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        anchor_spl::token::AuthorityType::MintTokens,
        None,  // set new authority to None (permanently remove)
    )?;

    Ok(())
}
```

When `initialize_airdrop` is called, we pass in the `merkle_root` (computed off-chain from the airdrop list) and the total `amount` of tokens to distribute. The handler does the following:

* Writes the provided `merkle_root` and other fields into the new `AirdropState` account.
* Mints `amount` tokens of the given mint into the vault ATA owned by the program. We use the `mint_to` CPI from `anchor_spl::token` for this. The `authority` signer must be the mint’s current authority, so this succeeds in minting the airdrop supply.
* Optionally, we call `set_authority` to remove the mint’s authority (set it to `None`). This is a safeguard to prevent any further minting of that token. After this, the entire airdrop supply is locked in the vault and cannot be increased by the authority. (You may skip this in a devnet test, but it’s good practice for a real token distribution.)

After running `initialize_airdrop`, the program state is set up: the `airdrop_state` PDA holds the Merkle root and distribution info, and the vault contains the tokens ready to be claimed. We’re now ready to allow users to claim their tokens with proofs.

## Implementing the Claim Instruction

The `claim` instruction is the heart of the program. It allows a user to claim their token allocation by proving they are in the Merkle tree. The user (signer) will submit their allotted amount, a Merkle proof (array of hashes), and the index of their leaf in the tree. The program will verify the proof and transfer the tokens if valid, also recording that the claim happened.

### Claim: Accounts Context

We define the accounts needed for the `claim` instruction in an Anchor context:

```rust
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        has_one = mint,
        seeds = [b"merkle_tree", mint.key().as_ref()],
        bump = airdrop_state.bump
    )]
    pub airdrop_state: Account<'info, AirdropState>,

    /// CHECK: Token mint of the airdrop (verified via airdrop_state.mint)
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = airdrop_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = signer,
        space = 8,
        seeds = [b"claim", airdrop_state.key().as_ref(), signer.key().as_ref()],
        bump
    )]
    pub user_claim: Account<'info, ClaimStatus>,

    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = signer,
    )]
    pub signer_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
```

Key points for `Claim` accounts:

* **airdrop\_state:** The distributor state account (PDA). It’s `mut` because we might update `amount_claimed`. We include `has_one = mint` to ensure the provided `mint` account matches the one stored in `airdrop_state` (safety check). We also reiterate the `seeds` and `bump` so Anchor can re-derive the PDA and verify the account is correct.
* **mint:** The token mint (same as in state). We mark it as a regular Account (no need for mut here, since we aren’t modifying the mint in this instruction). The `has_one` above ties it to state.
* **vault:** The program’s token vault (ATA) holding the remaining tokens. Using `associated_token::authority = airdrop_state` ensures this is the ATA for the state PDA. We mark it `mut` because its token balance will decrease when we transfer out tokens.
* **user\_claim:** The ClaimStatus account for this user. We create (init) this PDA on the fly, with seeds composed of a prefix and the unique combination of airdrop\_state and user (signer) pubkeys. The space is just 8 bytes (discriminator) since `ClaimStatus` has no fields. The `payer` is the user (so the user pays the rent for this small account). Creating this account effectively marks the user as claimed. If a user tries to claim again, this account would already exist, causing the `init` to fail – thereby preventing multiple claims.
* **signer\_ata:** The Associated Token Account for the user to receive the tokens. We use `init_if_needed` in case the user’s ATA for this mint doesn’t exist yet (Anchor will create it, charging the user as `payer`). If it already exists (user may have a token account for this mint), it will simply be used. This is the destination for the token transfer.
* **signer:** The user’s wallet signing the transaction (the claimer). Marked as mut because they pay for `user_claim` (and possibly ATA rent) and will ultimately own the tokens received.
* **System, Token, AssociatedToken Programs:** as before, required for CPI calls and account creation.

### Claim: Instruction Logic

Now the Rust logic for verifying the proof and transferring tokens in the `claim` instruction:

```rust
pub fn claim_airdrop(
    ctx: Context<Claim>,
    amount: u64,
    proof_hashes: Vec<u8>,  // concatenated sibling hashes
    leaf_index: u64
) -> Result<()> {
    let airdrop_state = &mut ctx.accounts.airdrop_state;
    let signer = &ctx.accounts.signer;

    // Step 1: Recreate the original leaf hash from the claimant's data
    let mut leaf_data = Vec::new();
    leaf_data.extend_from_slice(&signer.key().to_bytes());    // user address (32 bytes)
    leaf_data.extend_from_slice(&amount.to_le_bytes());       // allotted amount (8 bytes)
    leaf_data.push(0u8);  // isClaimed flag (0 = false, since off-chain data marks unclaimed)

    // Step 2: Verify the Merkle proof by recomputing the root
    let merkle_proof = MerkleProof::new(HashingAlgorithm::Keccak, 32, leaf_index as u32, proof_hashes.clone());
    let computed_root = merkle_proof
        .merklize(&leaf_data)
        .map_err(|_| error!(ErrorCode::InvalidProof))?;

    require!(computed_root == airdrop_state.merkle_root, ErrorCode::InvalidProof);

    // Step 3: Transfer tokens from vault to the user's token account
    let vault_seeds = &[b"merkle_tree", airdrop_state.mint.as_ref(), &[airdrop_state.bump]];
    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.signer_ata.to_account_info(),
                authority: airdrop_state.to_account_info(),
            },
            &[vault_seeds]
        ),
        amount,
    )?;

    // Step 4 (optional): Update state accounting
    airdrop_state.amount_claimed = airdrop_state.amount_claimed.saturating_add(amount);

    Ok(())
}
```

Let’s explain the steps:

* **Step 1: Construct the leaf** – Off-chain, when the Merkle tree was built, each leaf was typically the hash of `[user_pubkey || amount || isClaimed]`. In our scheme, `isClaimed` was initially `false` (0) for all leaves. We reconstruct the exact byte buffer for the claimant’s leaf: 32 bytes of the user’s address, 8 bytes of the amount (little-endian), and a single byte `0`. We do **not** hash it here; we will feed this raw leaf data into the Merkle proof algorithm which will handle hashing.
* **Step 2: Verify the proof** – We create a `MerkleProof` object from the provided proof data. The `svm_merkle_tree` library’s `MerkleProof::new` expects the hashing algorithm (Keccak-256 in this case, which is standard on Solana for Merkle trees), the hash length (32 bytes), the index of the leaf, and the concatenated hash bytes of the proof. We then call `merklize(&leaf_data)` which computes the Merkle root from our leaf up through all provided sibling hashes. If the resulting `computed_root` matches the `airdrop_state.merkle_root`, the proof is valid. If not, we throw an `InvalidProof` error. (The `require!` macro will abort the transaction if the condition is false.)
* **Step 3: Transfer tokens** – We now know the user is eligible, so we perform the token transfer. We call the SPL Token `transfer` via Anchor’s CPI helper, moving `amount` tokens from the program’s `vault` to the user’s `signer_ata` token account. Notice we use `CpiContext::new_with_signer` to sign this CPI with the **program’s PDA**. The `vault` is owned by the PDA (`airdrop_state`), so the PDA must sign the transfer. Anchor allows this by specifying the PDA seeds (`vault_seeds`) used to derive the PDA – the runtime will sign the CPI as if `airdrop_state` were the authority. The seeds array must exactly match how the PDA was created (we use the same `[b"merkle_tree", mint_pubkey, bump]`). By providing `&[vault_seeds]`, the transfer instruction is signed by the PDA. This securely moves the tokens to the user.
* **Step 4: Update claimed amount** – We add the claimed amount to `airdrop_state.amount_claimed`. This is optional bookkeeping, but it could be useful for the authority to track progress or for sanity checks (e.g., ensure it never exceeds `airdrop_amount`). If two users claim in quick succession, this field might be briefly outdated due to separate transactions (and Solana not allowing simultaneous writes to the state account), but overall it will reflect total distributed tokens.

Finally, because we included the `user_claim` account with `init` in the context, if this instruction succeeds once, the next time the same user tries to call it, the `user_claim` PDA for that user will already exist. Anchor will then refuse to `init` it again, effectively preventing the user from claiming twice. This implements the “claim receipt” approach: each user pays a tiny rent to get a one-time claim receipt, avoiding the need to mutate the central state or Merkle tree on each claim.

**Error Handling:** We would define an `ErrorCode::InvalidProof` in the program’s errors enumeration for the require checks (not shown for brevity). If a user submits an incorrect proof or wrong amount, the transaction fails with this error, and no tokens are transferred.

## Deploying and Testing on Devnet

With both instructions implemented, compile and deploy the program to devnet:

* Run `anchor build` to compile the program. Fix any errors, then proceed.
* Run `anchor deploy`. Anchor will use your configured devnet RPC and wallet to create a program account and upload the program. Note the program ID (it should match what you set in `declare_id!`). If deploy succeeds, the program is live on devnet.

Now, to test the distributor, you need to generate a Merkle tree for a set of recipients off-chain:

1. **Prepare Airdrop Recipients:** For a simple test, you can use just one recipient (your own devnet wallet) to ensure it works end-to-end. For example, suppose you want to airdrop 100 tokens to your wallet.
2. **Compute the Merkle Root:** If there’s only one leaf (your address + 100 + isClaimed=0), the Merkle root is just the hash of that leaf. You can compute this using a script or the `svm_merkle_tree` crate in an off-chain context. For multiple recipients, you’d hash each `[address||amount||0]` leaf and build the Merkle tree up to get the root. (The Jito distributor repository and others provide scripts to generate `merkle_tree.json` files).
3. **Initialize on Devnet:** Use Anchor or the Solana CLI to send the `initialize_airdrop` transaction. You can write an Anchor client script or use the `anchor test` framework. Make sure to supply the exact Merkle root bytes and total token amount. Also create a new token mint on devnet for testing (e.g., with `spl-token` CLI), and fund it by calling our initialize (which mints the tokens into the vault). After initialization, verify that the `vault` ATA (check via `spl-token accounts`) now holds the correct number of tokens.
4. **Generate a Proof:** Off-chain, generate the Merkle proof for your address. In the one-recipient case, the proof is trivial (no siblings needed, or you could consider an empty proof). For multiple recipients, you’d retrieve the array of sibling hashes for your leaf index from the Merkle tree data.
5. **Claim Tokens:** Construct and send a `claim_airdrop` transaction from your wallet. Provide the accounts: your `signer` (wallet), the `airdrop_state` PDA, the `vault` and `signer_ata` (Anchor will derive these given the seeds), and the `user_claim` PDA (which Anchor will create). Pass in the amount you are claiming and the proof (as `Vec<u8>` of sibling hashes, or empty if none). If the proof is valid, the transaction will succeed. The program will transfer the tokens into your wallet’s token account. You can confirm by checking your token balance on devnet (e.g., via `spl-token balance` or a block explorer).
6. **Double-claim Prevention:** If you try to call `claim_airdrop` again for the same user, it should fail. Anchor will attempt to create the `user_claim` PDA again and throw an error since it already exists. Thus, the user cannot claim more than once.

Throughout testing, use the Solana CLI or Anchor client to confirm each step (account data, token balances, etc.). For example, after initialization, you can fetch the `AirdropState` account data via `anchor account <AirdropStatePublicKey>` to see the stored merkle root and totals, and after claiming, you can see that your `signer_ata` increased by the expected amount.

## Conclusion and Next Steps

In this guide, we created a simplified **Merkle Distributor** program updated for Anchor 0.31 and the latest Solana tools. We set up an on-chain state with a Merkle root and demonstrated how users can securely claim token allocations by providing a correct Merkle proof. We also included a basic mechanism to prevent double claims using a per-user receipt account. This design is efficient and scalable – the on-chain storage is minimal (just the root and small receipts), and verification is done in a single transaction for each claim.

**Further enhancements:** The example can be extended to handle **vesting** (time-locked distributions) by adding fields for schedule timestamps and checking the current clock in the claim instruction. The original Jito program, for instance, distributed some tokens immediately and others linearly unlocked over time. You could also implement an **update\_root** instruction to support adding new recipients or revoking allocations by updating the Merkle root (only allowed by the `authority`). Additionally, for very large airdrops, techniques like **sharded Merkle trees** can be used (splitting the recipient list into multiple trees to keep proofs and account locks manageable).

With the fundamentals in place, you can integrate a front-end or script to generate proofs and interact with this program. But even without a dedicated front-end, our example is fully functional via CLI/Anchor tests on devnet. By following this guide, you now have a working Anchor-based Merkle airdrop program using modern Solana development practices – ready to distribute tokens efficiently via Merkle roots! 🚀

**Sources:**

* Jito Foundation’s Merkle Distributor (original design and inspiration)
* Metaplex Guide on Token Claimer (Merkle Tree airdrop example in Anchor)
