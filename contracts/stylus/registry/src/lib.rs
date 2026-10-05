//! # XorvRegistry — provider registry and reputation ledger (Arbitrum Stylus, Rust)
//!
//! Implements `contracts/src/interfaces/IXorvRegistry.sol` exactly. `XorvEscrow` (Solidity)
//! moves the money and, in the same transaction, calls [`XorvRegistry::record_outcome`] here, so
//! a provider's track record is written by the settlement itself: it can be earned, never claimed.
//!
//! ## Roles
//! - **owner** — configures `escrow` and `operator`, can hand over ownership.
//! - **operator** — a relayer that sponsors onboarding (`registerFor`) and liveness
//!   (`heartbeatFor`) so providers need no gas. The owner may do both too.
//! - **escrow** — the only address allowed to call `recordOutcome`.
//!
//! ## Storage layout
//! A provider record mirrors the Solidity `Provider` struct field-for-field and packs the same
//! way Solidity would: `nodeId` | `registeredAt, lastSeen, completed, failed` (four `uint64` in
//! one slot) | `earned` | `active` — four slots. The hot path, a successful `recordOutcome` on an
//! existing record, touches two of them. `metadataUri` is only emitted, never stored.
//!
//! ## Invariants
//! - `owner != 0` ⇔ initialized (ownership can never be transferred to zero).
//! - `nodeId != 0` ⇔ the provider has registered at least once (`register*` rejects a zero
//!   nodeId and never clears it). This is what `providerCount` counts; a record created by
//!   `recordOutcome` alone has `nodeId == 0` and is not counted.
//! - `active` ⇒ `nodeId != 0`.
//! - Counters and `earned` are monotonic and saturate instead of wrapping or reverting, so
//!   outcome reporting can never brick settlement in the escrow.
//!
//! The contract makes no external calls, holds no funds and has no payable entry points.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::{string::String, vec::Vec};
use alloy_primitives::{Address, B256, U64, U256};
use alloy_sol_types::sol;
use stylus_sdk::{
    prelude::*,
    storage::{StorageAddress, StorageB256, StorageBool, StorageMap, StorageU64, StorageU256},
};

/// Longest `metadataUri` accepted, in bytes. It is only emitted, but an unbounded string would
/// let a caller inflate log data (and the operator's sponsored gas) arbitrarily.
pub const MAX_METADATA_LEN: usize = 256;

/// Score scale: basis points.
const BPS: u128 = 10_000;

sol! {
    // ---- Events: identical to IXorvRegistry.sol ----
    event ProviderRegistered(address indexed provider, bytes32 indexed nodeId, string metadataUri);
    event ProviderDeactivated(address indexed provider);
    event Heartbeat(address indexed provider, uint64 timestamp);
    event OutcomeRecorded(
        address indexed provider, bool success, uint256 amount, uint64 completed, uint64 failed
    );
    event EscrowUpdated(address indexed escrow);
    event OperatorUpdated(address indexed operator);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---- Custom errors ----
    /// `caller` is not allowed to call this function.
    #[derive(Debug, PartialEq, Eq)]
    error Unauthorized(address caller);
    /// `initialize` (or the constructor) already ran.
    #[derive(Debug, PartialEq, Eq)]
    error AlreadyInitialized();
    /// `provider` has never registered.
    #[derive(Debug, PartialEq, Eq)]
    error NotRegistered(address provider);
    /// An address argument that must be non-zero was zero.
    #[derive(Debug, PartialEq, Eq)]
    error ZeroAddress();
    /// `nodeId` must be non-zero.
    #[derive(Debug, PartialEq, Eq)]
    error InvalidNodeId();
    /// `provider` is registered but deactivated.
    #[derive(Debug, PartialEq, Eq)]
    error Inactive(address provider);
    /// `metadataUri` is `length` bytes; the cap is `MAX_METADATA_LEN`.
    #[derive(Debug, PartialEq, Eq)]
    error MetadataTooLong(uint256 length);
}

/// Every revert this contract can produce. Each variant ABI-encodes as its Solidity custom error.
#[derive(SolidityError, Debug, PartialEq, Eq)]
pub enum RegistryError {
    Unauthorized(Unauthorized),
    AlreadyInitialized(AlreadyInitialized),
    NotRegistered(NotRegistered),
    ZeroAddress(ZeroAddress),
    InvalidNodeId(InvalidNodeId),
    Inactive(Inactive),
    MetadataTooLong(MetadataTooLong),
}

/// `IXorvRegistry.Provider`, flattened: `(nodeId, registeredAt, lastSeen, completed, failed,
/// earned, active)`. A static tuple and a static struct share one ABI encoding.
pub type ProviderTuple = (B256, u64, u64, u64, u64, U256, bool);

/// One provider's on-chain record.
#[storage]
pub struct ProviderRecord {
    node_id: StorageB256,
    registered_at: StorageU64,
    last_seen: StorageU64,
    completed: StorageU64,
    failed: StorageU64,
    earned: StorageU256,
    active: StorageBool,
}

