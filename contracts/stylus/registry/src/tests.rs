//! Unit tests against the SDK's `TestVM` (a mocked Stylus host: storage, msg.sender, block
//! timestamp, emitted logs). Run with `cargo test`.

use super::*;
use alloy_primitives::{address, b256};
use alloy_sol_types::SolEvent;
use stylus_sdk::testing::*;

const OWNER: Address = address!("0x00000000000000000000000000000000000000A1");
const OPERATOR: Address = address!("0x00000000000000000000000000000000000000B2");
const ESCROW: Address = address!("0x00000000000000000000000000000000000000C3");
const ALICE: Address = address!("0x00000000000000000000000000000000000000D4");
const BOB: Address = address!("0x00000000000000000000000000000000000000E5");
const MALLORY: Address = address!("0x00000000000000000000000000000000000000F6");

const NODE_A: B256 = b256!("0x1111111111111111111111111111111111111111111111111111111111111111");
const NODE_B: B256 = b256!("0x2222222222222222222222222222222222222222222222222222222222222222");

const T0: u64 = 1_700_000_000;

// ---------------------------------------------------------------- helpers

/// A registry initialized by OWNER, with ESCROW and OPERATOR configured, clock at T0.
fn setup() -> (TestVM, XorvRegistry) {
    let vm = TestVM::default();
    vm.set_block_timestamp(T0);
    let mut c = XorvRegistry::from(&vm);
    as_(&vm, OWNER);
    c.initialize(OWNER).unwrap();
    c.set_escrow(ESCROW).unwrap();
    c.set_operator(OPERATOR).unwrap();
    (vm, c)
}

fn as_(vm: &TestVM, who: Address) {
    vm.set_sender(who);
}

fn uri(s: &str) -> String {
    String::from(s)
}

fn unauthorized(caller: Address) -> RegistryError {
    Unauthorized { caller }.into()
}

/// The most recent log, as (topics, data).
fn last_log(vm: &TestVM) -> (Vec<B256>, Vec<u8>) {
    vm.get_emitted_logs()
        .last()
        .cloned()
        .expect("no log emitted")
}

fn assert_last_log<E: SolEvent>(vm: &TestVM, event: E) {
    let expected = event.encode_log_data();
    let (topics, data) = last_log(vm);
    assert_eq!(
        topics,
        expected.topics().to_vec(),
        "topics of {}",
        E::SIGNATURE
    );
    assert_eq!(data, expected.data.to_vec(), "data of {}", E::SIGNATURE);
}

fn log_count(vm: &TestVM) -> usize {
    vm.get_emitted_logs().len()
}

fn record(provider: Address, success: bool, amount: u64, c: &mut XorvRegistry, vm: &TestVM) {
    as_(vm, ESCROW);
    c.record_outcome(provider, success, U256::from(amount))
        .unwrap();
}

// ---------------------------------------------------------------- initialization

#[test]
fn initialize_sets_owner_and_emits() {
    let vm = TestVM::default();
    let mut c = XorvRegistry::from(&vm);
    assert_eq!(c.owner(), Address::ZERO);
    as_(&vm, MALLORY); // anyone may initialize an uninitialized registry...
    c.initialize(OWNER).unwrap();
    assert_eq!(c.owner(), OWNER); // ...but only to set the owner it is given
    assert_last_log(
        &vm,
        OwnershipTransferred {
            previousOwner: Address::ZERO,
            newOwner: OWNER,
        },
    );
}

#[test]
fn initialize_only_once() {
    let (vm, mut c) = setup();
    as_(&vm, OWNER);
    assert_eq!(c.initialize(OWNER), Err(AlreadyInitialized {}.into()));
    as_(&vm, MALLORY);
    assert_eq!(c.initialize(MALLORY), Err(AlreadyInitialized {}.into()));
    assert_eq!(c.owner(), OWNER);
}

#[test]
fn initialize_rejects_zero_owner() {
    let vm = TestVM::default();
    let mut c = XorvRegistry::from(&vm);
    assert_eq!(c.initialize(Address::ZERO), Err(ZeroAddress {}.into()));
    assert_eq!(c.owner(), Address::ZERO);
    c.initialize(OWNER).unwrap(); // a failed attempt does not consume the one-time init
}

