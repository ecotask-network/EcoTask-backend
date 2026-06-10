declare module "web3.storage" {
  export class Web3Storage {
    constructor(options: { token: string });
    put(files: File[], options?: { wrapWithDirectory?: boolean }): Promise<string>;
  }
}
