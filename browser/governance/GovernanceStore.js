/**
 * GovernanceStore — On-chain governance for CDI Network upgrades.
 *
 * Proposal lifecycle: active → (passed|rejected) → executed
 *
 * Voting is stake-weighted: each node's vote weight = CDI balance.
 * Quorum: 51% of total staked CDI must vote YES.
 * Timelock: 48h window after quorum before execution.
 *
 * @module browser/governance/GovernanceStore
 */

import { Proposal, PROPOSAL_STATUS } from './Proposal.js';

export class GovernanceStore {
    /** @type {Map<string, Proposal>} */
    #proposals = new Map();
    /** @type {number} Quorum threshold (0-1) */
    #quorumThreshold;
    /** @type {number} Timelock duration in ms */
    #timelockMs;

    /**
     * @param {Object} opts
     * @param {number} [opts.quorumThreshold=0.51]
     * @param {number} [opts.timelockMs=172800000] - 48h default
     */
    constructor({ quorumThreshold = 0.51, timelockMs = 48 * 60 * 60 * 1000 } = {}) {
        this.#quorumThreshold = quorumThreshold;
        this.#timelockMs = timelockMs;
    }

    /**
     * Submit a new proposal.
     * @param {string} proposerId
     * @param {string} upgradeHash - SHA-256 of the new release
     * @param {string} changelog
     * @param {number} [ttlMs=604800000] - Proposal expires after 7 days
     * @returns {Proposal}
     */
    submitProposal(proposerId, upgradeHash, changelog, ttlMs = 7 * 24 * 60 * 60 * 1000) {
        const proposal = new Proposal(proposerId, upgradeHash, changelog, ttlMs);
        this.#proposals.set(proposal.id, proposal);
        return proposal;
    }

    /**
     * Cast a vote on a proposal.
     * @param {string} proposalId
     * @param {string} voterId - PeerId of voter
     * @param {'yes'|'no'} vote
     * @param {number} weight - CDI balance of voter
     */
    vote(proposalId, voterId, vote, weight) {
        const proposal = this.#getActive(proposalId);
        proposal.castVote(voterId, vote, weight);
    }

    /**
     * Check if a proposal has reached quorum.
     * @param {string} proposalId
     * @param {number} totalStaked - Total CDI staked in the network
     * @returns {boolean}
     */
    hasQuorum(proposalId, totalStaked) {
        const proposal = this.#proposals.get(proposalId);
        if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
        const { yes } = proposal.tally();
        return (yes / totalStaked) >= this.#quorumThreshold;
    }

    /**
     * Try to pass a proposal (requires quorum).
     * Sets status to 'passed' and starts timelock.
     * @param {string} proposalId
     * @param {number} totalStaked
     * @returns {boolean}
     */
    tryPass(proposalId, totalStaked) {
        if (!this.hasQuorum(proposalId, totalStaked)) return false;
        const proposal = this.#proposals.get(proposalId);
        if (proposal.status !== PROPOSAL_STATUS.ACTIVE) return false;
        proposal.pass();
        return true;
    }

    /**
     * Try to execute a passed proposal (requires timelock expired).
     * @param {string} proposalId
     * @returns {boolean}
     */
    tryExecute(proposalId) {
        const proposal = this.#proposals.get(proposalId);
        if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
        if (proposal.status !== PROPOSAL_STATUS.PASSED) return false;
        if (Date.now() - proposal.passedAt < this.#timelockMs) return false;
        proposal.execute();
        return true;
    }

    /**
     * Expire active proposals that have exceeded their TTL.
     * @returns {string[]} IDs of rejected proposals
     */
    expireStale() {
        const rejected = [];
        for (const [id, p] of this.#proposals) {
            if (p.status === PROPOSAL_STATUS.ACTIVE && Date.now() > p.expiresAt) {
                p.reject();
                rejected.push(id);
            }
        }
        return rejected;
    }

    /**
     * Get a proposal by ID.
     * @param {string} id
     * @returns {Proposal|undefined}
     */
    getProposal(id) {
        return this.#proposals.get(id);
    }

    /**
     * List all proposals (optionally filtered by status).
     * @param {string} [status]
     * @returns {Proposal[]}
     */
    listProposals(status) {
        const all = [...this.#proposals.values()];
        return status ? all.filter(p => p.status === status) : all;
    }

    /** @private */
    #getActive(proposalId) {
        const p = this.#proposals.get(proposalId);
        if (!p) throw new Error(`Unknown proposal: ${proposalId}`);
        if (p.status !== PROPOSAL_STATUS.ACTIVE) {
            throw new Error(`Proposal ${proposalId} is not active (status: ${p.status})`);
        }
        return p;
    }
}
