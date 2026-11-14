use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const MS: u64 = 1_000_000;
const BOND: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR

fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}

struct World {
    contract: Exchange,
    now: u64,
}

impl World {
    fn new() -> Self {
        let mut world = World { contract: Exchange::new(acct("wrap.testnet")), now: 1_000 * MS };
        world.as_("coordinator.testnet", 0);
        world.contract.open_round("1M inference tokens".into(), U64(10), U64(10), U64(10), U64(10), U128(BOND));
        world
    }
    fn as_(&mut self, who: &str, deposit: u128) -> &mut Exchange {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(self.now)
            .build());
        &mut self.contract
    }
    fn at(&mut self, ms_after_open: u64) -> &mut Self {
        self.now = 1_000 * MS + ms_after_open * MS;
        self
    }
    fn join(&mut self, buyer: &str, quantity: u128, budget: u128) {
        self.as_("wrap.testnet", 0)
            .ft_on_transfer(acct(buyer), U128(budget), format!("{{\"round_id\":0,\"quantity\":\"{quantity}\"}}"));
    }
    fn commit(&mut self, seller: &str, capacity: u128, price: u128) {
        let hash = bid_hash(0, seller, capacity, price, &salt(seller));
        self.as_(seller, BOND).commit(U64(0), hash);
    }
    fn reveal(&mut self, seller: &str, capacity: u128, price: u128) {
        self.as_(seller, 0).reveal(U64(0), U128(capacity), U128(price), salt(seller));
    }
    fn round(&self) -> Round {
        self.contract.get_round(U64(0)).unwrap()
    }
    fn balances(&self, who: &str) -> (u128, u128) {
        let (t, n) = self.contract.get_balances(acct(who));
        (t.0, n.0)
    }
}

fn salt(seller: &str) -> String {
    hex(&env::sha256(seller.as_bytes()))
}

/// Builds the standard round: 3 buyers, 3 sellers, the cheapest seller is too small to fill alone.
fn cleared_world() -> World {
    let mut w = World::new();
    w.at(1).join("buyer-1.testnet", 4, 1_000);
    w.join("buyer-2.testnet", 3, 600);
    w.join("buyer-3.testnet", 2, 500);
    w.at(11).commit("seller-1.testnet", 5, 100);
    w.commit("seller-2.testnet", 10, 150);
    w.commit("seller-3.testnet", 10, 400);
    w.at(21).reveal("seller-1.testnet", 5, 100);
    w.reveal("seller-2.testnet", 10, 150);
    w.reveal("seller-3.testnet", 10, 400);
    assert_eq!(w.at(31).as_("anyone.testnet", 0).clear(U64(0)), Status::Cleared);
    w
}

#[test]
fn commitment_matches_the_typescript_sdk() {
    testing_env!(VMContextBuilder::new().build());
    // node -e "import('./src/swarm/round.ts').then(async m=>console.log(await m.commitBid('7','seller-1.near',{capacity:'3',unitPrice:'200',salt:'ab'.repeat(32)})))"
    assert_eq!(
        bid_hash(7, "seller-1.near", 3, 200, &"ab".repeat(32)),
        "8ec9b6590d5abf6ec98e437ac5a7d1e1d35c588d582468d8e3c3dd0c01818733"
    );
}

#[test]
fn a_round_splits_demand_across_the_cheapest_capacity() {
    let w = cleared_world();
    let round = w.round();
    let lines: Vec<(String, String, u128, u128)> = round
        .lines
        .iter()
        .map(|l| (l.buyer.to_string(), l.seller.to_string(), l.quantity.0, l.unit_price.0))
        .collect();
    // Buyers ordered by budget per unit: buyer-2 (200), buyer-1 (250), buyer-3 (250, id tie-break).
    assert_eq!(
        lines,
        vec![
            ("buyer-2.testnet".into(), "seller-1.testnet".into(), 3, 100),
            ("buyer-1.testnet".into(), "seller-1.testnet".into(), 2, 100),
            ("buyer-1.testnet".into(), "seller-2.testnet".into(), 2, 150),
            ("buyer-3.testnet".into(), "seller-2.testnet".into(), 2, 150),
        ]
    );
    assert_eq!(round.total.0, 300 + 200 + 300 + 300);
    // Unspent budget is refunded at clearing.
    assert_eq!(w.balances("buyer-1.testnet").0, 1_000 - 500);
    assert_eq!(w.balances("buyer-2.testnet").0, 600 - 300);
    assert_eq!(w.balances("buyer-3.testnet").0, 500 - 300);
    // Sellers are paid only on delivery.
    assert_eq!(w.balances("seller-1.testnet").0, 0);
}

