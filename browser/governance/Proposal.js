/**
 * Proposal — Individual governance proposal for CDI Network upgrades.
 *
 * @module browser/governance/Proposal
 */

import { createHash, randomUUID } from 'node:crypto';

export const PROPOSAL_STATUS = {
    ACTIVE: 'active',
    PASSED: 'passed',
    REJECTED: 'rejected',
    EXECUTED: 'executed',
};

export class Proposal {
    /** @type {string} */
    id;
    /** @type {string} */
    proposerId;
    /** @type {string} */
    upgradeHash;
    /** @type {string} */
    changelog;
    /** @type {number} */
    createdAt;
    /** @type {number} */
    expiresAt;
    /** @type {string} */
    status;
    /** @type {number|null} */
    passedAt;
    /** @type {number|null} */
    executedAt;
    /** @type {Map<string, {vote: 'yes'|'no', weight: number}>} */
    #votes = new Map();

    /**
     * @param {string} proposerId
     * @param {string} upgradeHash
     * @param {string} changelog
     * @param {number} ttlMs
     */
    constructor(proposerId, upgradeHash, changelog, ttlMs) {
        this.id = this.#generateId(proposerId, upgradeHash);
        this.proposerId = proposerId;
        this.upgradeHash = upgradeHash;
        this.changelog = changelog;
        this.createdAt = Date.now();
        this.expiresAt = this.createdAt + ttlMs;
        this.status = PROPOSAL_STATUS.ACTIVE;
        this.passedAt = null;
        this.executedAt = null;
    }

    /**
     * Cast a vote.
     * @param {string} voterId
     * @param {'yes'|'no'} vote
     * @param {number} weight
     */
    castVote(voterId, vote, weight) {
        if (this.status !== PROPOSAL_STATUS.ACTIVE) {
            throw new Error(`Cannot vote on ${this.status} proposal`);
        }
        if (vote !== 'yes' && vote !== 'no') {
            throw new Error('Vote must be "yes" or "no"');
        }
        if (weight <= 0) {
            throw new Error('Vote weight must be positive');
        }
        this.#votes.set(voterId, { vote, weight });
    }

    /**
     * Get vote tally.
     * @returns {{ yes: number, no: number, total: number, voters: number }}
     */
    tally() {
        let yes = 0, no = 0;
        for (const { vote, weight } of this.#votes.values()) {
            if (vote === 'yes') yes += weight;
            else no += weight;
        }
        return { yes, no, total: yes + no, voters: this.#votes.size };
    }

    /** Mark as passed. */
    pass() {
        this.status = PROPOSAL_STATUS.PASSED;
        this.passedAt = Date.now();
    }

    /** Mark as rejected. */
    reject() {
        this.status = PROPOSAL_STATUS.REJECTED;
    }

    /** Mark as executed. */
    execute() {
        this.status = PROPOSAL_STATUS.EXECUTED;
        this.executedAt = Date.now();
    }

    /** @private */
    #generateId(proposerId, upgradeHash) {
        const hash = createHash('sha256')
            .update(`${proposerId}:${upgradeHash}:${Date.now()}`)
            .digest('hex');
        return hash.slice(0, 16);
    }
}
