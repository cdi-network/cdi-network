/**
 * Tests for GovernanceStore, Proposal, and TestnetFaucet.
 * Run: node browser/governance/governance.test.js
 */

import { GovernanceStore } from './GovernanceStore.js';
import { Proposal, PROPOSAL_STATUS } from './Proposal.js';
import { TestnetFaucet, TESTNET_REWARDS, MAX_PER_NODE } from '../testnet/TestnetFaucet.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── Proposal Tests ────────────────────────────────────────────────────

describe('Proposal', () => {
    it('should create a proposal with correct initial state', () => {
        const p = new Proposal('peer-A', 'abc123', 'Add WebGPU support', 86400000);
        assert.ok(p.id);
        assert.equal(p.proposerId, 'peer-A');
        assert.equal(p.upgradeHash, 'abc123');
        assert.equal(p.status, PROPOSAL_STATUS.ACTIVE);
        assert.equal(p.passedAt, null);
    });

    it('should accept yes/no votes', () => {
        const p = new Proposal('peer-A', 'abc123', 'test', 86400000);
        p.castVote('voter-1', 'yes', 100);
        p.castVote('voter-2', 'no', 50);
        const t = p.tally();
        assert.equal(t.yes, 100);
        assert.equal(t.no, 50);
        assert.equal(t.voters, 2);
    });

    it('should reject invalid votes', () => {
        const p = new Proposal('peer-A', 'abc123', 'test', 86400000);
        assert.throws(() => p.castVote('voter-1', 'maybe', 10));
    });

    it('should reject zero-weight votes', () => {
        const p = new Proposal('peer-A', 'abc123', 'test', 86400000);
        assert.throws(() => p.castVote('voter-1', 'yes', 0));
    });

    it('should allow vote updates (last vote wins)', () => {
        const p = new Proposal('peer-A', 'abc123', 'test', 86400000);
        p.castVote('voter-1', 'yes', 100);
        p.castVote('voter-1', 'no', 200); // changes mind
        const t = p.tally();
        assert.equal(t.yes, 0);
        assert.equal(t.no, 200);
        assert.equal(t.voters, 1);
    });

    it('should not accept votes on non-active proposal', () => {
        const p = new Proposal('peer-A', 'abc123', 'test', 86400000);
        p.pass();
        assert.throws(() => p.castVote('voter-1', 'yes', 100));
    });

    it('should transition: active → passed → executed', () => {
        const p = new Proposal('peer-A', 'abc123', 'test', 86400000);
        assert.equal(p.status, PROPOSAL_STATUS.ACTIVE);
        p.pass();
        assert.equal(p.status, PROPOSAL_STATUS.PASSED);
        assert.ok(p.passedAt > 0);
        p.execute();
        assert.equal(p.status, PROPOSAL_STATUS.EXECUTED);
        assert.ok(p.executedAt > 0);
    });
});

// ── GovernanceStore Tests ─────────────────────────────────────────────