#[test]
fn delivery_pays_per_unit_and_finalize_refunds_and_slashes_the_shortfall() {
    let mut w = cleared_world();
    let receipt = "cd".repeat(32);
    w.at(32).as_("buyer-2.testnet", 0).confirm_delivery(U64(0), acct("seller-1.testnet"), U128(3), receipt.clone());
    w.as_("buyer-1.testnet", 0).confirm_delivery(U64(0), acct("seller-1.testnet"), U128(2), receipt.clone());
    w.as_("buyer-1.testnet", 0).confirm_delivery(U64(0), acct("seller-2.testnet"), U128(1), receipt.clone());
    assert_eq!(w.balances("seller-1.testnet").0, 500);
    assert_eq!(w.balances("seller-2.testnet").0, 150);
    w.at(41).as_("anyone.testnet", 0).finalize(U64(0));
    // seller-2 shorted buyer-1 by one unit and buyer-3 by two: both refunded, bond split between them.
    assert_eq!(w.balances("buyer-1.testnet").0, 500 + 150);
    assert_eq!(w.balances("buyer-3.testnet").0, 200 + 300);
    assert_eq!(w.balances("buyer-1.testnet").1 + w.balances("buyer-3.testnet").1, BOND);
    assert_eq!(w.balances("seller-1.testnet").1, BOND);
    assert_eq!(w.balances("seller-2.testnet").1, 0);
    // seller-3 revealed and was not needed: bond back.
    assert_eq!(w.balances("seller-3.testnet").1, BOND);
    assert_eq!(w.round().status, Status::Finalized);
}

#[test]
fn money_is_conserved() {
    let mut w = cleared_world();
    w.at(32).as_("buyer-2.testnet", 0).confirm_delivery(U64(0), acct("seller-1.testnet"), U128(3), "ef".repeat(32));
    w.at(41).as_("anyone.testnet", 0).finalize(U64(0));
    let tokens: u128 = ["buyer-1", "buyer-2", "buyer-3", "seller-1", "seller-2", "seller-3"]
        .iter()
        .map(|a| w.balances(&format!("{a}.testnet")).0)
        .sum();
    assert_eq!(tokens, 1_000 + 600 + 500);
    let bonds: u128 = ["buyer-1", "buyer-2", "buyer-3", "seller-1", "seller-2", "seller-3"]
        .iter()
        .map(|a| w.balances(&format!("{a}.testnet")).1)
        .sum();
    assert_eq!(bonds, 3 * BOND);
}

#[test]
fn a_round_that_cannot_fill_every_buyer_fails_and_refunds_everyone() {
    let mut w = World::new();
    w.at(1).join("buyer-1.testnet", 4, 1_000);
    w.at(11).commit("seller-1.testnet", 3, 100);
    w.at(21).reveal("seller-1.testnet", 3, 100);
    assert_eq!(w.at(31).as_("anyone.testnet", 0).clear(U64(0)), Status::Failed);
    assert_eq!(w.balances("buyer-1.testnet").0, 1_000);
    assert_eq!(w.balances("seller-1.testnet").1, BOND);
}

#[test]
fn a_seller_that_never_reveals_loses_its_bond_to_the_buyers() {
    let mut w = World::new();
    w.at(1).join("buyer-1.testnet", 2, 1_000);
    w.join("buyer-2.testnet", 2, 1_000);
    w.at(11).commit("seller-1.testnet", 10, 100);
    w.commit("seller-2.testnet", 10, 50);
    w.at(21).reveal("seller-1.testnet", 10, 100);
    w.at(31).as_("anyone.testnet", 0).clear(U64(0));
    assert_eq!(w.balances("buyer-1.testnet").1, BOND / 2);
    assert_eq!(w.balances("buyer-2.testnet").1, BOND / 2);
    assert_eq!(w.balances("seller-2.testnet").1, 0);
}

#[test]
fn a_budget_cap_is_never_exceeded() {
    let mut w = World::new();
    w.at(1).join("buyer-1.testnet", 4, 399);
    w.at(11).commit("seller-1.testnet", 10, 100);
    w.at(21).reveal("seller-1.testnet", 10, 100);
    assert_eq!(w.at(31).as_("anyone.testnet", 0).clear(U64(0)), Status::Failed);
    assert_eq!(w.balances("buyer-1.testnet").0, 399);
}

