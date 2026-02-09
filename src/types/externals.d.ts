declare module '@orbitdb/core' {
    export function createOrbitDB(params: {
        ipfs: any;
        id?: string;
        identity?: any;
        identities?: any;
        directory?: string;
    }): Promise<{
        id: string;
        open: (address: string, params?: {
            type?: string;
            meta?: any;
            sync?: boolean;
            Database?: any;
            AccessController?: any;
            encryption?: any;
        }) => Promise<any>;
        stop: () => Promise<void>;
        ipfs: any;
        directory: string;
        peerId: any;
    }>;
}

declare module '@libp2p/identify' {
    export function identify(): any;
}
