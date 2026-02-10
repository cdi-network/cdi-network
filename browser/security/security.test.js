/**
 * Tests for P6: Security & Hardening.
 * Run: node --test browser/security/security.test.js
 */

import { RateLimiter } from './RateLimiter.js';
import { ReputationSystem } from './ReputationSystem.js';
import { SybilGuard } from './SybilGuard.js';
import { ProofAggregator } from './ProofAggregator.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── RateLimiter Tests ─────────────────────────────────────────────────

describe('RateLimiter', () => {
    it('should allow requests within limits', () => {
        const limiter = new RateLimiter();
        const r = limiter.consume('peer-1', 'inference');
        assert.ok(r.allowed);
        assert.ok(r.remaining >= 0);
    });

    it('should reject after bucket exhaustion', () => {
        const limiter = new RateLimiter({ inference: { maxTokens: 3, refillRate: 0.001 } });
        limiter.consume('p1', 'inference');
        limiter.consume('p1', 'inference');
        limiter.consume('p1', 'inference');
        const r = limiter.consume('p1', 'inference');
        assert.ok(!r.allowed);
        assert.ok(r.retryAfterMs > 0);
    });

    it('should track total rejections', () => {
        const limiter = new RateLimiter({ inference: { maxTokens: 1, refillRate: 0.001 } });
        limiter.consume('p1', 'inference');
        limiter.consume('p1', 'inference');
        assert.equal(limiter.totalRejected, 1);
    });

    it('should support multiple categories', () => {
        const limiter = new RateLimiter();
        const r1 = limiter.consume('p1', 'inference');
        const r2 = limiter.consume('p1', 'gossip');
        assert.ok(r1.allowed);
        assert.ok(r2.allowed);
    });

    it('should reset peer limits', () => {
        const limiter = new RateLimiter({ inference: { maxTokens: 1, refillRate: 0.001 } });
        limiter.consume('p1', 'inference');
        assert.ok(!limiter.canConsume('p1', 'inference'));
        limiter.reset('p1');
        assert.ok(limiter.canConsume('p1', 'inference'));
    });
});

// ── ReputationSystem Tests ────────────────────────────────────────────

describe('ReputationSystem', () => {
    it('should start with default score', () => {
        const rep = new ReputationSystem();
        assert.equal(rep.getScore('new-peer'), 50);
        assert.equal(rep.getTier('new-peer'), 'normal');
    });

    it('should increase score on positive events', () => {
        const rep = new ReputationSystem();
        rep.recordEvent('p1', 'inference_success');
        rep.recordEvent('p1', 'shard_hosted');
        assert.ok(rep.getScore('p1') > 50);
    });

    it('should decrease score on negative events', () => {
        const rep = new ReputationSystem();
        rep.recordEvent('p1', 'inference_fail');
        assert.ok(rep.getScore('p1') < 50);
    });

    it('should ban peers with very low scores', () => {
        const rep = new ReputationSystem();
        // Drop score to near 0
        for (let i = 0; i < 5; i++) rep.recordEvent('bad', 'protocol_violation');
        assert.equal(rep.getTier('bad'), 'banned');
        assert.ok(!rep.isAllowed('bad'));
    });

    it('should promote to trusted tier', () => {
        const rep = new ReputationSystem();
        for (let i = 0; i < 20; i++) rep.recordEvent('good', 'inference_success');
        assert.equal(rep.getTier('good'), 'trusted');
    });

    it('should rank leaderboard', () => {
        const rep = new ReputationSystem();
        rep.recordEvent('p1', 'inference_success');
        rep.recordEvent('p2', 'shard_hosted');
        rep.recordEvent('p2', 'shard_hosted');
        const board = rep.getLeaderboard(2);
        assert.equal(board[0].peerId, 'p2');
    });

    it('should decay scores', () => {
        const rep = new ReputationSystem();
        rep.getScore('p1'); // Initialize at 50
        const before = rep.getScore('p1');
        rep.decayAll(0.9);
        assert.ok(rep.getScore('p1') < before);
    });
});

// ── SybilGuard Tests ──────────────────────────────────────────────────

