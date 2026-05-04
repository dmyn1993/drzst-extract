declare module '7z-wasm' {
    interface SevenZipModule {
        FS: any;
        NODEFS: any;
        callMain(args: string[]): void;
    }
    function SevenZipFactory(): Promise<SevenZipModule>;
    export default SevenZipFactory;
}