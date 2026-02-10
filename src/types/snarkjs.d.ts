declare module 'snarkjs' {
    export interface Groth16Proof {
        pi_a: string[];
        pi_b: string[][];
        pi_c: string[];
        protocol: string;
        curve: string;
    }

    export namespace groth16 {
        function fullProve(
            input: Record<string, string>,
            wasmPath: string,
            zkeyPath: string,
        ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;

        function verify(
            vkey: any,
            publicSignals: string[],
            proof: Groth16Proof,
        ): Promise<boolean>;
    }
}