#[test]
fn constructor_initializes_and_blocks_initialize() {
    let vm = TestVM::default();
    let mut c = XorvRegistry::from(&vm);
    c.constructor(OWNER).unwrap();
    assert_eq!(c.owner(), OWNER);
    as_(&vm, MALLORY);
    assert_eq!(c.initialize(MALLORY), Err(AlreadyInitialized {}.into()));
    assert_eq!(c.constructor(MALLORY), Err(AlreadyInitialized {}.into()));
}

#[test]
fn constructor_rejects_zero_owner() {
    let vm = TestVM::default();
    let mut c = XorvRegistry::from(&vm);
    assert_eq!(c.constructor(Address::ZERO), Err(ZeroAddress {}.into()));
}

#[test]
fn fresh_registry_defaults() {
    let vm = TestVM::default();
    let c = XorvRegistry::from(&vm);
    assert_eq!(c.escrow(), Address::ZERO);
    assert_eq!(c.operator(), Address::ZERO);
    assert_eq!(c.provider_count(), 0);
    assert_eq!(
        c.get_provider(ALICE),
        (B256::ZERO, 0, 0, 0, 0, U256::ZERO, false)
    );
    assert!(!c.is_active(ALICE));
    assert_eq!(c.score(ALICE), 5000);
}

// ---------------------------------------------------------------- register

#[test]
fn register_creates_record_and_counts() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("ipfs://alice")).unwrap();

    assert_eq!(
        c.get_provider(ALICE),
        (NODE_A, T0, T0, 0, 0, U256::ZERO, true)
    );
    assert!(c.is_active(ALICE));
    assert_eq!(c.provider_count(), 1);
    assert_last_log(
        &vm,
        ProviderRegistered {
            provider: ALICE,
            nodeId: NODE_A,
            metadataUri: uri("ipfs://alice"),
        },
    );
}

#[test]
fn register_rejects_zero_node_id() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    assert_eq!(
        c.register(B256::ZERO, uri("")),
        Err(InvalidNodeId {}.into())
    );
    assert_eq!(c.provider_count(), 0);
    assert!(!c.is_active(ALICE));
}

#[test]
fn register_metadata_length_cap() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    let at_cap = "a".repeat(MAX_METADATA_LEN);
    c.register(NODE_A, at_cap).unwrap();

    as_(&vm, BOB);
    let over = "b".repeat(MAX_METADATA_LEN + 1);
    assert_eq!(
        c.register(NODE_B, over),
        Err(MetadataTooLong {
            length: U256::from(MAX_METADATA_LEN + 1)
        }
        .into())
    );
    assert_eq!(c.provider_count(), 1);
}

#[test]
fn metadata_cap_counts_bytes_not_chars() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    // 129 two-byte chars = 258 bytes > 256, though only 129 chars.
    let s = "é".repeat(129);
    assert_eq!(
        c.register(NODE_A, s),
        Err(MetadataTooLong {
            length: U256::from(258)
        }
        .into())
    );
}

#[test]
fn reregister_active_updates_node_keeps_counters() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("v1")).unwrap();
    record(ALICE, true, 700, &mut c, &vm);
    record(ALICE, false, 0, &mut c, &vm);

    vm.set_block_timestamp(T0 + 100);
    as_(&vm, ALICE);
    c.register(NODE_B, uri("v2")).unwrap();

    assert_eq!(
        c.get_provider(ALICE),
        (NODE_B, T0, T0 + 100, 1, 1, U256::from(700), true)
    );
    assert_eq!(
        c.provider_count(),
        1,
        "re-registration is not a new provider"
    );
    assert_last_log(
        &vm,
        ProviderRegistered {
            provider: ALICE,
            nodeId: NODE_B,
            metadataUri: uri("v2"),
        },
    );
}

#[test]
fn reregister_deactivated_reactivates() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();
    c.deactivate().unwrap();
    assert!(!c.is_active(ALICE));

    vm.set_block_timestamp(T0 + 50);
    c.register(NODE_A, uri("back")).unwrap();
    assert!(c.is_active(ALICE));
    assert_eq!(
        c.get_provider(ALICE),
        (NODE_A, T0, T0 + 50, 0, 0, U256::ZERO, true)
    );
    assert_eq!(c.provider_count(), 1);
}

