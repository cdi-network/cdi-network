/**
 * LibP2PNode — Browser-native libp2p node configuration for CDI Network.
 *
 * Transports: WebRTC (direct) + Circuit Relay v2 (NAT traversal)
 * PubSub: GossipSub for event propagation
 * Protocols: /cdi/activation/1.0.0 for tensor streaming
 *
 * @module browser/p2p/LibP2PNode
 */

/**
 * @typedef {Object} LibP2PConfig
 * @property {string[]} [bootstrapRelays] - Multiaddrs of bootstrap relay peers
 * @property {boolean} [enableRelay=true] - Act as relay for other peers
 * @property {number} [maxConnections=50]
 */

const CDI_PROTOCOL = '/cdi/activation/1.0.0';
const CDI_HEARTBEAT = '/cdi/heartbeat/1.0.0';

export class LibP2PNode {
    #node = null;
    #config;
    #started = false;
    /** @type {Map<string, any>} peerId → connection */
    #connections = new Map();
    /** @type {Function|null} */
    #onPeerConnect = null;
    /** @type {Function|null} */
    #onPeerDisconnect = null;

    /**
     * @param {LibP2PConfig} config
     */
    constructor(config = {}) {
        this.#config = {
            bootstrapRelays: config.bootstrapRelays || [],
            enableRelay: config.enableRelay !== false,
            maxConnections: config.maxConnections || 50,
        };
    }

    /**
     * Create and start the libp2p node.
     * In browser: uses @libp2p/webrtc + @libp2p/circuit-relay-v2
     *
     * NOTE: This is the configuration blueprint. Actual libp2p imports
     * are deferred to runtime to avoid Node.js bundling issues.
     *
     * @returns {Promise<void>}
     */
    async start() {
        if (this.#started) return;

        // Configuration for libp2p createNode (actual import at runtime)
        this.#node = {
            config: {
                transports: ['@libp2p/webrtc'],
                connectionEncrypters: ['@chainsafe/libp2p-noise'],
                streamMuxers: ['@libp2p/yamux'],
                services: {
                    pubsub: '@chainsafe/libp2p-gossipsub',
                    relay: this.#config.enableRelay ? '@libp2p/circuit-relay-v2' : null,
                },
                connectionManager: {
                    maxConnections: this.#config.maxConnections,
                },
                protocols: [CDI_PROTOCOL, CDI_HEARTBEAT],
            },
            peerId: null, // Generated on start
            multiaddrs: [],
            bootstrapRelays: this.#config.bootstrapRelays,
        };

        this.#started = true;
    }

    /**
     * Stop the libp2p node.
     */
    async stop() {
        if (!this.#started) return;
        this.#connections.clear();
        this.#node = null;
        this.#started = false;
    }

    /**
     * Connect to a peer by multiaddr.
     * @param {string} multiaddr
     * @returns {Promise<string>} Connected peer ID
     */
    async connectPeer(multiaddr) {
        if (!this.#started) throw new Error('Node not started');
        // Simulate connection (real impl uses this.#node.dial(multiaddr))
        const peerId = this.#extractPeerId(multiaddr);
        this.#connections.set(peerId, { multiaddr, connectedAt: Date.now() });
        if (this.#onPeerConnect) this.#onPeerConnect(peerId);
        return peerId;
    }

    /**
     * Disconnect from a peer.
     * @param {string} peerId
     */
    async disconnectPeer(peerId) {
        this.#connections.delete(peerId);
        if (this.#onPeerDisconnect) this.#onPeerDisconnect(peerId);
    }

    /**
     * Send data to a peer via protocol stream.
     * @param {string} peerId
     * @param {ArrayBuffer} data
     * @param {string} [protocol=CDI_PROTOCOL]
     */
    async sendToPeer(peerId, data, protocol = CDI_PROTOCOL) {
        if (!this.#connections.has(peerId)) {
            throw new Error(`Not connected to peer: ${peerId}`);
        }
        // Real impl: open stream, write data, close
        return { sent: true, peerId, bytes: data.byteLength, protocol };
    }

    /**
     * Publish message to a GossipSub topic.
     * @param {string} topic
     * @param {Object} data
     */
    async publish(topic, data) {
        if (!this.#started) throw new Error('Node not started');
        const encoded = new TextEncoder().encode(JSON.stringify(data));
        return { published: true, topic, bytes: encoded.byteLength };
    }

    /**
     * Subscribe to a GossipSub topic.
     * @param {string} topic
     * @param {Function} handler - (data) => void
     */
    subscribe(topic, handler) {
        // Real impl: this.#node.services.pubsub.subscribe(topic)
        // this.#node.services.pubsub.addEventListener('message', handler)
    }

    /** Register connect handler */
    onPeerConnect(handler) { this.#onPeerConnect = handler; }
    /** Register disconnect handler */
    onPeerDisconnect(handler) { this.#onPeerDisconnect = handler; }

    /** @returns {boolean} */
    get isStarted() { return this.#started; }
    /** @returns {number} */
    get connectionCount() { return this.#connections.size; }
    /** @returns {string[]} */
    get connectedPeers() { return [...this.#connections.keys()]; }
    /** @returns {Object|null} */
    get nodeConfig() { return this.#node?.config || null; }

    /** @private */
    #extractPeerId(multiaddr) {
        // /ip4/x.x.x.x/tcp/port/p2p/QmPeerId → QmPeerId
        const parts = multiaddr.split('/');
        const p2pIdx = parts.indexOf('p2p');
        return p2pIdx !== -1 ? parts[p2pIdx + 1] : `peer-${Date.now()}`;
    }
}