describe('GovernanceStore', () => {
    it('should submit and retrieve proposals', () => {
        const gov = new GovernanceStore();
        const p = gov.submitProposal('peer-A', 'hash123', 'Upgrade v2.0');
        assert.ok(p.id);
        assert.equal(gov.getProposal(p.id).changelog, 'Upgrade v2.0');
    });

    it('should list active proposals', () => {
        const gov = new GovernanceStore();
        gov.submitProposal('peer-A', 'h1', 'First');
        gov.submitProposal('peer-B', 'h2', 'Second');
        assert.equal(gov.listProposals(PROPOSAL_STATUS.ACTIVE).length, 2);
    });

    it('should handle stake-weighted voting and quorum', () => {
        const gov = new GovernanceStore({ quorumThreshold: 0.51 });
        const p = gov.submitProposal('peer-A', 'h1', 'New feature');
        const totalStaked = 1000;

        // 510/1000 = 51% → quorum
        gov.vote(p.id, 'voter-1', 'yes', 510);
        assert.ok(gov.hasQuorum(p.id, totalStaked));
    });

    it('should reject quorum when insufficient votes', () => {
        const gov = new GovernanceStore({ quorumThreshold: 0.51 });
        const p = gov.submitProposal('peer-A', 'h1', 'test');
        gov.vote(p.id, 'voter-1', 'yes', 500);
        assert.ok(!gov.hasQuorum(p.id, 1000));
    });

    it('should pass proposal when quorum reached', () => {
        const gov = new GovernanceStore({ quorumThreshold: 0.51 });
        const p = gov.submitProposal('peer-A', 'h1', 'test');
        gov.vote(p.id, 'voter-1', 'yes', 600);
        assert.ok(gov.tryPass(p.id, 1000));
        assert.equal(gov.getProposal(p.id).status, PROPOSAL_STATUS.PASSED);
    });

    it('should enforce timelock before execution', () => {
        const gov = new GovernanceStore({ quorumThreshold: 0.51, timelockMs: 100000 });
        const p = gov.submitProposal('peer-A', 'h1', 'test');
        gov.vote(p.id, 'voter-1', 'yes', 600);
        gov.tryPass(p.id, 1000);
        // Try execute immediately — should fail
        assert.ok(!gov.tryExecute(p.id));
    });

    it('should execute after timelock expires', async () => {
        const gov = new GovernanceStore({ quorumThreshold: 0.51, timelockMs: 10 });
        const p = gov.submitProposal('peer-A', 'h1', 'test');
        gov.vote(p.id, 'voter-1', 'yes', 600);
        gov.tryPass(p.id, 1000);
        await new Promise(r => setTimeout(r, 15));
        assert.ok(gov.tryExecute(p.id));
        assert.equal(gov.getProposal(p.id).status, PROPOSAL_STATUS.EXECUTED);
    });

    it('should expire stale proposals', () => {
        // TTL of 1ms
        const gov = new GovernanceStore();
        const p = gov.submitProposal('peer-A', 'h1', 'old', 1);
        // Force check (might need tiny delay)
        const wait = Date.now();
        while (Date.now() - wait < 5) { } // busy wait 5ms
        const rejected = gov.expireStale();
        assert.ok(rejected.includes(p.id));
        assert.equal(gov.getProposal(p.id).status, PROPOSAL_STATUS.REJECTED);
    });
});

// ── TestnetFaucet Tests ───────────────────────────────────────────────

describe('TestnetFaucet', () => {
    it('should grant wallet_connect reward (10 CDI)', () => {
        const faucet = new TestnetFaucet('testnet');
        const result = faucet.claimReward('0xABCD', 'wallet_connect');
        assert.ok(result.success);
        assert.equal(result.amount, 10);
        assert.equal(result.balance, 10);
    });

    it('should grant all 4 rewards up to 100 CDI', () => {
        const faucet = new TestnetFaucet('testnet');
        faucet.claimReward('0xABCD', 'wallet_connect');
        faucet.claimReward('0xABCD', 'shard_hosting');
        faucet.claimReward('0xABCD', 'first_inference');
        const result = faucet.claimReward('0xABCD', 'uptime_bonus');
        assert.ok(result.success);
        assert.equal(result.balance, MAX_PER_NODE); // 10 + 50 + 20 + 20 = 100
    });

    it('should prevent double claiming', () => {
        const faucet = new TestnetFaucet('testnet');
        faucet.claimReward('0xABCD', 'wallet_connect');
        const result = faucet.claimReward('0xABCD', 'wallet_connect');
        assert.ok(!result.success);
        assert.equal(result.reason, 'Already claimed: wallet_connect');
    });

    it('should reject unknown reward types', () => {
        const faucet = new TestnetFaucet('testnet');
        const result = faucet.claimReward('0xABCD', 'unknown');
        assert.ok(!result.success);
    });

    it('should not work on mainnet', () => {
        const faucet = new TestnetFaucet('mainnet');
        const result = faucet.claimReward('0xABCD', 'wallet_connect');
        assert.ok(!result.success);
        assert.equal(result.reason, 'Faucet only available on testnet');
    });

    it('should track total distributed and wallet count', () => {
        const faucet = new TestnetFaucet('testnet');
        faucet.claimReward('0xABCD', 'wallet_connect');
        faucet.claimReward('0x1234', 'wallet_connect');
        assert.equal(faucet.totalDistributed, 20);
        assert.equal(faucet.walletCount, 2);
    });

    it('should check hasClaimed correctly', () => {
        const faucet = new TestnetFaucet('testnet');
        assert.ok(!faucet.hasClaimed('0xABCD', 'wallet_connect'));
        faucet.claimReward('0xABCD', 'wallet_connect');
        assert.ok(faucet.hasClaimed('0xABCD', 'wallet_connect'));
        assert.ok(!faucet.hasClaimed('0xABCD', 'shard_hosting'));
    });
});