#[storage]
#[entrypoint]
pub struct XorvRegistry {
    /// Packed with `provider_count` in one slot.
    owner: StorageAddress,
    provider_count: StorageU64,
    escrow: StorageAddress,
    operator: StorageAddress,
    providers: StorageMap<Address, ProviderRecord>,
}

#[inline]
fn u64_of(v: U64) -> u64 {
    v.to::<u64>()
}

/// Laplace-smoothed success rate in basis points: `(completed+1)*10000/(completed+failed+2)`.
/// Done in `u128`: the numerator is < 2^78 and the denominator < 2^66, so nothing can overflow,
/// and the result is always in `[0, 10000]`, so the `u32` cast is lossless.
pub fn laplace_score(completed: u64, failed: u64) -> u32 {
    let c = completed as u128;
    let f = failed as u128;
    ((c + 1) * BPS / (c + f + 2)) as u32
}

/// Private helpers (not exported to the ABI).
impl XorvRegistry {
    fn sender(&self) -> Address {
        self.vm().msg_sender()
    }

    fn now(&self) -> u64 {
        self.vm().block_timestamp()
    }

    fn only_owner(&self) -> Result<(), RegistryError> {
        let caller = self.sender();
        if caller != self.owner.get() {
            return Err(Unauthorized { caller }.into());
        }
        Ok(())
    }

    /// Owner or operator. A zero operator never matches because no caller is address(0).
    fn only_operator_or_owner(&self) -> Result<(), RegistryError> {
        let caller = self.sender();
        if caller != self.operator.get() && caller != self.owner.get() {
            return Err(Unauthorized { caller }.into());
        }
        Ok(())
    }

    fn init(&mut self, owner: Address) -> Result<(), RegistryError> {
        if !self.owner.get().is_zero() {
            return Err(AlreadyInitialized {}.into());
        }
        if owner.is_zero() {
            return Err(ZeroAddress {}.into());
        }
        self.owner.set(owner);
        self.vm().log(OwnershipTransferred {
            previousOwner: Address::ZERO,
            newOwner: owner,
        });
        Ok(())
    }

    fn register_impl(
        &mut self,
        provider: Address,
        node_id: B256,
        metadata_uri: String,
    ) -> Result<(), RegistryError> {
        if provider.is_zero() {
            return Err(ZeroAddress {}.into());
        }
        if node_id.is_zero() {
            return Err(InvalidNodeId {}.into());
        }
        if metadata_uri.len() > MAX_METADATA_LEN {
            return Err(MetadataTooLong {
                length: U256::from(metadata_uri.len()),
            }
            .into());
        }

        let now = self.now();
        let mut rec = self.providers.setter(provider);
        let first_registration = rec.node_id.get().is_zero();
        // The record may already exist without a registration (created by `recordOutcome`);
        // keep its original creation time in that case.
        if rec.registered_at.get().is_zero() {
            rec.registered_at.set(U64::from(now));
        }
        rec.node_id.set(node_id);
        rec.last_seen.set(U64::from(now));
        rec.active.set(true);
        drop(rec);

        if first_registration {
            let count = u64_of(self.provider_count.get()).saturating_add(1);
            self.provider_count.set(U64::from(count));
        }

        self.vm().log(ProviderRegistered {
            provider,
            nodeId: node_id,
            metadataUri: metadata_uri,
        });
        Ok(())
    }

    fn heartbeat_impl(&mut self, provider: Address) -> Result<(), RegistryError> {
        let now = self.now();
        let mut rec = self.providers.setter(provider);
        if rec.node_id.get().is_zero() {
            return Err(NotRegistered { provider }.into());
        }
        if !rec.active.get() {
            return Err(Inactive { provider }.into());
        }
        rec.last_seen.set(U64::from(now));
        drop(rec);
        self.vm().log(Heartbeat {
            provider,
            timestamp: now,
        });
        Ok(())
    }
}

#[public]
impl XorvRegistry {
    /// Atomic deploy-and-initialize through cargo-stylus' `StylusDeployer`, so there is no window
    /// in which someone else could call `initialize` first. Not part of IXorvRegistry (interfaces
    /// have no constructors); `initialize` remains for tooling that deploys without it.
    #[constructor]
    pub fn constructor(&mut self, owner: Address) -> Result<(), RegistryError> {
        self.init(owner)
    }

    /// One-time setup. Reverts `AlreadyInitialized` if an owner is already set (including via
    /// the constructor) and `ZeroAddress` for a zero owner.
    pub fn initialize(&mut self, owner: Address) -> Result<(), RegistryError> {
        self.init(owner)
    }

    /// Self-service: `msg.sender` (the provider's payout address) joins, or re-joins, the network.
    /// Re-registering updates `nodeId` and reactivates; counters and history are kept.
    pub fn register(&mut self, node_id: B256, metadata_uri: String) -> Result<(), RegistryError> {
        let provider = self.sender();
        self.register_impl(provider, node_id, metadata_uri)
    }