#[test]
fn provider_count_counts_distinct_addresses() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();
    c.register(NODE_A, uri("")).unwrap();
    as_(&vm, BOB);
    c.register(NODE_B, uri("")).unwrap();
    as_(&vm, OPERATOR);
    c.register_for(BOB, NODE_B, uri("")).unwrap();
    assert_eq!(c.provider_count(), 2);
}

// ---------------------------------------------------------------- registerFor

#[test]
fn register_for_by_operator_and_owner() {
    let (vm, mut c) = setup();
    as_(&vm, OPERATOR);
    c.register_for(ALICE, NODE_A, uri("sponsored")).unwrap();
    assert!(c.is_active(ALICE));
    assert!(
        !c.is_active(OPERATOR),
        "the record belongs to the provider, not the caller"
    );
    assert_last_log(
        &vm,
        ProviderRegistered {
            provider: ALICE,
            nodeId: NODE_A,
            metadataUri: uri("sponsored"),
        },
    );

    as_(&vm, OWNER);
    c.register_for(BOB, NODE_B, uri("")).unwrap();
    assert!(c.is_active(BOB));
    assert_eq!(c.provider_count(), 2);
}

#[test]
fn register_for_unauthorized() {
    let (vm, mut c) = setup();
    for who in [MALLORY, ALICE, ESCROW] {
        as_(&vm, who);
        assert_eq!(
            c.register_for(ALICE, NODE_A, uri("")),
            Err(unauthorized(who))
        );
    }
    assert_eq!(c.provider_count(), 0);
}

#[test]
fn register_for_rejects_zero_provider_and_node() {
    let (vm, mut c) = setup();
    as_(&vm, OPERATOR);
    assert_eq!(
        c.register_for(Address::ZERO, NODE_A, uri("")),
        Err(ZeroAddress {}.into())
    );
    assert_eq!(
        c.register_for(ALICE, B256::ZERO, uri("")),
        Err(InvalidNodeId {}.into())
    );
}

#[test]
fn register_for_with_operator_disabled() {
    let (vm, mut c) = setup();
    as_(&vm, OWNER);
    c.set_operator(Address::ZERO).unwrap();
    as_(&vm, OPERATOR);
    assert_eq!(
        c.register_for(ALICE, NODE_A, uri("")),
        Err(unauthorized(OPERATOR))
    );
    as_(&vm, OWNER);
    c.register_for(ALICE, NODE_A, uri("")).unwrap(); // owner still can
}

// ---------------------------------------------------------------- deactivate

#[test]
fn deactivate_keeps_history() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();
    record(ALICE, true, 5, &mut c, &vm);

    as_(&vm, ALICE);
    c.deactivate().unwrap();
    assert_last_log(&vm, ProviderDeactivated { provider: ALICE });
    assert_eq!(
        c.get_provider(ALICE),
        (NODE_A, T0, T0, 1, 0, U256::from(5), false)
    );
    assert_eq!(c.provider_count(), 1);
}

#[test]
fn deactivate_unregistered_reverts() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    assert_eq!(
        c.deactivate(),
        Err(NotRegistered { provider: ALICE }.into())
    );
}

#[test]
fn deactivate_record_created_by_escrow_only_reverts() {
    let (vm, mut c) = setup();
    record(ALICE, true, 1, &mut c, &vm);
    as_(&vm, ALICE);
    assert_eq!(
        c.deactivate(),
        Err(NotRegistered { provider: ALICE }.into())
    );
}

#[test]
fn deactivate_twice_reverts() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();
    c.deactivate().unwrap();
    let logs = log_count(&vm);
    assert_eq!(c.deactivate(), Err(Inactive { provider: ALICE }.into()));
    assert_eq!(log_count(&vm), logs, "no duplicate event");
}

// ---------------------------------------------------------------- heartbeat

