//! SwarmKit Exchange.
//!
//! One round:
//!   1. A coordinator opens a round with phase deadlines and a seller bond.
//!   2. Buyers join by sending the round's fungible token with `ft_transfer_call`
//!      (`msg = {"round_id":N,"quantity":"Q"}`). The amount sent is the buyer's budget, held in escrow.
//!   3. Sellers commit `sha256(["swarmkit-bid-v1", round_id, seller, capacity, unit_price, salt])`
//!      and attach the bond in NEAR.
//!   4. Sellers reveal. The contract checks each reveal against its commitment.
//!   5. Anyone calls `clear`. The contract runs `cheapest-capacity-v1`, the same rule as the
//!      SwarmKit SDK: offers by price then id, buyers by budget per unit, every buyer filled from the
//!      cheapest capacity, each line paid at its seller's price, never above a buyer's budget.
//!      If any buyer cannot be filled the round fails and every buyer is refunded.
//!   6. Buyers confirm delivered units (with a receipt hash). Each confirmed unit credits its seller.
//!   7. After the delivery deadline anyone calls `finalize`: undelivered units are refunded, sellers
//!      that delivered everything get their bond back, sellers that did not reveal or did not deliver
//!      lose their bond to the buyers they kept waiting or shorted.
//!
//! Money is never pushed in bulk. Every amount is credited to a balance that its owner withdraws.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PromiseOrValue};