    /// Sponsored registration by the operator (or owner) so onboarding needs no provider gas.
    pub fn register_for(
        &mut self,
        provider: Address,
        node_id: B256,
        metadata_uri: String,
    ) -> Result<(), RegistryError> {
        self.only_operator_or_owner()?;
        self.register_impl(provider, node_id, metadata_uri)
    }

    /// `msg.sender` leaves the network. Its history is kept and it can re-register later.
    pub fn deactivate(&mut self) -> Result<(), RegistryError> {
        let provider = self.sender();
        let mut rec = self.providers.setter(provider);
        if rec.node_id.get().is_zero() {
            return Err(NotRegistered { provider }.into());
        }
        if !rec.active.get() {
            return Err(Inactive { provider }.into());
        }
        rec.active.set(false);
        drop(rec);
        self.vm().log(ProviderDeactivated { provider });
        Ok(())
    }

    /// Liveness ping from an active, registered `msg.sender`.
    pub fn heartbeat(&mut self) -> Result<(), RegistryError> {
        let provider = self.sender();
        self.heartbeat_impl(provider)
    }

    /// Liveness ping relayed by the operator (or owner) on a provider's behalf.
    pub fn heartbeat_for(&mut self, provider: Address) -> Result<(), RegistryError> {
        self.only_operator_or_owner()?;
        self.heartbeat_impl(provider)
    }

    /// Escrow-only: record a settled job. Creates the record if it does not exist (inactive,
    /// `nodeId == 0`, not counted in `providerCount`). Deactivated providers still accrue: the
    /// job was accepted while they were live and its outcome is part of their history.
    pub fn record_outcome(
        &mut self,
        provider: Address,
        success: bool,
        amount: U256,
    ) -> Result<(), RegistryError> {
        let caller = self.sender();
        // A zero escrow disables reporting: no caller is address(0).
        if caller != self.escrow.get() {
            return Err(Unauthorized { caller }.into());
        }
        if provider.is_zero() {
            return Err(ZeroAddress {}.into());
        }

        let now = self.now();
        let mut rec = self.providers.setter(provider);
        if rec.registered_at.get().is_zero() {
            rec.registered_at.set(U64::from(now));
        }
        let mut completed = u64_of(rec.completed.get());
        let mut failed = u64_of(rec.failed.get());
        if success {
            completed = completed.saturating_add(1);
            rec.completed.set(U64::from(completed));
            let earned = rec.earned.get().saturating_add(amount);
            rec.earned.set(earned);
        } else {
            failed = failed.saturating_add(1);
            rec.failed.set(U64::from(failed));
        }
        drop(rec);

        self.vm().log(OutcomeRecorded {
            provider,
            success,
            amount,
            completed,
            failed,
        });
        Ok(())
    }

    /// The full record, as `IXorvRegistry.Provider`. All zeros for an unknown address.
    pub fn get_provider(&self, provider: Address) -> ProviderTuple {
        let rec = self.providers.getter(provider);
        (
            rec.node_id.get(),
            u64_of(rec.registered_at.get()),
            u64_of(rec.last_seen.get()),
            u64_of(rec.completed.get()),
            u64_of(rec.failed.get()),
            rec.earned.get(),
            rec.active.get(),
        )
    }

    pub fn is_active(&self, provider: Address) -> bool {
        self.providers.getter(provider).active.get()
    }

    /// Laplace-smoothed success rate in basis points. 5000 with no history.
    pub fn score(&self, provider: Address) -> u32 {
        let rec = self.providers.getter(provider);
        laplace_score(u64_of(rec.completed.get()), u64_of(rec.failed.get()))
    }

    /// Number of distinct addresses that have ever registered.
    pub fn provider_count(&self) -> u64 {
        u64_of(self.provider_count.get())
    }

    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    pub fn escrow(&self) -> Address {
        self.escrow.get()
    }

    pub fn operator(&self) -> Address {
        self.operator.get()
    }

    /// Owner-only. Zero disables outcome reporting.
    pub fn set_escrow(&mut self, escrow: Address) -> Result<(), RegistryError> {
        self.only_owner()?;
        self.escrow.set(escrow);
        self.vm().log(EscrowUpdated { escrow });
        Ok(())
    }

    /// Owner-only. Zero disables sponsored registration and heartbeats.
    pub fn set_operator(&mut self, operator: Address) -> Result<(), RegistryError> {
        self.only_owner()?;
        self.operator.set(operator);
        self.vm().log(OperatorUpdated { operator });
        Ok(())
    }

    /// Owner-only. Rejects zero: renouncing would leave escrow/operator permanently frozen and
    /// would re-open `initialize` to anyone.
    pub fn transfer_ownership(&mut self, new_owner: Address) -> Result<(), RegistryError> {
        self.only_owner()?;
        if new_owner.is_zero() {
            return Err(ZeroAddress {}.into());
        }
        let previous_owner = self.owner.get();
        self.owner.set(new_owner);
        self.vm().log(OwnershipTransferred {
            previousOwner: previous_owner,
            newOwner: new_owner,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests;