#[test]
fn heartbeat_updates_last_seen() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();
    vm.set_block_timestamp(T0 + 60);
    c.heartbeat().unwrap();
    let (_, registered_at, last_seen, ..) = c.get_provider(ALICE);
    assert_eq!((registered_at, last_seen), (T0, T0 + 60));
    assert_last_log(
        &vm,
        Heartbeat {
            provider: ALICE,
            timestamp: T0 + 60,
        },
    );
}

#[test]
fn heartbeat_requires_registered() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    assert_eq!(c.heartbeat(), Err(NotRegistered { provider: ALICE }.into()));
}

#[test]
fn heartbeat_requires_active() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();
    c.deactivate().unwrap();
    assert_eq!(c.heartbeat(), Err(Inactive { provider: ALICE }.into()));
}

#[test]
fn heartbeat_for_by_operator_and_owner() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();

    vm.set_block_timestamp(T0 + 10);
    as_(&vm, OPERATOR);
    c.heartbeat_for(ALICE).unwrap();
    assert_last_log(
        &vm,
        Heartbeat {
            provider: ALICE,
            timestamp: T0 + 10,
        },
    );

    vm.set_block_timestamp(T0 + 20);
    as_(&vm, OWNER);
    c.heartbeat_for(ALICE).unwrap();
    assert_eq!(c.get_provider(ALICE).2, T0 + 20);
}

#[test]
fn heartbeat_for_unauthorized() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();
    for who in [MALLORY, ALICE, ESCROW] {
        as_(&vm, who);
        assert_eq!(c.heartbeat_for(ALICE), Err(unauthorized(who)));
    }
}

#[test]
fn heartbeat_for_checks_provider_state() {
    let (vm, mut c) = setup();
    as_(&vm, OPERATOR);
    assert_eq!(
        c.heartbeat_for(BOB),
        Err(NotRegistered { provider: BOB }.into())
    );
    c.register_for(BOB, NODE_B, uri("")).unwrap();
    as_(&vm, BOB);
    c.deactivate().unwrap();
    as_(&vm, OPERATOR);
    assert_eq!(c.heartbeat_for(BOB), Err(Inactive { provider: BOB }.into()));
}

// ---------------------------------------------------------------- recordOutcome

#[test]
fn record_outcome_success_and_failure() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();

    record(ALICE, true, 1_000_000, &mut c, &vm);
    assert_last_log(
        &vm,
        OutcomeRecorded {
            provider: ALICE,
            success: true,
            amount: U256::from(1_000_000),
            completed: 1,
            failed: 0,
        },
    );

    record(ALICE, false, 250_000, &mut c, &vm);
    assert_last_log(
        &vm,
        OutcomeRecorded {
            provider: ALICE,
            success: false,
            amount: U256::from(250_000),
            completed: 1,
            failed: 1,
        },
    );

    record(ALICE, true, 500_000, &mut c, &vm);
    let (node, reg, seen, completed, failed, earned, active) = c.get_provider(ALICE);
    assert_eq!((node, reg, seen, active), (NODE_A, T0, T0, true));
    assert_eq!((completed, failed), (2, 1));
    assert_eq!(
        earned,
        U256::from(1_500_000),
        "refunds do not count as earnings"
    );
}

#[test]
fn record_outcome_only_escrow() {
    let (vm, mut c) = setup();
    for who in [MALLORY, OWNER, OPERATOR, ALICE] {
        as_(&vm, who);
        assert_eq!(
            c.record_outcome(ALICE, true, U256::from(1)),
            Err(unauthorized(who))
        );
    }
    assert_eq!(
        c.get_provider(ALICE),
        (B256::ZERO, 0, 0, 0, 0, U256::ZERO, false)
    );
}

#[test]
fn record_outcome_disabled_when_escrow_zero() {
    let (vm, mut c) = setup();
    as_(&vm, OWNER);
    c.set_escrow(Address::ZERO).unwrap();
    as_(&vm, ESCROW);
    assert_eq!(
        c.record_outcome(ALICE, true, U256::from(1)),
        Err(unauthorized(ESCROW))
    );
}

#[test]
fn record_outcome_rejects_zero_provider() {
    let (vm, mut c) = setup();
    as_(&vm, ESCROW);
    assert_eq!(
        c.record_outcome(Address::ZERO, true, U256::from(1)),
        Err(ZeroAddress {}.into())
    );
}