#[test]
#[should_panic(expected = "reveal does not match commitment")]
fn a_reveal_that_differs_from_the_commitment_is_rejected() {
    let mut w = World::new();
    w.at(11).commit("seller-1.testnet", 10, 100);
    w.at(21).reveal("seller-1.testnet", 10, 99);
}

#[test]
#[should_panic(expected = "not in commit phase")]
fn a_late_commitment_is_rejected() {
    let mut w = World::new();
    w.at(21).commit("seller-1.testnet", 10, 100);
}

#[test]
#[should_panic(expected = "attach exactly the seller bond")]
fn a_commitment_without_the_bond_is_rejected() {
    let mut w = World::new();
    let hash = bid_hash(0, "seller-1.testnet", 1, 1, &salt("seller-1.testnet"));
    w.at(11).as_("seller-1.testnet", 1).commit(U64(0), hash);
}

#[test]
#[should_panic(expected = "seller already committed")]
fn a_seller_commits_once() {
    let mut w = World::new();
    w.at(11).commit("seller-1.testnet", 10, 100);
    w.commit("seller-1.testnet", 10, 90);
}

#[test]
#[should_panic(expected = "unsupported token")]
fn only_the_round_token_is_accepted() {
    let mut w = World::new();
    w.at(1).as_("fake-usdc.testnet", 0).ft_on_transfer(acct("buyer-1.testnet"), U128(1), "{\"round_id\":0,\"quantity\":\"1\"}".into());
}

#[test]
#[should_panic(expected = "demand phase closed")]
fn a_late_buyer_is_rejected() {
    let mut w = World::new();
    w.at(11).join("buyer-1.testnet", 1, 100);
}

#[test]
#[should_panic(expected = "round not ready to clear")]
fn clearing_waits_for_the_reveal_deadline() {
    let mut w = World::new();
    w.at(21).as_("anyone.testnet", 0).clear(U64(0));
}

#[test]
#[should_panic(expected = "more than allocated")]
fn a_buyer_cannot_confirm_more_than_its_line() {
    let mut w = cleared_world();
    w.at(32).as_("buyer-3.testnet", 0).confirm_delivery(U64(0), acct("seller-2.testnet"), U128(3), "ab".repeat(32));
}

#[test]
#[should_panic(expected = "no such line")]
fn only_the_buyer_on_a_line_can_confirm_it() {
    let mut w = cleared_world();
    w.at(32).as_("seller-2.testnet", 0).confirm_delivery(U64(0), acct("seller-2.testnet"), U128(1), "ab".repeat(32));
}

#[test]
#[should_panic(expected = "round not ready to finalize")]
fn finalize_waits_for_the_delivery_deadline() {
    let mut w = cleared_world();
    w.at(35).as_("anyone.testnet", 0).finalize(U64(0));
}

/// The contract's allocation equals the SDK's on 2,000 seeded rounds
/// (fixtures from `node scripts/differential-fixtures.ts`).
#[test]
fn contract_clearing_equals_the_sdk_on_2000_seeded_rounds() {
    let rounds: serde_json::Value = serde_json::from_str(include_str!("fixtures/rounds.json")).unwrap();
    let mut cleared = 0;
    for (index, round) in rounds.as_array().unwrap().iter().enumerate() {
        let orders: Vec<Order> = round["buyers"].as_array().unwrap().iter().map(|b| Order {
            buyer: acct(b["buyerId"].as_str().unwrap()),
            quantity: U128(b["quantity"].as_str().unwrap().parse().unwrap()),
            budget: U128(b["budget"].as_str().unwrap().parse().unwrap()),
        }).collect();
        let offers: Vec<Offer> = round["offers"].as_array().unwrap().iter().map(|o| Offer {
            seller: acct(o["sellerId"].as_str().unwrap()),
            capacity: U128(o["capacity"].as_str().unwrap().parse().unwrap()),
            unit_price: U128(o["unitPrice"].as_str().unwrap().parse().unwrap()),
        }).collect();
        let ours = cheapest_capacity(&orders, &offers)
            .map(|lines| lines.into_iter().map(|(b, s, q, _)| (b.to_string(), s.to_string(), q.to_string())).collect::<Vec<_>>());
        let sdk = round["lines"].as_array().map(|lines| lines.iter().map(|l| (
            l["buyerId"].as_str().unwrap().to_string(),
            l["sellerId"].as_str().unwrap().to_string(),
            l["quantity"].as_str().unwrap().to_string(),
        )).collect::<Vec<_>>());
        assert_eq!(ours, sdk, "round {index} differs from the SDK");
        cleared += ours.is_some() as usize;
    }
    assert!(cleared > 100, "fixture should exercise many cleared rounds");
}