pub const BID_DOMAIN: &str = "swarmkit-bid-v1";
pub const MECHANISM: &str = "cheapest-capacity-v1";
const MAX_BUYERS: usize = 40;
const MAX_SELLERS: usize = 10;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Open,
    Cleared,
    Failed,
    Finalized,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub buyer: AccountId,
    pub quantity: U128,
    pub budget: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Commitment {
    pub seller: AccountId,
    pub hash: String,
    pub bond: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Offer {
    pub seller: AccountId,
    pub capacity: U128,
    pub unit_price: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Line {
    pub buyer: AccountId,
    pub seller: AccountId,
    pub quantity: U128,
    pub unit_price: U128,
    pub delivered: U128,
    pub receipts: Vec<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Round {
    pub id: U64,
    pub coordinator: AccountId,
    pub resource: String,
    pub demand_end: U64,
    pub commit_end: U64,
    pub reveal_end: U64,
    pub delivery_end: U64,
    pub seller_bond: U128,
    pub status: Status,
    pub orders: Vec<Order>,
    pub commitments: Vec<Commitment>,
    pub offers: Vec<Offer>,
    pub lines: Vec<Line>,
    pub total: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Exchange {
    token: AccountId,
    rounds: Vector<Round>,
    token_balances: LookupMap<AccountId, u128>,
    near_balances: LookupMap<AccountId, u128>,
}

/// The SDK's `commitBid` preimage: JSON.stringify of a six-string array.
pub fn bid_preimage(round_id: u64, seller: &str, capacity: u128, unit_price: u128, salt: &str) -> String {
    serde_json::to_string(&[
        BID_DOMAIN.to_string(),
        round_id.to_string(),
        seller.to_string(),
        capacity.to_string(),
        unit_price.to_string(),
        salt.to_string(),
    ])
    .unwrap()
}

pub fn bid_hash(round_id: u64, seller: &str, capacity: u128, unit_price: u128, salt: &str) -> String {
    hex(&env::sha256(bid_preimage(round_id, seller, capacity, unit_price, salt).as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_digest(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `cheapest-capacity-v1`, line for line with `src/swarm/mechanism.ts`.
/// Returns (buyer, seller, quantity, unit_price) or None if any buyer cannot be filled within budget.
pub fn cheapest_capacity(orders: &[Order], offers: &[Offer]) -> Option<Vec<(AccountId, AccountId, u128, u128)>> {
    let mut inventory: Vec<(AccountId, u128, u128)> =
        offers.iter().map(|o| (o.seller.clone(), o.unit_price.0, o.capacity.0)).collect();
    inventory.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.as_str().cmp(b.0.as_str())));
    let mut ordered: Vec<&Order> = orders.iter().collect();
    ordered.sort_by(|a, b| {
        let left = a.budget.0.checked_mul(b.quantity.0).expect("overflow");
        let right = b.budget.0.checked_mul(a.quantity.0).expect("overflow");
        left.cmp(&right).then_with(|| a.buyer.as_str().cmp(b.buyer.as_str()))
    });
    let mut lines = Vec::new();
    for order in ordered {
        let mut remaining = order.quantity.0;
        let mut spent: u128 = 0;
        for (seller, price, left) in inventory.iter_mut() {
            let quantity = (*left).min(remaining);
            if quantity == 0 {
                continue;
            }
            lines.push((order.buyer.clone(), seller.clone(), quantity, *price));
            *left -= quantity;
            remaining -= quantity;
            spent = spent.checked_add(quantity.checked_mul(*price)?)?;
            if remaining == 0 {
                break;
            }
        }
        if remaining != 0 || spent > order.budget.0 {
            return None;
        }
    }
    Some(lines)
}

#[near]
impl Exchange {
    #[init]
    pub fn new(token: AccountId) -> Self {
        Self {
            token,
            rounds: Vector::new(b"r"),
            token_balances: LookupMap::new(b"t"),
            near_balances: LookupMap::new(b"n"),
        }
    }

    /// Phase lengths are in milliseconds from now. Returns the round id.
    pub fn open_round(
        &mut self,
        resource: String,
        demand_ms: U64,
        commit_ms: U64,
        reveal_ms: U64,
        delivery_ms: U64,
        seller_bond: U128,
    ) -> U64 {
        require!(!resource.is_empty() && resource.len() <= 128, "resource must be 1-128 bytes");
        require!(demand_ms.0 > 0 && commit_ms.0 > 0 && reveal_ms.0 > 0 && delivery_ms.0 > 0, "empty phase");
        let ms = 1_000_000u64;
        let demand_end = env::block_timestamp() + demand_ms.0 * ms;
        let commit_end = demand_end + commit_ms.0 * ms;
        let reveal_end = commit_end + reveal_ms.0 * ms;
        let id = self.rounds.len() as u64;
        self.rounds.push(Round {
            id: U64(id),
            coordinator: env::predecessor_account_id(),
            resource,
            demand_end: U64(demand_end),
            commit_end: U64(commit_end),
            reveal_end: U64(reveal_end),
            delivery_end: U64(reveal_end + delivery_ms.0 * ms),
            seller_bond,
            status: Status::Open,
            orders: vec![],
            commitments: vec![],
            offers: vec![],
            lines: vec![],
            total: U128(0),
        });
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"swarmkit\",\"version\":\"1\",\"event\":\"round_opened\",\"data\":{{\"round_id\":{id}}}}}"));
        U64(id)
    }

    /// NEP-141 receiver: a buyer joins a round. The whole amount is its budget.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "unsupported token");
        let request: serde_json::Value = serde_json::from_str(&msg).expect("msg must be JSON");
        let round_id = request["round_id"].as_u64().expect("round_id");
        let quantity: u128 = request["quantity"].as_str().and_then(|q| q.parse().ok()).expect("quantity");
        require!(quantity > 0 && amount.0 > 0, "empty order");
        let round = self.round_mut(round_id);
        require!(round.status == Status::Open && env::block_timestamp() < round.demand_end.0, "demand phase closed");
        require!(round.orders.iter().all(|o| o.buyer != sender_id), "buyer already joined");
        require!(round.orders.len() < MAX_BUYERS, "round is full");
        round.orders.push(Order { buyer: sender_id, quantity: U128(quantity), budget: amount });
        PromiseOrValue::Value(U128(0))
    }

    #[payable]
    pub fn commit(&mut self, round_id: U64, hash: String) {
        let seller = env::predecessor_account_id();
        let bond = env::attached_deposit().as_yoctonear();
        let round = self.round_mut(round_id.0);
        let now = env::block_timestamp();
        require!(round.status == Status::Open && now >= round.demand_end.0 && now < round.commit_end.0, "not in commit phase");
        require!(is_digest(&hash), "hash must be 64 lowercase hex");
        require!(bond == round.seller_bond.0, "attach exactly the seller bond");
        require!(round.commitments.iter().all(|c| c.seller != seller), "seller already committed");
        require!(round.commitments.len() < MAX_SELLERS, "round is full");
        round.commitments.push(Commitment { seller, hash, bond: U128(bond) });
    }

    pub fn reveal(&mut self, round_id: U64, capacity: U128, unit_price: U128, salt: String) {
        let seller = env::predecessor_account_id();
        require!(is_digest(&salt), "salt must be 64 lowercase hex");
        require!(capacity.0 > 0 && unit_price.0 > 0, "empty offer");
        let expected = bid_hash(round_id.0, seller.as_str(), capacity.0, unit_price.0, &salt);
        let round = self.round_mut(round_id.0);
        let now = env::block_timestamp();
        require!(round.status == Status::Open && now >= round.commit_end.0 && now < round.reveal_end.0, "not in reveal phase");
        let commitment = round.commitments.iter().find(|c| c.seller == seller).expect("no commitment");
        require!(commitment.hash == expected, "reveal does not match commitment");
        require!(round.offers.iter().all(|o| o.seller != seller), "already revealed");
        round.offers.push(Offer { seller, capacity, unit_price });
    }

    /// Anyone, after the reveal phase.
    pub fn clear(&mut self, round_id: U64) -> Status {
        let mut round = self.rounds.get(round_id.0 as u32).expect("no round").clone();
        require!(round.status == Status::Open && env::block_timestamp() >= round.reveal_end.0, "round not ready to clear");
        let allocation = if round.orders.is_empty() { None } else { cheapest_capacity(&round.orders, &round.offers) };
        match allocation {
            None => {
                round.status = Status::Failed;
                for order in round.orders.clone() {
                    self.credit_token(&order.buyer, order.budget.0);
                }
                self.release_bonds(&mut round, &[]);
            }
            Some(lines) => {
                let mut total = 0u128;
                for order in round.orders.clone() {
                    let spent: u128 = lines.iter().filter(|l| l.0 == order.buyer).map(|l| l.2 * l.3).sum();
                    self.credit_token(&order.buyer, order.budget.0 - spent);
                    total += spent;
                }
                round.lines = lines
                    .into_iter()
                    .map(|(buyer, seller, quantity, price)| Line {
                        buyer,
                        seller,
                        quantity: U128(quantity),
                        unit_price: U128(price),
                        delivered: U128(0),
                        receipts: vec![],
                    })
                    .collect();
                round.total = U128(total);
                round.status = Status::Cleared;
            }
        }
        let status = round.status;
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"swarmkit\",\"version\":\"1\",\"event\":\"round_cleared\",\"data\":{{\"round_id\":{},\"status\":\"{:?}\",\"total\":\"{}\",\"mechanism\":\"{MECHANISM}\"}}}}",
            round_id.0, status, round.total.0
        ));
        self.rounds.replace(round_id.0 as u32, round);
        status
    }

    /// The buyer confirms units delivered by one seller. Each unit credits the seller its price.
    pub fn confirm_delivery(&mut self, round_id: U64, seller: AccountId, units: U128, receipt: String) {
        let buyer = env::predecessor_account_id();
        require!(is_digest(&receipt), "receipt must be a sha256 hex digest");
        let round = self.round_mut(round_id.0);
        require!(round.status == Status::Cleared && env::block_timestamp() < round.delivery_end.0, "not in delivery phase");
        let line = round.lines.iter_mut().find(|l| l.buyer == buyer && l.seller == seller).expect("no such line");
        require!(units.0 > 0 && line.delivered.0 + units.0 <= line.quantity.0, "more than allocated");
        line.delivered = U128(line.delivered.0 + units.0);
        line.receipts.push(receipt);
        let amount = units.0 * line.unit_price.0;
        self.credit_token(&seller, amount);
    }

    /// Anyone, after the delivery deadline.
    pub fn finalize(&mut self, round_id: U64) {
        let mut round = self.rounds.get(round_id.0 as u32).expect("no round").clone();
        require!(round.status == Status::Cleared && env::block_timestamp() >= round.delivery_end.0, "round not ready to finalize");
        let mut shorted: Vec<(AccountId, AccountId)> = vec![];
        for line in round.lines.clone() {
            let missing = line.quantity.0 - line.delivered.0;
            if missing > 0 {
                self.credit_token(&line.buyer, missing * line.unit_price.0);
                shorted.push((line.seller.clone(), line.buyer.clone()));
            }
        }
        self.release_bonds(&mut round, &shorted);
        round.status = Status::Finalized;
        self.rounds.replace(round_id.0 as u32, round);
    }

    pub fn withdraw_token(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let amount = self.token_balances.remove(&account).unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        Promise::new(self.token.clone()).function_call(
            "ft_transfer".into(),
            serde_json::json!({"receiver_id": account, "amount": U128(amount)}).to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            near_sdk::Gas::from_tgas(15),
        )
    }

    pub fn withdraw_near(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let amount = self.near_balances.remove(&account).unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        Promise::new(account).transfer(NearToken::from_yoctonear(amount))
    }

    pub fn get_round(&self, round_id: U64) -> Option<Round> {
        self.rounds.get(round_id.0 as u32).cloned()
    }

    pub fn get_rounds(&self, from: U64, limit: U64) -> Vec<Round> {
        (from.0..(from.0 + limit.0.min(20)).min(self.rounds.len() as u64))
            .filter_map(|i| self.rounds.get(i as u32).cloned())
            .collect()
    }

    pub fn get_round_count(&self) -> U64 {
        U64(self.rounds.len() as u64)
    }

    pub fn get_balances(&self, account_id: AccountId) -> (U128, U128) {
        (
            U128(self.token_balances.get(&account_id).copied().unwrap_or(0)),
            U128(self.near_balances.get(&account_id).copied().unwrap_or(0)),
        )
    }

    pub fn get_token(&self) -> AccountId {
        self.token.clone()
    }
}

impl Exchange {
    fn round_mut(&mut self, id: u64) -> &mut Round {
        self.rounds.get_mut(id as u32).expect("no round")
    }

    fn credit_token(&mut self, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let balance = self.token_balances.get(account).copied().unwrap_or(0);
        self.token_balances.insert(account.clone(), balance + amount);
    }

    fn credit_near(&mut self, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let balance = self.near_balances.get(account).copied().unwrap_or(0);
        self.near_balances.insert(account.clone(), balance + amount);
    }

    /// Bonds go back to sellers that revealed and delivered in full. A seller that never revealed
    /// loses its bond to the round's buyers; a seller that shorted buyers loses it to those buyers.
    fn release_bonds(&mut self, round: &mut Round, shorted: &[(AccountId, AccountId)]) {
        let buyers: Vec<AccountId> = round.orders.iter().map(|o| o.buyer.clone()).collect();
        for commitment in round.commitments.clone() {
            let revealed = round.offers.iter().any(|o| o.seller == commitment.seller);
            let victims: Vec<AccountId> = if !revealed {
                buyers.clone()
            } else {
                shorted.iter().filter(|(s, _)| *s == commitment.seller).map(|(_, b)| b.clone()).collect()
            };
            if victims.is_empty() {
                self.credit_near(&commitment.seller, commitment.bond.0);
            } else {
                let share = commitment.bond.0 / victims.len() as u128;
                let dust = commitment.bond.0 - share * victims.len() as u128;
                for victim in &victims {
                    self.credit_near(victim, share);
                }
                self.credit_near(&victims[0], dust);
            }
        }
    }
}

#[cfg(test)]
mod tests;