#[test]
fn record_outcome_creates_unregistered_record() {
    let (vm, mut c) = setup();
    vm.set_block_timestamp(T0 + 5);
    record(BOB, true, 42, &mut c, &vm);
    assert_eq!(
        c.get_provider(BOB),
        (B256::ZERO, T0 + 5, 0, 1, 0, U256::from(42), false)
    );
    assert!(!c.is_active(BOB));
    assert_eq!(
        c.provider_count(),
        0,
        "outcomes alone do not count as registration"
    );

    // Registering later keeps the original creation time and the history, and now counts.
    vm.set_block_timestamp(T0 + 9);
    as_(&vm, BOB);
    c.register(NODE_B, uri("")).unwrap();
    assert_eq!(
        c.get_provider(BOB),
        (NODE_B, T0 + 5, T0 + 9, 1, 0, U256::from(42), true)
    );
    assert_eq!(c.provider_count(), 1);
}

#[test]
fn record_outcome_on_deactivated_provider_still_accrues() {
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();
    c.deactivate().unwrap();
    record(ALICE, true, 10, &mut c, &vm);
    let p = c.get_provider(ALICE);
    assert_eq!(
        (p.3, p.5, p.6),
        (1, U256::from(10), false),
        "stays inactive"
    );
}

#[test]
fn record_outcome_zero_amount_success() {
    let (vm, mut c) = setup();
    record(ALICE, true, 0, &mut c, &vm);
    let p = c.get_provider(ALICE);
    assert_eq!((p.3, p.4, p.5), (1, 0, U256::ZERO));
}

#[test]
fn earned_saturates_instead_of_reverting() {
    let (vm, mut c) = setup();
    as_(&vm, ESCROW);
    c.record_outcome(ALICE, true, U256::MAX - U256::from(1))
        .unwrap();
    c.record_outcome(ALICE, true, U256::from(10)).unwrap();
    assert_eq!(c.get_provider(ALICE).5, U256::MAX);
    c.record_outcome(ALICE, true, U256::MAX).unwrap();
    assert_eq!(c.get_provider(ALICE).5, U256::MAX);
    assert_eq!(c.get_provider(ALICE).3, 3);
}

// ---------------------------------------------------------------- score

#[test]
fn score_formula() {
    let (vm, mut c) = setup();
    assert_eq!(c.score(ALICE), 5000, "no history: (0+1)*10000/(0+0+2)");

    record(ALICE, true, 1, &mut c, &vm);
    assert_eq!(c.score(ALICE), 6666, "2*10000/3");

    record(ALICE, false, 0, &mut c, &vm);
    assert_eq!(c.score(ALICE), 5000, "2*10000/4");

    for _ in 0..8 {
        record(ALICE, true, 1, &mut c, &vm);
    }
    assert_eq!(c.score(ALICE), 8333, "(9+1)*10000/(9+1+2)");

    record(BOB, false, 0, &mut c, &vm);
    assert_eq!(c.score(BOB), 3333, "1*10000/3");
}

#[test]
fn laplace_score_edge_cases() {
    assert_eq!(laplace_score(0, 0), 5000);
    assert_eq!(laplace_score(1, 0), 6666);
    assert_eq!(laplace_score(0, 1), 3333);
    assert_eq!(laplace_score(1_000_000, 0), 9999, "never jumps to 100%");
    assert_eq!(laplace_score(0, 1_000_000), 0);
    // Extremes must not overflow and must stay in range.
    assert_eq!(laplace_score(u64::MAX, 0), 9999);
    assert_eq!(laplace_score(0, u64::MAX), 0);
    assert_eq!(laplace_score(u64::MAX, u64::MAX), 5000);
    assert_eq!(laplace_score(u64::MAX - 1, u64::MAX), 4999);
}

#[test]
fn score_is_bounded_for_all_small_inputs() {
    for completed in 0..60u64 {
        for failed in 0..60u64 {
            let s = laplace_score(completed, failed);
            assert!(s > 0 && s < 10_000, "({completed},{failed}) -> {s}");
            let exact = (completed + 1) * 10_000 / (completed + failed + 2);
            assert_eq!(s as u64, exact);
        }
    }
}