describe('SybilGuard', () => {
    it('should generate PoW challenge', () => {
        const guard = new SybilGuard();
        const challenge = guard.generateChallenge('peer-1');
        assert.ok(challenge.challenge.includes('peer-1'));
        assert.equal(challenge.difficulty, 4);
    });

    it('should verify valid PoW solution', () => {
        const guard = new SybilGuard();
        guard.generateChallenge('peer-1');
        // Simulate valid hash with 4 leading zeros
        const result = guard.verifyChallenge('peer-1', 'nonce123', '0000abcdef1234');
        assert.ok(result.verified);
        assert.ok(guard.isVerified('peer-1'));
    });

    it('should reject invalid PoW', () => {
        const guard = new SybilGuard();
        guard.generateChallenge('peer-1');
        const result = guard.verifyChallenge('peer-1', 'nonce', 'ffff1234');
        assert.ok(!result.verified);
        assert.equal(result.reason, 'Invalid proof-of-work');
    });

    it('should rate-limit joins per IP', () => {
        const guard = new SybilGuard();
        for (let i = 0; i < 5; i++) {
            assert.ok(guard.checkJoinRate('192.168.1.1').allowed);
        }
        assert.ok(!guard.checkJoinRate('192.168.1.1').allowed);
    });

    it('should check stake requirements', () => {
        const guard = new SybilGuard();
        assert.ok(guard.checkStake('p1', 50).adequate);
        assert.ok(!guard.checkStake('p1', 5).adequate);
    });

    it('should perform full admission check', () => {
        const guard = new SybilGuard();
        // Without PoW verification
        const r1 = guard.admissionCheck('p1', '10.0.0.1', 100);
        assert.ok(!r1.admitted);
        assert.ok(r1.reasons.some(r => r.includes('PoW')));

        // With PoW
        guard.generateChallenge('p2');
        guard.verifyChallenge('p2', 'n', '0000aabb');
        const r2 = guard.admissionCheck('p2', '10.0.0.2', 100);
        assert.ok(r2.admitted);
    });
});

// ── ProofAggregator Tests ─────────────────────────────────────────────

describe('ProofAggregator', () => {
    it('should collect stage commitments', () => {
        const agg = new ProofAggregator();
        agg.addCommitment('pipeline-1', {
            nodeId: 'n1', shardId: 's0',
            inputHash: 'aaa', outputHash: 'bbb',
        });
        assert.equal(agg.getCommitments('pipeline-1').length, 1);
    });

    it('should verify valid commitment chain', () => {
        const agg = new ProofAggregator();
        agg.addCommitment('p1', { nodeId: 'n1', shardId: 's0', inputHash: 'in0', outputHash: 'out0' });
        agg.addCommitment('p1', { nodeId: 'n2', shardId: 's1', inputHash: 'out0', outputHash: 'out1' });
        agg.addCommitment('p1', { nodeId: 'n3', shardId: 's2', inputHash: 'out1', outputHash: 'final' });

        const result = agg.verifyPipeline('p1');
        assert.ok(result.valid);
        assert.equal(result.stages, 3);
    });

    it('should detect broken commitment chain', () => {
        const agg = new ProofAggregator();
        agg.addCommitment('p1', { nodeId: 'n1', shardId: 's0', inputHash: 'in0', outputHash: 'out0' });
        agg.addCommitment('p1', { nodeId: 'n2', shardId: 's1', inputHash: 'WRONG', outputHash: 'out1' });

        const result = agg.verifyPipeline('p1');
        assert.ok(!result.valid);
        assert.ok(result.errors[0].includes('Chain break'));
    });

    it('should generate aggregate proof', () => {
        const agg = new ProofAggregator();
        agg.addCommitment('p1', { nodeId: 'n1', shardId: 's0', inputHash: 'in', outputHash: 'out' });
        const proof = agg.generateProof('p1');
        assert.ok(proof);
        assert.equal(proof.proofHash.length, 64); // SHA-256 hex
        assert.deepEqual(proof.nodeIds, ['n1']);
    });

    it('should track verification stats', () => {
        const agg = new ProofAggregator();
        agg.addCommitment('ok', { nodeId: 'n1', shardId: 's0', inputHash: 'a', outputHash: 'b' });
        agg.addCommitment('ok', { nodeId: 'n2', shardId: 's1', inputHash: 'b', outputHash: 'c' });
        agg.verifyPipeline('ok');

        agg.addCommitment('bad', { nodeId: 'n1', shardId: 's0', inputHash: 'a', outputHash: 'b' });
        agg.addCommitment('bad', { nodeId: 'n2', shardId: 's1', inputHash: 'X', outputHash: 'c' });
        agg.verifyPipeline('bad');

        assert.equal(agg.totalVerified, 1);
        assert.equal(agg.totalFailed, 1);
    });
});