// ---------------------------------------------------------------- admin

#[test]
fn set_escrow_and_operator_emit() {
    let (vm, mut c) = setup();
    as_(&vm, OWNER);
    c.set_escrow(BOB).unwrap();
    assert_eq!(c.escrow(), BOB);
    assert_last_log(&vm, EscrowUpdated { escrow: BOB });
    c.set_operator(ALICE).unwrap();
    assert_eq!(c.operator(), ALICE);
    assert_last_log(&vm, OperatorUpdated { operator: ALICE });
    c.set_escrow(Address::ZERO).unwrap();
    c.set_operator(Address::ZERO).unwrap();
    assert_eq!((c.escrow(), c.operator()), (Address::ZERO, Address::ZERO));
}

#[test]
fn admin_functions_only_owner() {
    let (vm, mut c) = setup();
    for who in [MALLORY, OPERATOR, ESCROW, ALICE] {
        as_(&vm, who);
        assert_eq!(c.set_escrow(who), Err(unauthorized(who)));
        assert_eq!(c.set_operator(who), Err(unauthorized(who)));
        assert_eq!(c.transfer_ownership(who), Err(unauthorized(who)));
    }
    assert_eq!(
        (c.owner(), c.escrow(), c.operator()),
        (OWNER, ESCROW, OPERATOR)
    );
}

#[test]
fn admin_functions_locked_before_initialize() {
    let vm = TestVM::default();
    let mut c = XorvRegistry::from(&vm);
    as_(&vm, MALLORY);
    assert_eq!(c.set_escrow(MALLORY), Err(unauthorized(MALLORY)));
    assert_eq!(c.set_operator(MALLORY), Err(unauthorized(MALLORY)));
    assert_eq!(c.transfer_ownership(MALLORY), Err(unauthorized(MALLORY)));
}

#[test]
fn transfer_ownership_moves_control() {
    let (vm, mut c) = setup();
    as_(&vm, OWNER);
    c.transfer_ownership(BOB).unwrap();
    assert_eq!(c.owner(), BOB);
    assert_last_log(
        &vm,
        OwnershipTransferred {
            previousOwner: OWNER,
            newOwner: BOB,
        },
    );

    assert_eq!(
        c.set_escrow(OWNER),
        Err(unauthorized(OWNER)),
        "old owner lost control"
    );
    assert_eq!(
        c.register_for(ALICE, NODE_A, uri("")),
        Err(unauthorized(OWNER))
    );
    as_(&vm, BOB);
    c.set_escrow(ALICE).unwrap();
    c.register_for(ALICE, NODE_A, uri("")).unwrap();
    assert_eq!(c.initialize(MALLORY), Err(AlreadyInitialized {}.into()));
}

#[test]
fn transfer_ownership_rejects_zero() {
    let (vm, mut c) = setup();
    as_(&vm, OWNER);
    assert_eq!(
        c.transfer_ownership(Address::ZERO),
        Err(ZeroAddress {}.into())
    );
    assert_eq!(c.owner(), OWNER);
}

// ---------------------------------------------------------------- reverts leave no trace

#[test]
fn failed_calls_emit_nothing() {
    let (vm, mut c) = setup();
    let before = log_count(&vm);
    as_(&vm, MALLORY);
    let _ = c.record_outcome(ALICE, true, U256::from(1));
    let _ = c.register_for(ALICE, NODE_A, uri(""));
    let _ = c.heartbeat();
    let _ = c.deactivate();
    let _ = c.set_escrow(MALLORY);
    let _ = c.register(B256::ZERO, uri(""));
    assert_eq!(log_count(&vm), before);
}

// ---------------------------------------------------------------- ABI encoding of errors

#[test]
fn errors_encode_as_solidity_custom_errors() {
    use alloy_sol_types::SolError;
    let encoded: Vec<u8> = RegistryError::from(Unauthorized { caller: MALLORY }).into();
    assert_eq!(&encoded[..4], &Unauthorized::SELECTOR);
    assert_eq!(
        &encoded[..4],
        &alloy_primitives::keccak256("Unauthorized(address)")[..4]
    );
    assert_eq!(encoded.len(), 4 + 32);

    let encoded: Vec<u8> = RegistryError::from(AlreadyInitialized {}).into();
    assert_eq!(
        encoded,
        alloy_primitives::keccak256("AlreadyInitialized()")[..4].to_vec()
    );

    let encoded: Vec<u8> = RegistryError::from(MetadataTooLong {
        length: U256::from(300),
    })
    .into();
    assert_eq!(
        &encoded[..4],
        &alloy_primitives::keccak256("MetadataTooLong(uint256)")[..4]
    );
}

#[test]
fn event_signatures_match_interface() {
    use alloy_primitives::keccak256;
    assert_eq!(
        ProviderRegistered::SIGNATURE_HASH,
        keccak256("ProviderRegistered(address,bytes32,string)")
    );
    assert_eq!(
        ProviderDeactivated::SIGNATURE_HASH,
        keccak256("ProviderDeactivated(address)")
    );
    assert_eq!(
        Heartbeat::SIGNATURE_HASH,
        keccak256("Heartbeat(address,uint64)")
    );
    assert_eq!(
        OutcomeRecorded::SIGNATURE_HASH,
        keccak256("OutcomeRecorded(address,bool,uint256,uint64,uint64)")
    );
    assert_eq!(
        EscrowUpdated::SIGNATURE_HASH,
        keccak256("EscrowUpdated(address)")
    );
    assert_eq!(
        OperatorUpdated::SIGNATURE_HASH,
        keccak256("OperatorUpdated(address)")
    );
    assert_eq!(
        OwnershipTransferred::SIGNATURE_HASH,
        keccak256("OwnershipTransferred(address,address)")
    );
}

// ---------------------------------------------------------------- storage layout

/// The layout is Solidity's: `owner`+`providerCount` share slot 0, `escrow` 1, `operator` 2,
/// `providers` mapping at 3 with records at keccak256(pad(provider) . 3), and the four `uint64`s
/// of a record packed low-to-high in its second slot. A Solidity reimplementation (or an
/// off-chain indexer reading raw storage) would see the same bytes.
#[test]
fn storage_layout_matches_solidity() {
    use alloy_primitives::keccak256;
    let (vm, mut c) = setup();
    as_(&vm, ALICE);
    c.register(NODE_A, uri("")).unwrap();
    vm.set_block_timestamp(T0 + 7);
    c.heartbeat().unwrap();
    record(ALICE, true, 99, &mut c, &vm);
    record(ALICE, false, 0, &mut c, &vm);
    record(ALICE, false, 0, &mut c, &vm);

    // slot 0: providerCount (bytes 20..28 from the right) | owner (low 20 bytes)
    let slot0 = U256::from_be_bytes(vm.get_storage(U256::ZERO).0);
    let expected0 = (U256::from(1u64) << 160) | U256::from_be_slice(OWNER.as_slice());
    assert_eq!(slot0, expected0);
    assert_eq!(
        vm.get_storage(U256::from(1)),
        B256::left_padding_from(ESCROW.as_slice())
    );
    assert_eq!(
        vm.get_storage(U256::from(2)),
        B256::left_padding_from(OPERATOR.as_slice())
    );

    let mut preimage = [0u8; 64];
    preimage[12..32].copy_from_slice(ALICE.as_slice());
    preimage[63] = 3;
    let base = U256::from_be_bytes(keccak256(preimage).0);

    assert_eq!(vm.get_storage(base), NODE_A);
    let packed = U256::from_be_bytes(vm.get_storage(base + U256::from(1)).0);
    let expected = U256::from(T0)
        | (U256::from(T0 + 7) << 64)
        | (U256::from(1u64) << 128)
        | (U256::from(2u64) << 192);
    assert_eq!(
        packed, expected,
        "registeredAt | lastSeen | completed | failed in one slot"
    );
    assert_eq!(
        U256::from_be_bytes(vm.get_storage(base + U256::from(2)).0),
        U256::from(99)
    );
    assert_eq!(
        U256::from_be_bytes(vm.get_storage(base + U256::from(3)).0),
        U256::from(1)
    );
    assert_eq!(
        vm.get_storage(base + U256::from(4)),
        B256::ZERO,
        "a record is exactly 4 slots"
    );
}
